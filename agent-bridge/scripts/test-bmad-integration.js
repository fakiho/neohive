'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bmad = require('../lib/bmad-provider');
const methodologies = require('../lib/methodology-provider');

function mkdir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function write(file, content) {
  mkdir(file);
  fs.writeFileSync(file, content);
}

function makeProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-bmad-'));
  const dataDir = path.join(projectDir, '.neohive');
  fs.mkdirSync(dataDir, { recursive: true });
  return { projectDir, dataDir };
}

function readyPreflight() {
  return {
    ok: true,
    checks: {
      node: { ok: true },
      python: { ok: true },
      uv: { ok: true },
      git: { ok: true },
      npx: { ok: true },
    },
  };
}

function fakeInstaller(projectDir, failure, delay = 0) {
  return function (_file, args, _options, callback) {
    setTimeout(() => {
      if (failure) {
        callback(new Error('fake failure'), '', 'fake failure');
        return;
      }
      write(path.join(projectDir, '_bmad', '_config', 'manifest.yaml'), [
        'version: v6.10.0',
        'modules:',
        '  - name: bmm',
        '    version: v6.10.0',
        'ides:',
        '  - claude-code',
        '  - cursor',
        '',
      ].join('\n'));
      callback(null, 'installed', '');
    }, delay);
  };
}

