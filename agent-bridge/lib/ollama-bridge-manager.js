'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  buildRolePrompt,
  getRoleProfile,
  validateAgentName: validateLaunchAgentName,
} = require('./agent-launch-profiles');
const {
  execTmux,
  findExecutable,
  launchInTmux,
} = require('./tmux-cli-launcher');

const ENDPOINT_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const RUNTIMES = new Set(['ollama', 'claude']);
const START_TIMEOUT_MS = 10000;
const MODEL_FETCH_TIMEOUT_MS = 7000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function validateEndpoint(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Endpoint must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endpoint must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('Endpoint credentials are not allowed');
  if (url.search || url.hash) throw new Error('Endpoint query strings and fragments are not allowed');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Endpoint paths are not allowed');
  return url.origin;
}

function validateEndpointProfile(profile) {
  const id = String(profile && profile.id || '').trim();
  const name = String(profile && profile.name || '').trim();
  if (!ENDPOINT_ID_RE.test(id)) throw new Error('Endpoint ID must be 1-40 letters, numbers, underscores, or hyphens');
  if (!name || name.length > 80) throw new Error('Endpoint name must be 1-80 characters');
  return { id, name, url: validateEndpoint(profile.url) };
}

function getConfig(dataDir) {
  return readJson(path.join(dataDir, 'config.json'), {});
}

function saveConfig(dataDir, config) {
  writeJsonAtomic(path.join(dataDir, 'config.json'), config);
}

function listEndpoints(dataDir) {
  const config = getConfig(dataDir);
  const endpoints = config.ollama && Array.isArray(config.ollama.endpoints) ? config.ollama.endpoints : [];
  return endpoints.map(validateEndpointProfile);
}

function getEndpoint(dataDir, endpointId) {
  if (!ENDPOINT_ID_RE.test(endpointId || '')) throw new Error('Invalid endpoint ID');
  const endpoint = listEndpoints(dataDir).find((item) => item.id === endpointId);
  if (!endpoint) throw new Error('Saved Ollama endpoint not found');
  return endpoint;
}

