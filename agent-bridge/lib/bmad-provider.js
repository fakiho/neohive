'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const YAML = require('yaml');
const { mutateProjectConfig, readProjectConfig } = require('./project-config');
const { findExecutable } = require('./tmux-cli-launcher');

const ID = 'bmad';
const LABEL = 'BMad Method';
const PACKAGE_SPEC = 'bmad-method@^6';
const SUPPORTED_MAJOR = 6;
const MAX_ARTIFACTS = 1000;
const MAX_HASH_BYTES = 2 * 1024 * 1024;
const MAX_HASH_TOTAL_BYTES = 16 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MODES = new Set(['quick', 'full']);
const TOOL_IDS = Object.freeze({
  claude: 'claude-code',
  gemini: 'gemini',
  codex: 'codex',
  cursor: 'cursor',
  'ollama-claude': 'claude-code',
});
const WORKFLOWS = Object.freeze([
  { id: 'auto', label: 'Let bmad-help choose', mode: 'full', phase: null },
  { id: 'bmad-brainstorming', label: 'Brainstorming', mode: 'full', phase: 'analysis' },
  { id: 'bmad-product-brief', label: 'Product brief', mode: 'full', phase: 'analysis' },
  { id: 'bmad-prd', label: 'PRD', mode: 'full', phase: 'planning' },
  { id: 'bmad-ux', label: 'UX design', mode: 'full', phase: 'planning' },
  { id: 'bmad-architecture', label: 'Architecture', mode: 'full', phase: 'solutioning' },
  { id: 'bmad-create-epics-and-stories', label: 'Epics and stories', mode: 'full', phase: 'solutioning' },
  { id: 'bmad-check-implementation-readiness', label: 'Implementation readiness', mode: 'full', phase: 'solutioning' },
  { id: 'bmad-sprint-planning', label: 'Sprint planning', mode: 'full', phase: 'implementation' },
  { id: 'bmad-create-story', label: 'Create story', mode: 'full', phase: 'implementation' },
  { id: 'bmad-dev-story', label: 'Develop story', mode: 'full', phase: 'implementation' },
  { id: 'bmad-code-review', label: 'Code review', mode: 'full', phase: 'implementation' },
  { id: 'bmad-quick-dev', label: 'Quick development', mode: 'quick', phase: 'quick' },
  { id: 'bmad-dev-auto', label: 'Autonomous development iteration', mode: 'quick', phase: 'quick' },
]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function safeProjectDir(projectDir) {
  const resolved = path.resolve(String(projectDir || ''));
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new Error('Project directory does not exist'); }
  if (!stat.isDirectory()) throw new Error('Project path must be a directory');
  return resolved;
}

function manifestPath(projectDir) {
  return path.join(projectDir, '_bmad', '_config', 'manifest.yaml');
}

function outputDir(projectDir) {
  return path.join(projectDir, '_bmad-output');
}

function projectRootFromDataDir(dataDir, fallback) {
  const resolved = path.resolve(String(dataDir || ''));
  if (['.neohive', 'data'].includes(path.basename(resolved))) return path.dirname(resolved);
  if (['_bmad', '_bmad-output', 'package.json', '.git'].some((name) => fs.existsSync(path.join(resolved, name)))) {
    return resolved;
  }
  return path.resolve(fallback || process.cwd());
}