async function run() {
  const { projectDir, dataDir } = makeProject();
  try {
    assert.strictEqual(bmad.projectRootFromDataDir(dataDir), projectDir);
    write(path.join(projectDir, 'package.json'), '{}\n');
    assert.strictEqual(bmad.projectRootFromDataDir(projectDir), projectDir);
    let status = bmad.inspectProject(projectDir, dataDir, { preflight: false });
    assert.strictEqual(status.installed, false);
    assert.strictEqual(status.compatible, false);
    write(path.join(projectDir, '_bmad', '_config', 'manifest.yaml'), 'version: 6.10.0\nmodules:\n  - name: core\n');
    status = bmad.inspectProject(projectDir, dataDir, { preflight: false });
    assert.strictEqual(status.installed, true);
    assert.strictEqual(status.bmm_installed, false);
    assert.strictEqual(status.compatible, false);
    write(path.join(projectDir, '_bmad', '_config', 'manifest.yaml'), 'modules:\n  - name: bmm\n');
    status = bmad.inspectProject(projectDir, dataDir, { preflight: false });
    assert.strictEqual(status.bmm_installed, true);
    assert.strictEqual(status.compatible, false);

    const installArgs = bmad.buildInstallerArgs({
      projectDir,
      action: 'install',
      runtimes: ['claude', 'cursor'],
    });
    assert.deepStrictEqual(installArgs.slice(0, 3), ['--yes', 'bmad-method@^6', 'install']);
    assert.ok(installArgs.includes('--modules'));
    assert.ok(installArgs.includes('claude-code,cursor'));
    assert.strictEqual(installArgs.includes('; rm -rf /'), false);

    await assert.rejects(() => bmad.runInstaller({
      projectDir,
      dataDir,
      action: 'install',
      runtimes: ['claude'],
      execFileImpl: fakeInstaller(projectDir, true),
      preflightResult: readyPreflight(),
      npxPath: '/fake/npx',
    }), /fake failure/);
    assert.strictEqual(bmad.getProjectSettings(dataDir).enabled, false);

    const result = await bmad.runInstaller({
      projectDir,
      dataDir,
      action: 'install',
      runtimes: ['claude', 'cursor'],
      execFileImpl: fakeInstaller(projectDir, false),
      preflightResult: readyPreflight(),
      npxPath: '/fake/npx',
    });
    assert.strictEqual(result.status.installed, true);
    assert.strictEqual(result.status.enabled, true);
    assert.strictEqual(bmad.getProjectSettings(dataDir).enabled, true);
    const normalized = bmad.saveProjectSettings(dataDir, { mode: 'quick', workflow: 'bmad-prd' });
    assert.strictEqual(normalized.workflow, 'bmad-quick-dev');
    const slowUpdate = bmad.runInstaller({
      projectDir,
      dataDir,
      action: 'update',
      runtimes: ['claude'],
      execFileImpl: fakeInstaller(projectDir, false, 50),
      preflightResult: readyPreflight(),
      npxPath: '/fake/npx',
    });
    assert.throws(() => bmad.runInstaller({
      projectDir,
      dataDir,
      action: 'update',
      runtimes: ['claude'],
      execFileImpl: fakeInstaller(projectDir, false),
      preflightResult: readyPreflight(),
      npxPath: '/fake/npx',
    }), /already running/);
    await slowUpdate;

    write(path.join(projectDir, '_bmad-output', 'planning-artifacts', 'prd.md'), '# PRD\n');
    write(path.join(projectDir, '_bmad-output', 'planning-artifacts', 'ARCHITECTURE-SPINE.md'), '# Architecture\n');
    write(path.join(projectDir, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'), [
      'development_status:',
      '  story-one: ready-for-dev',
      '  story-two:',
      '    title: Review this story',
      '    status: review',
      '',
    ].join('\n'));
    write(path.join(projectDir, '_bmad-output', 'planning-artifacts', 'readiness-report.md'), 'PASS\n');

    status = bmad.inspectProject(projectDir, dataDir, { preflight: false });
    assert.strictEqual(status.compatible, true);
    assert.strictEqual(status.version, 'v6.10.0');
    assert.strictEqual(status.artifact_count, 4);
    assert.strictEqual(status.stories.length, 2);
    assert.strictEqual(status.gates.length, 1);
    assert.strictEqual(status.next_action.workflow, 'bmad-quick-dev');
    assert.ok(status.artifacts.every(item => !path.isAbsolute(item.path)));

    const composed = methodologies.composeLaunchPrompt({
      role: 'backend',
      name: 'Coder',
      runtime: 'claude',
      methodology: { id: 'bmad', mode: 'full', workflow: 'bmad-dev-story' },
    });
    assert.match(composed.prompt, /methodology_status/);
    assert.match(composed.prompt, /bmad-dev-story/);
    assert.throws(() => methodologies.composeLaunchPrompt({
      role: 'backend',
      name: 'Tiny',
      runtime: 'ollama-responder',
      methodology: { id: 'bmad', mode: 'quick', workflow: 'bmad-quick-dev' },
    }), /tool-capable runtime/);

    const tools = require('../tools/methodologies')({
      state: { registeredName: 'Coder' },
      helpers: {
        inspectMethodology: () => status,
        runtimeDiagnostics: bmad.runtimeDiagnostics,
        dataDir,
      },
    });
    assert.strictEqual(tools.handlers.methodology_status({}).id, 'bmad');
    assert.strictEqual(tools.handlers.methodology_artifacts({ kind: 'prd' }).count, 1);

    // Runtime diagnostics: runtimeDiagnostics returns expected shape
    const diag = bmad.runtimeDiagnostics(dataDir);
    assert.strictEqual(typeof diag.running_from_working_tree, 'boolean');
    assert.strictEqual(typeof diag.working_tree_version, 'string');
    assert.strictEqual(typeof diag.node_version, 'string');
    assert.strictEqual(typeof diag.pid, 'number');
    assert.ok(Array.isArray(diag.missing_bmad_tools_in_installed_mcp));

    // methodology_status includes a runtime block
    const mStatus = tools.handlers.methodology_status({});
    assert.ok(mStatus.runtime, 'methodology_status should include runtime block');
    assert.strictEqual(typeof mStatus.runtime.installed_mcp_has_bmad, 'boolean');
    assert.strictEqual(typeof mStatus.runtime.data_dir, 'string');

    // methodology_diagnostics returns traceability with correct story counts
    const mDiag = tools.handlers.methodology_diagnostics({});
    assert.ok(mDiag.traceability, 'methodology_diagnostics should include traceability');
    assert.strictEqual(mDiag.traceability.stories_count, 2);
    assert.strictEqual(mDiag.traceability.gates_count, 1);
    assert.strictEqual(mDiag.traceability.methodology_drift, 'ok');
    assert.ok(['quick', 'analysis', 'planning', 'solutioning', 'implementation'].includes(mDiag.traceability.current_phase), 'current_phase should be a valid phase');

    console.log('BMAD integration tests passed');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