async function fetchJson(url, timeoutMs = MODEL_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Ollama endpoint timed out');
    if (/^Ollama /.test(error && error.message || '')) throw error;
    throw new Error(`Could not reach Ollama endpoint: ${error && error.message || 'request failed'}`);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModels(payload) {
  if (!payload || !Array.isArray(payload.models)) throw new Error('Ollama returned an invalid model list');
  return payload.models.map((item) => {
    const model = item && typeof item === 'object' ? item : {};
    const name = validateModel(model.name || model.model);
    const details = model.details && typeof model.details === 'object' ? model.details : {};
    return {
      name,
      size: Number.isFinite(model.size) && model.size >= 0 ? model.size : null,
      modified_at: typeof model.modified_at === 'string' ? model.modified_at : null,
      family: typeof details.family === 'string' ? details.family : null,
      parameter_size: typeof details.parameter_size === 'string' ? details.parameter_size : null,
      quantization_level: typeof details.quantization_level === 'string' ? details.quantization_level : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function listModels(dataDir, endpointId) {
  const endpoint = getEndpoint(dataDir, endpointId);
  const payload = await fetchJson(`${endpoint.url}/api/tags`);
  return {
    endpoint: { id: endpoint.id, name: endpoint.name, url: endpoint.url },
    models: normalizeModels(payload),
  };
}

async function requireAvailableModel(dataDir, endpointId, model) {
  const safeModel = validateModel(model);
  const result = await listModels(dataDir, endpointId);
  const available = result.models.find((item) => item.name === safeModel);
  if (!available) throw new Error(`Model "${safeModel}" is not installed on ${result.endpoint.name}`);
  return { endpoint: result.endpoint, model: available };
}

function upsertEndpoint(dataDir, profile) {
  const clean = validateEndpointProfile(profile);
  const config = getConfig(dataDir);
  if (!config.ollama || typeof config.ollama !== 'object') config.ollama = {};
  const endpoints = Array.isArray(config.ollama.endpoints) ? config.ollama.endpoints : [];
  const index = endpoints.findIndex((item) => item && item.id === clean.id);
  if (index >= 0) endpoints[index] = clean;
  else endpoints.push(clean);
  config.ollama.endpoints = endpoints;
  saveConfig(dataDir, config);
  return clean;
}

function removeEndpoint(dataDir, endpointId) {
  if (!ENDPOINT_ID_RE.test(endpointId || '')) throw new Error('Invalid endpoint ID');
  const running = listInstances(dataDir).some((instance) =>
    instance.endpoint_id === endpointId && ['starting', 'running', 'working'].includes(instance.status));
  if (running) throw new Error('Stop agents using this endpoint before deleting it');
  const config = getConfig(dataDir);
  if (!config.ollama || !Array.isArray(config.ollama.endpoints)) return false;
  const before = config.ollama.endpoints.length;
  config.ollama.endpoints = config.ollama.endpoints.filter((item) => item && item.id !== endpointId);
  saveConfig(dataDir, config);
  return config.ollama.endpoints.length !== before;
}

function registryFile(dataDir) {
  return path.join(dataDir, 'ollama-bridges.json');
}

function runtimeFile(dataDir, instanceId) {
  return path.join(dataDir, `ollama-runtime-${instanceId}.json`);
}

function stopFile(dataDir, instanceId) {
  return path.join(dataDir, `ollama-stop-${instanceId}`);
}

function loadRegistry(dataDir) {
  const value = readJson(registryFile(dataDir), { instances: [] });
  return { instances: Array.isArray(value.instances) ? value.instances : [] };
}

function saveRegistry(dataDir, registry) {
  writeJsonAtomic(registryFile(dataDir), registry);
}

function isManagedResponder(dataDir, agentName) {
  const name = String(agentName || '');
  return loadRegistry(dataDir).instances.some((instance) =>
    instance &&
    instance.name === name &&
    instance.runtime === 'ollama' &&
    !['stopped', 'failed'].includes(instance.status));
}

function isFreshRuntime(runtime) {
  const timestamp = Date.parse(runtime && runtime.last_activity);
  return Number.isFinite(timestamp) && Date.now() - timestamp < 30000;
}

function taggedWindowExistsSync(instance) {
  if (!instance || !instance.tmux_window_id) return false;
  for (const option of ['@neohive_managed_instance', '@neohive_ollama_instance']) {
    try {
      const tag = execFileSync('tmux', ['show-options', '-w', '-v', '-t', instance.tmux_window_id, option], {
        timeout: 2000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (tag === instance.id) return true;
    } catch {}
  }
  return false;
}

function listInstances(dataDir) {
  const registry = loadRegistry(dataDir);
  let changed = false;
  const instances = [];
  const kept = [];
  for (const instance of registry.instances) {
    if (['stopped', 'failed'].includes(instance.status) || !taggedWindowExistsSync(instance)) {
      try { fs.unlinkSync(runtimeFile(dataDir, instance.id)); } catch {}
      try { fs.unlinkSync(stopFile(dataDir, instance.id)); } catch {}
      changed = true;
      continue;
    }
    const runtime = readJson(runtimeFile(dataDir, instance.id), null);
    let status = instance.status || 'unknown';
    let pid = runtime && runtime.pid || null;
    let lastActivity = runtime && runtime.last_activity || instance.last_activity || null;
    if (instance.runtime === 'claude') {
      const agents = readJson(path.join(dataDir, 'agents.json'), {});
      const agent = agents[instance.name];
      const heartbeat = readJson(path.join(dataDir, `heartbeat-${instance.name}.json`), null);
      if (agent && agentNameIsLive(dataDir, instance.name)) {
        status = 'running';
        pid = heartbeat && heartbeat.pid || agent.pid || null;
        lastActivity = heartbeat && heartbeat.last_activity || agent.last_activity || null;
      } else if (status === 'starting' && Date.now() - Date.parse(instance.started_at) < 90000) {
        status = 'starting';
      } else if (['starting', 'running', 'working'].includes(status)) {
        status = 'running';
      }
    } else if (runtime && isFreshRuntime(runtime)) status = runtime.status || 'running';
    else if (['starting', 'running', 'working'].includes(status)) status = 'running';
    if (status !== instance.status) {
      instance.status = status;
      changed = true;
    }
    kept.push(instance);
    instances.push(Object.assign({}, instance, {
      status,
      pid,
      last_activity: lastActivity,
    }));
  }
  if (kept.length !== registry.instances.length) registry.instances = kept;
  if (changed) saveRegistry(dataDir, registry);
  return instances;
}

function validateAgentName(name) {
  const value = validateLaunchAgentName(name);
  if (['system', 'dashboard'].includes(value.toLowerCase())) throw new Error('Agent name is reserved');
  return value;
}

function validateModel(model) {
  const value = String(model || '').trim();
  if (!MODEL_RE.test(value)) throw new Error('Invalid Ollama model name');
  return value;
}

function agentNameIsLive(dataDir, name) {
  const agents = readJson(path.join(dataDir, 'agents.json'), {});
  const agent = agents[name];
  if (!agent) return false;
  const heartbeat = readJson(path.join(dataDir, `heartbeat-${name}.json`), null);
  const lastActivity = heartbeat && heartbeat.last_activity || agent.last_activity;
  const age = Date.now() - Date.parse(lastActivity || 0);
  if (Number.isFinite(age) && age < 30000) return true;
  try { process.kill(agent.pid, 0); return true; } catch { return false; }
}

async function waitForRuntime(dataDir, instanceId) {
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    const runtime = readJson(runtimeFile(dataDir, instanceId), null);
    if (runtime && isFreshRuntime(runtime)) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Ollama agent did not register within 10 seconds');
}

function buildClaudeLaunchArgs({ dataDir, endpointUrl, claudePath, name, model, role, skills, prompt }) {
  const skillText = skills.length ? skills.join(', ') : 'general';
  const systemPrompt = [
    `You are Neohive agent ${name} with role ${role || 'agent'} and skills ${skillText}.`,
    'Do not use the Agent tool to register and do not spawn a setup subagent.',
    `When the role prompt asks you to register, call the Neohive MCP register tool directly with name "${name}" and skills [${skillText}].`,
    'Follow the supplied role prompt exactly, then remain in the Neohive listen loop.',
  ].join('\n\n');
  return [
    `NEOHIVE_DATA_DIR=${dataDir}`,
    'ANTHROPIC_AUTH_TOKEN=ollama',
    'ANTHROPIC_API_KEY=',
    `ANTHROPIC_BASE_URL=${endpointUrl}`,
    claudePath,
    '--model', model,
    '--disallowedTools', 'Agent',
    '--append-system-prompt', systemPrompt,
    prompt,
  ];
}

async function startInstance({ dataDir, projectDir, packageDir, name, model, endpointId, runtime, role }) {
  const safeName = validateAgentName(name);
  const safeModel = validateModel(model);
  const safeRuntime = runtime || 'ollama';
  const roleProfile = getRoleProfile(role);
  const safeRole = roleProfile.id;
  const safeSkills = roleProfile.skills.slice();
  const generatedPrompt = buildRolePrompt(safeRole, safeName);
  if (!RUNTIMES.has(safeRuntime)) throw new Error('Runtime must be "ollama" or "claude"');
  const available = await requireAvailableModel(dataDir, endpointId, safeModel);
  const endpoint = available.endpoint;
  if (agentNameIsLive(dataDir, safeName)) throw new Error(`Agent "${safeName}" is already running`);

  const active = listInstances(dataDir).find((item) =>
    item.name.toLowerCase() === safeName.toLowerCase() && ['starting', 'running', 'working'].includes(item.status));
  if (active) throw new Error(`Managed Ollama agent "${safeName}" is already running`);

  const instanceId = crypto.randomBytes(12).toString('hex');
  const windowName = `${safeRuntime === 'claude' ? 'claude-ollama' : 'ollama'}-${safeName}`.slice(0, 50);
  const runtimeScript = path.join(packageDir, 'scripts', 'ollama-agent.js');
  let envArgs;
  if (safeRuntime === 'claude') {
    const claudePath = findExecutable('claude');
    if (!claudePath) throw new Error('Claude Code is not installed or not available on PATH');
    envArgs = buildClaudeLaunchArgs({
      dataDir,
      endpointUrl: endpoint.url,
      claudePath,
      name: safeName,
      model: safeModel,
      role: safeRole,
      skills: safeSkills,
      prompt: generatedPrompt,
    });
  } else {
    if (!fs.existsSync(runtimeScript)) throw new Error('Packaged Ollama runtime is missing');
    envArgs = [
      `NEOHIVE_DATA_DIR=${dataDir}`,
      process.execPath,
      runtimeScript,
      '--name', safeName,
      '--model', safeModel,
      '--endpoint', endpoint.url,
      '--instance', instanceId,
      '--skills', safeSkills.join(','),
      '--system-prompt', generatedPrompt,
    ];
  }
  const window = await launchInTmux({
    dataDir,
    projectDir,
    windowName,
    envArgs,
    tagOption: '@neohive_managed_instance',
    tagValue: instanceId,
    select: false,
  });

  const registry = loadRegistry(dataDir);
  const instance = {
    id: instanceId,
    runtime: safeRuntime,
    name: safeName,
    role: safeRole,
    skills: safeSkills,
    model: safeModel,
    endpoint_id: endpoint.id,
    endpoint_name: endpoint.name,
    tmux_session: window.sessionName,
    tmux_window_id: window.windowId,
    tmux_pane_id: window.paneId,
    tmux_window_name: window.windowName,
    status: 'starting',
    started_at: new Date().toISOString(),
  };
  registry.instances.push(instance);
  saveRegistry(dataDir, registry);

  if (safeRuntime === 'claude') return instance;

  try {
    const runtime = await waitForRuntime(dataDir, instanceId);
    instance.status = runtime.status || 'running';
    instance.last_activity = runtime.last_activity;
    saveRegistry(dataDir, registry);
    return instance;
  } catch (error) {
    if (await getTaggedWindow(instance)) {
      await execTmux(['kill-window', '-t', instance.tmux_window_id]).catch(() => {});
    }
    registry.instances = registry.instances.filter((item) => item.id !== instance.id);
    saveRegistry(dataDir, registry);
    throw error;
  }
}

async function getTaggedWindow(instance) {
  try {
    let tag = await execTmux(['show-options', '-w', '-v', '-t', instance.tmux_window_id, '@neohive_managed_instance']);
    if (!tag) {
      tag = await execTmux(['show-options', '-w', '-v', '-t', instance.tmux_window_id, '@neohive_ollama_instance']);
    }
    return tag === instance.id;
  } catch {
    return false;
  }
}

async function stopInstance(dataDir, instanceId) {
  if (!/^[a-f0-9]{16,64}$/.test(instanceId || '')) throw new Error('Invalid instance ID');
  const registry = loadRegistry(dataDir);
  const instance = registry.instances.find((item) => item.id === instanceId);
  if (!instance) throw new Error('Managed Ollama agent not found');
  if (!(await getTaggedWindow(instance))) {
    instance.status = 'stale';
    saveRegistry(dataDir, registry);
    throw new Error('The recorded tmux window is no longer owned by this Ollama instance');
  }

  fs.writeFileSync(stopFile(dataDir, instanceId), new Date().toISOString());
  const started = Date.now();
  while (Date.now() - started < 5000 && fs.existsSync(runtimeFile(dataDir, instanceId))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (instance.runtime === 'claude' || fs.existsSync(runtimeFile(dataDir, instanceId))) {
    await execTmux(['send-keys', '-t', instance.tmux_pane_id, 'C-c']);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (await getTaggedWindow(instance)) {
    await execTmux(['kill-window', '-t', instance.tmux_window_id]);
  }
  try { fs.unlinkSync(stopFile(dataDir, instanceId)); } catch {}
  instance.status = 'stopped';
  instance.stopped_at = new Date().toISOString();
  registry.instances = registry.instances.filter((item) => item.id !== instance.id);
  saveRegistry(dataDir, registry);
  return instance;
}

async function focusInstance(dataDir, instanceId) {
  const instance = listInstances(dataDir).find((item) => item.id === instanceId);
  if (!instance) throw new Error('Managed Ollama agent not found');
  if (!(await getTaggedWindow(instance))) throw new Error('Ollama tmux window is no longer available');
  await execTmux(['select-window', '-t', instance.tmux_window_id]);
  return instance;
}

module.exports = {
  validateEndpoint,
  validateEndpointProfile,
  listEndpoints,
  normalizeModels,
  listModels,
  requireAvailableModel,
  buildClaudeLaunchArgs,
  upsertEndpoint,
  removeEndpoint,
  isManagedResponder,
  listInstances,
  startInstance,
  stopInstance,
  focusInstance,
};