function readYaml(file, fallback) {
  try {
    const value = YAML.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function normalizeVersion(value) {
  const match = String(value || '').trim().match(/(?:^|[^0-9])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    raw: String(value),
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

function installedVersion(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  const bmm = modules.find((item) => item && String(item.name || item.code).toLowerCase() === 'bmm');
  const candidates = [
    bmm && bmm.version,
    manifest.installation && manifest.installation.version,
    manifest.version,
    manifest.installer_version,
    manifest.bmad_version,
  ];
  for (const candidate of candidates) {
    const parsed = normalizeVersion(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function hasBmmModule(manifest) {
  return !!(manifest && Array.isArray(manifest.modules) && manifest.modules.some((item) => {
    const name = typeof item === 'string' ? item : item && (item.name || item.code);
    return String(name || '').toLowerCase() === 'bmm';
  }));
}

function installedRuntimes(manifest) {
  const ides = manifest && Array.isArray(manifest.ides) ? manifest.ides : [];
  const reverse = {
    'claude-code': 'claude',
    claude: 'claude',
    cursor: 'cursor',
    gemini: 'gemini',
    codex: 'codex',
  };
  return Array.from(new Set(ides.map((ide) => reverse[String(ide).toLowerCase()]).filter(Boolean)));
}

function executableVersion(command, args) {
  const executable = findExecutable(command);
  if (!executable) return { installed: false, version: null };
  try {
    const value = execFileSync(executable, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { installed: true, version: value.split(/\r?\n/)[0] || null, path: executable };
  } catch {
    return { installed: true, version: null, path: executable };
  }
}

function preflight() {
  const node = normalizeVersion(process.versions.node);
  const python = executableVersion('python3', ['--version']);
  const uv = executableVersion('uv', ['--version']);
  const git = executableVersion('git', ['--version']);
  const npx = executableVersion(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--version']);
  const pythonVersion = normalizeVersion(python.version);
  const checks = {
    node: {
      ok: !!node && (node.major > 20 || (node.major === 20 && node.minor >= 12)),
      version: process.versions.node,
      required: '>=20.12.0',
    },
    python: {
      ok: python.installed && !!pythonVersion && (pythonVersion.major > 3 || (pythonVersion.major === 3 && pythonVersion.minor >= 10)),
      version: python.version,
      required: '>=3.10.0',
    },
    uv: { ok: uv.installed, version: uv.version, required: 'installed' },
    git: { ok: git.installed, version: git.version, required: 'installed' },
    npx: { ok: npx.installed, version: npx.version, required: 'installed' },
  };
  return { ok: Object.values(checks).every((check) => check.ok), checks };
}

function getProjectSettings(dataDir) {
  const config = readProjectConfig(dataDir);
  const methodologies = config.methodologies && typeof config.methodologies === 'object'
    ? config.methodologies
    : {};
  const settings = methodologies.bmad && typeof methodologies.bmad === 'object'
    ? methodologies.bmad
    : {};
  let normalized = { mode: 'quick', workflow: 'bmad-quick-dev' };
  try { normalized = normalizeModeWorkflow(settings.mode || 'quick', settings.workflow); } catch {}
  return {
    enabled: settings.enabled === true,
    mode: normalized.mode,
    workflow: normalized.workflow,
    installed_tools: Array.isArray(settings.installed_tools) ? settings.installed_tools.filter((item) => TOOL_IDS[item]) : [],
    last_installed_version: typeof settings.last_installed_version === 'string' ? settings.last_installed_version : null,
    updated_at: settings.updated_at || null,
  };
}

function saveProjectSettings(dataDir, patch) {
  let saved;
  mutateProjectConfig(dataDir, (config) => {
    if (!config.methodologies || typeof config.methodologies !== 'object') config.methodologies = {};
    const current = config.methodologies.bmad && typeof config.methodologies.bmad === 'object'
      ? config.methodologies.bmad
      : {};
    const cleanPatch = Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value !== undefined));
    const next = Object.assign({}, current, cleanPatch, { updated_at: new Date().toISOString() });
    const normalized = normalizeModeWorkflow(next.mode || 'quick', next.workflow);
    next.mode = normalized.mode;
    next.workflow = normalized.workflow;
    config.methodologies.bmad = next;
    saved = {
      enabled: next.enabled === true,
      mode: next.mode,
      workflow: next.workflow,
      installed_tools: Array.isArray(next.installed_tools) ? next.installed_tools.filter((item) => TOOL_IDS[item]) : [],
      last_installed_version: typeof next.last_installed_version === 'string' ? next.last_installed_version : null,
      updated_at: next.updated_at,
    };
    return config;
  });
  return saved;
}

function validateMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (!MODES.has(value)) throw new Error('BMad mode must be "quick" or "full"');
  return value;
}

function validateWorkflow(workflow) {
  const value = String(workflow || 'auto').trim();
  if (!WORKFLOWS.some((item) => item.id === value)) throw new Error('Unsupported BMad workflow');
  return value;
}

function normalizeModeWorkflow(mode, workflow) {
  const safeMode = validateMode(mode || 'quick');
  let safeWorkflow = validateWorkflow(workflow || (safeMode === 'full' ? 'auto' : 'bmad-quick-dev'));
  const selected = WORKFLOWS.find((item) => item.id === safeWorkflow);
  if (safeMode === 'quick' && selected && selected.mode !== 'quick') safeWorkflow = 'bmad-quick-dev';
  if (safeMode === 'full' && selected && selected.mode === 'quick') safeWorkflow = 'auto';
  return { mode: safeMode, workflow: safeWorkflow };
}

function validateTools(tools) {
  const values = Array.isArray(tools) ? tools : [tools];
  const clean = Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)));
  if (!clean.length) throw new Error('Select at least one supported agent runtime');
  for (const runtime of clean) {
    if (!TOOL_IDS[runtime]) throw new Error(`BMad installation is not supported for runtime "${runtime}"`);
  }
  return clean;
}

function toolIdsForRuntimes(runtimes) {
  return Array.from(new Set(validateTools(runtimes).map((runtime) => TOOL_IDS[runtime])));
}

function buildInstallerArgs({ projectDir, action, runtimes }) {
  const project = safeProjectDir(projectDir);
  const installAction = action === 'update' ? 'quick-update' : 'install';
  const args = ['--yes', PACKAGE_SPEC, 'install', '--yes', '--directory', project, '--action', installAction];
  if (installAction === 'install') {
    args.push('--modules', 'bmm', '--tools', toolIdsForRuntimes(runtimes).join(','));
  }
  return args;
}

function acquireInstallerLock(dataDir) {
  const lockFile = path.join(dataDir, 'bmad-install.lock');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    fs.closeSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 20 * 60 * 1000) {
          fs.unlinkSync(lockFile);
          return acquireInstallerLock(dataDir);
        }
      } catch {}
      throw new Error('A BMad install or update is already running for this project');
    }
    throw error;
  }
  return () => { try { fs.unlinkSync(lockFile); } catch {} };
}

function runInstaller({ projectDir, dataDir, action, runtimes, execFileImpl, preflightResult, npxPath }) {
  if (!['install', 'update'].includes(action)) throw new Error('BMad installer action must be "install" or "update"');
  const check = preflightResult || preflight();
  if (!check.ok) {
    const failed = Object.entries(check.checks).filter(([, item]) => !item.ok).map(([name]) => name);
    throw new Error(`BMad prerequisites are missing or unsupported: ${failed.join(', ')}`);
  }
  const npx = npxPath || findExecutable(process.platform === 'win32' ? 'npx.cmd' : 'npx');
  if (!npx) throw new Error('npx is not available on PATH');
  const args = buildInstallerArgs({ projectDir, action, runtimes });
  const releaseLock = acquireInstallerLock(dataDir);
  const previousTools = getProjectSettings(dataDir).installed_tools;
  return new Promise((resolve, reject) => {
    try {
      (execFileImpl || execFile)(npx, args, {
        cwd: safeProjectDir(projectDir),
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          releaseLock();
          const detail = String(stderr || stdout || error.message).trim().slice(-4000);
          reject(new Error(`BMad installer failed: ${detail}`));
          return;
        }
        try {
          const status = inspectProject(projectDir, dataDir);
          if (!status.installed || !status.compatible) {
            throw new Error('BMad installer completed but a compatible BMM v6 manifest was not found');
          }
          const actualTools = status.manifest_ides && status.manifest_ides.length
            ? status.manifest_ides
            : (action === 'update' ? previousTools : validateTools(runtimes));
          saveProjectSettings(dataDir, {
            enabled: true,
            installed_tools: actualTools,
            last_installed_version: status.version,
          });
          const finalStatus = inspectProject(projectDir, dataDir);
          releaseLock();
          resolve({ success: true, action: action === 'update' ? 'quick-update' : 'install', status: finalStatus, output: String(stdout || '').trim().slice(-4000) });
        } catch (inspectionError) {
          releaseLock();
          reject(inspectionError);
        }
      });
    } catch (error) {
      releaseLock();
      reject(error);
    }
  });
}

function walkFiles(root, current, output, depth) {
  if (output.length >= MAX_ARTIFACTS || depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (output.length >= MAX_ARTIFACTS) break;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, absolute, output, depth + 1);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(absolute);
        output.push({ absolute, relative: path.relative(root, absolute).replace(/\\/g, '/'), stat });
      } catch {}
    }
  }
}

function artifactKind(relative) {
  const value = relative.toLowerCase();
  if (/prd/.test(value)) return 'prd';
  if (/architecture/.test(value)) return 'architecture';
  if (/ux|design/.test(value)) return 'ux';
  if (/readiness|validation/.test(value)) return 'gate';
  if (/sprint-status/.test(value)) return 'sprint-status';
  if (/stor(y|ies)|epic/.test(value)) return 'story';
  if (/brief/.test(value)) return 'brief';
  if (/research/.test(value)) return 'research';
  return 'artifact';
}

function hashFile(file, size) {
  if (size > MAX_HASH_BYTES) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}

function listArtifacts(projectDir, options) {
  const root = outputDir(safeProjectDir(projectDir));
  if (!fs.existsSync(root)) return [];
  try { if (fs.lstatSync(root).isSymbolicLink()) return []; } catch { return []; }
  const files = [];
  walkFiles(root, root, files, 0);
  const artifacts = files.map(({ absolute, relative, stat }) => ({
    id: `bmad:artifact:${crypto.createHash('sha1').update(relative).digest('hex').slice(0, 16)}`,
    source: 'bmad',
    authority: 'bmad',
    path: path.join('_bmad-output', relative).replace(/\\/g, '/'),
    relative_path: relative,
    kind: artifactKind(relative),
    size: stat.size,
    modified_at: stat.mtime.toISOString(),
    hash: null,
    _absolute: absolute,
  })).sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  if (options && options.hash === true) {
    const limit = Math.min(Math.max(Number(options.hashLimit) || 50, 1), 200);
    const kind = options.hashKind ? String(options.hashKind) : null;
    let hashed = 0;
    let totalBytes = 0;
    for (const artifact of artifacts) {
      if (kind && artifact.kind !== kind) continue;
      if (hashed >= limit || artifact.size > MAX_HASH_BYTES || totalBytes + artifact.size > MAX_HASH_TOTAL_BYTES) continue;
      artifact.hash = hashFile(artifact._absolute, artifact.size);
      if (artifact.hash) {
        hashed++;
        totalBytes += artifact.size;
      }
    }
  }
  return artifacts.map((artifact) => {
    delete artifact._absolute;
    return artifact;
  });
}

function findSprintStatus(projectDir, artifacts) {
  const match = artifacts.find((item) => /(^|\/)sprint-status\.ya?ml$/i.test(item.relative_path));
  return match ? readYaml(path.join(projectDir, match.path), null) : null;
}

function storyEntries(sprint) {
  if (!sprint || typeof sprint !== 'object') return [];
  const statusMap = sprint.development_status || sprint.story_status || sprint.stories;
  if (!statusMap || typeof statusMap !== 'object' || Array.isArray(statusMap)) return [];
  return Object.entries(statusMap)
    .filter(([, value]) => typeof value === 'string' || (value && typeof value === 'object'))
    .map(([key, value]) => {
      const status = typeof value === 'string' ? value : value.status || 'unknown';
      return {
        id: `bmad:story:${key}`,
        external_id: key,
        source: 'bmad',
        authority: 'bmad',
        title: typeof value === 'object' && value.title ? value.title : key.replace(/[-_]/g, ' '),
        status: String(status),
        file: typeof value === 'object' && value.file ? value.file : null,
      };
    });
}

function phaseState(artifacts, stories) {
  const has = (kind) => artifacts.some((item) => item.kind === kind);
  const phases = [
    { id: 'analysis', label: 'Analysis', optional: true, status: has('brief') || has('research') ? 'completed' : 'available' },
    { id: 'planning', label: 'Planning', optional: false, status: has('prd') ? 'completed' : 'available' },
    { id: 'solutioning', label: 'Solutioning', optional: false, status: has('architecture') ? 'completed' : (has('prd') ? 'available' : 'blocked') },
    { id: 'implementation', label: 'Implementation', optional: false, status: stories.length ? 'in_progress' : (has('architecture') ? 'available' : 'blocked') },
  ];
  if (stories.length && stories.every((story) => /done|complete/i.test(story.status))) phases[3].status = 'completed';
  return phases;
}

function computeNextAction({ installed, compatible, artifacts, stories, settings }) {
  if (!installed) return { workflow: null, reason: 'Install BMad Method for this project.' };
  if (!compatible) return { workflow: null, reason: 'Update the installed BMad major version or the Neohive integration.' };
  if (settings.workflow && settings.workflow !== 'auto') {
    return { workflow: settings.workflow, reason: 'Project default selected in Neohive.' };
  }
  if (settings.mode === 'quick') return { workflow: 'bmad-quick-dev', reason: 'Project is configured for Quick mode.' };
  const has = (kind) => artifacts.some((item) => item.kind === kind);
  if (!has('prd')) return { workflow: 'bmad-prd', reason: 'No PRD artifact was found.' };
  if (!has('architecture')) return { workflow: 'bmad-architecture', reason: 'No architecture artifact was found.' };
  if (!stories.length) return { workflow: 'bmad-sprint-planning', reason: 'No sprint story state was found.' };
  const review = stories.find((story) => /review/i.test(story.status));
  if (review) return { workflow: 'bmad-code-review', story_id: review.external_id, reason: 'A story is ready for review.' };
  const active = stories.find((story) => /ready|progress/i.test(story.status));
  if (active) return { workflow: 'bmad-dev-story', story_id: active.external_id, reason: 'A story is ready for development.' };
  return { workflow: 'bmad-create-story', reason: 'Prepare the next implementation story.' };
}

function inspectProject(projectDir, dataDir, options) {
  const project = safeProjectDir(projectDir);
  const manifestFile = manifestPath(project);
  let installed = false;
  try { installed = fs.existsSync(manifestFile) && !fs.lstatSync(manifestFile).isSymbolicLink(); } catch {}
  const manifest = installed ? readYaml(manifestFile, {}) : null;
  const parsedVersion = installedVersion(manifest);
  const artifacts = listArtifacts(project, {
    hash: !!(options && options.hashArtifacts === true),
    hashLimit: options && options.artifactHashLimit,
    hashKind: options && options.artifactHashKind,
  });
  const sprint = findSprintStatus(project, artifacts);
  const stories = storyEntries(sprint);
  const executionTasks = dataDir ? readJson(path.join(dataDir, 'tasks.json'), []) : [];
  const tasksByExternalRef = new Map();
  if (Array.isArray(executionTasks)) {
    for (const task of executionTasks) {
      if (!task || !task.external_ref) continue;
      const current = tasksByExternalRef.get(task.external_ref);
      const active = !['done', 'blocked_permanent'].includes(task.status);
      const currentActive = current && !['done', 'blocked_permanent'].includes(current.status);
      if (!current || (active && !currentActive) ||
          (active === currentActive && String(task.updated_at || '').localeCompare(String(current.updated_at || '')) > 0)) {
        tasksByExternalRef.set(task.external_ref, task);
      }
    }
  }
  if (Array.isArray(executionTasks)) {
    for (const story of stories) {
      const linked = tasksByExternalRef.get(story.id);
      if (linked) {
        story.assignment = {
          task_id: linked.id,
          assignee: linked.assignee || null,
          execution_status: linked.status,
        };
      }
    }
  }
  const settings = dataDir ? getProjectSettings(dataDir) : { enabled: false, mode: 'quick', workflow: 'auto', installed_tools: [] };
  const bmmInstalled = installed && hasBmmModule(manifest);
  const compatible = bmmInstalled && !!parsedVersion && parsedVersion.major === SUPPORTED_MAJOR;
  const phases = phaseState(artifacts, stories);
  const currentPhase = settings.mode === 'quick'
    ? 'quick'
    : stories.length || artifacts.some((item) => item.kind === 'architecture')
      ? 'implementation'
      : artifacts.some((item) => item.kind === 'prd')
        ? 'solutioning'
        : artifacts.some((item) => ['brief', 'research'].includes(item.kind))
          ? 'planning'
          : 'analysis';
  const workflows = WORKFLOWS.filter((workflow) => workflow.id !== 'auto').map((workflow) => {
    const phase = phases.find((item) => item.id === workflow.phase);
    const available = workflow.mode === 'quick'
      ? settings.mode === 'quick'
      : settings.mode === 'full' && (!phase || phase.status !== 'blocked');
    return Object.assign({}, workflow, { status: available ? 'available' : 'blocked' });
  });
  const gates = artifacts.filter((item) => item.kind === 'gate').map((item) => ({
    id: `bmad:gate:${item.id.split(':').pop()}`,
    source: 'bmad',
    authority: 'bmad',
    label: path.basename(item.path),
    status: /fail/i.test(item.path) ? 'failed' : 'recorded',
    artifact_id: item.id,
  }));
  const status = {
    id: ID,
    label: LABEL,
    installed,
    bmm_installed: bmmInstalled,
    enabled: settings.enabled,
    compatible,
    version: parsedVersion ? parsedVersion.raw : null,
    manifest_ides: installedRuntimes(manifest),
    supported_major: SUPPORTED_MAJOR,
    manifest_path: installed ? path.relative(project, manifestFile).replace(/\\/g, '/') : null,
    output_path: path.relative(project, outputDir(project)).replace(/\\/g, '/'),
    settings,
    preflight: options && options.preflight === false ? null : preflight(),
    phases,
    current_phase: currentPhase,
    workflows,
    stories,
    gates,
    artifacts,
    artifact_count: artifacts.length,
  };
  status.next_action = computeNextAction(status);
  status.fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    version: status.version,
    settings,
    artifacts: artifacts.map((item) => [item.path, item.modified_at, item.size]),
    stories,
  })).digest('hex');
  return status;
}

const EXPECTED_TOOLS_IN_INSTALLED_MCP = Object.freeze([
  'methodology_status',
  'methodology_next_action',
  'methodology_artifacts',
  'methodology_diagnostics',
]);

function runtimeDiagnostics(dataDir) {
  const serverFile = require.main ? require.main.filename : null;
  let installedMcpDir = null;
  let installedMcpVersion = null;
  let installedMcpHasBmad = false;
  if (serverFile) {
    try {
      const installedPkg = path.join(path.dirname(serverFile), 'package.json');
      if (fs.existsSync(installedPkg)) {
        const p = JSON.parse(fs.readFileSync(installedPkg, 'utf8'));
        installedMcpDir = path.dirname(serverFile);
        installedMcpVersion = p.version || null;
        const toolsDir = path.join(path.dirname(serverFile), 'tools');
        installedMcpHasBmad = fs.existsSync(path.join(toolsDir, 'methodologies.js'));
      }
    } catch {}
  }
  const workingTreeDir = path.resolve(__dirname, '..');
  const workingTreeVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(workingTreeDir, 'package.json'), 'utf8')).version || null; }
    catch { return null; }
  })();
  const runningFromWorkingTree = serverFile ? path.dirname(serverFile) === workingTreeDir : false;
  const missingBmadTools = installedMcpDir && !installedMcpHasBmad ? EXPECTED_TOOLS_IN_INSTALLED_MCP : [];
  return {
    server_file: serverFile,
    running_from_working_tree: runningFromWorkingTree,
    working_tree_dir: workingTreeDir,
    working_tree_version: workingTreeVersion,
    installed_mcp_dir: installedMcpDir,
    installed_mcp_version: installedMcpVersion,
    installed_mcp_has_bmad: installedMcpHasBmad,
    missing_bmad_tools_in_installed_mcp: missingBmadTools,
    data_dir: dataDir ? path.resolve(dataDir) : null,
    project_root: dataDir ? path.resolve(projectRootFromDataDir(dataDir, process.cwd())) : null,
    stale_runtime: installedMcpDir && !runningFromWorkingTree && installedMcpVersion !== workingTreeVersion,
    node_version: process.versions.node,
    pid: process.pid,
  };
}

function composeInstructions({ mode, workflow }) {
  const safeMode = validateMode(mode || 'quick');
  let safeWorkflow = validateWorkflow(workflow || (safeMode === 'quick' ? 'bmad-quick-dev' : 'auto'));
  if (safeMode === 'quick' && !['auto', 'bmad-quick-dev', 'bmad-dev-auto'].includes(safeWorkflow)) {
    safeWorkflow = 'bmad-quick-dev';
  }
  const selected = WORKFLOWS.find((item) => item.id === safeWorkflow);
  const invocation = safeWorkflow === 'auto' ? 'bmad-help' : safeWorkflow;
  return [
    '',
    'BMad Method integration:',
    `- This project uses BMad Method v${SUPPORTED_MAJOR} in ${safeMode.toUpperCase()} mode.`,
    '- First call methodology_status(). Read its next_action and relevant artifact references.',
    `- Load and follow the installed \`${invocation}\` skill before doing methodology work.`,
    '- Treat files under _bmad/ and _bmad-output/ as the authoritative methodology state.',
    '- Neohive remains authoritative for agent coordination, task assignment, file locks, messaging, and listen().',
    '- Do not run BMad Party Mode or spawn BMad subagents; coordinate additional agents through Neohive.',
    selected && selected.phase ? `- Current methodology phase: ${selected.phase}.` : null,
  ].filter(Boolean).join('\n');
}

module.exports = {
  ID,
  LABEL,
  PACKAGE_SPEC,
  SUPPORTED_MAJOR,
  TOOL_IDS,
  WORKFLOWS,
  buildInstallerArgs,
  composeInstructions,
  getProjectSettings,
  inspectProject,
  listArtifacts,
  normalizeModeWorkflow,
  preflight,
  projectRootFromDataDir,
  runtimeDiagnostics,
  runInstaller,
  saveProjectSettings,
  validateMode,
  validateTools,
  validateWorkflow,
};
