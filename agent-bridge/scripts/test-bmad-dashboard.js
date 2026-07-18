'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const packageDir = path.resolve(__dirname, '..');
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-bmad-dashboard-'));
const dataDir = path.join(projectDir, '.neohive');
fs.mkdirSync(dataDir, { recursive: true });
const fakeBin = path.join(projectDir, 'bin');
fs.mkdirSync(fakeBin, { recursive: true });
for (const binary of ['claude', 'gemini', 'codex', 'agent']) {
  const file = path.join(fakeBin, binary);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
}
const fakeTmux = path.join(fakeBin, 'tmux');
fs.writeFileSync(fakeTmux, '#!/bin/sh\nif [ "$1" = "new-window" ]; then printf "@bmad\\t%%bmad\\n"; fi\nexit 0\n');
fs.chmodSync(fakeTmux, 0o755);
const port = 32000 + (process.pid % 1000);

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Dashboard did not start')), 10000);
    const inspect = (chunk) => {
      const output = String(chunk || '');
      if (/listening|localhost|dashboard/i.test(output)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Dashboard exited early (${code})`));
    });
  });
}

async function json(pathname, options) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function run() {
  const modelServer = http.createServer((req, res) => {
    if (req.url !== '/api/tags') return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen-test:1b', size: 1000, details: {} }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const modelPort = modelServer.address().port;
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    ollama: { endpoints: [{ id: 'mock', name: 'Mock', url: `http://127.0.0.1:${modelPort}` }] },
  }));
  const child = spawn(process.execPath, ['dashboard.js'], {
    cwd: packageDir,
    env: Object.assign({}, process.env, {
      NEOHIVE_PORT: String(port),
      NEOHIVE_DATA_DIR: dataDir,
      NEOHIVE_PROJECT_ROOT: projectDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(child);
    const methods = await json('/api/launch/methodologies');
    assert.strictEqual(methods.methodologies[0].id, 'bmad');
    assert.strictEqual(methods.runtimes.find(item => item.id === 'ollama-responder').capabilities.filesystem, false);
    const preview = await json('/api/launch/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LTT-Request': '1' },
      body: JSON.stringify({
        role: 'backend',
        agent_name: 'BmadCoder',
        runtime: 'claude',
        methodology: { id: 'bmad', mode: 'quick', workflow: 'bmad-quick-dev' },
      }),
    });
    assert.match(preview.prompt, /bmad-quick-dev/);
    await assert.rejects(() => json('/api/launch/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LTT-Request': '1' },
      body: JSON.stringify({
        role: 'backend',
        agent_name: 'Tiny',
        runtime: 'ollama-responder',
        methodology: { id: 'bmad', mode: 'quick', workflow: 'bmad-quick-dev' },
      }),
    }), /tool-capable runtime/);

    let status = await json('/api/methodologies/bmad/status');
    assert.strictEqual(status.installed, false);
    assert.strictEqual(status.settings.mode, 'quick');

    const settings = await json('/api/methodologies/bmad/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LTT-Request': '1' },
      body: JSON.stringify({ enabled: true, mode: 'full', workflow: 'bmad-prd' }),
    });
    assert.strictEqual(settings.settings.mode, 'full');
    status = await json('/api/methodologies/bmad/status');
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.next_action.workflow, null);

    const artifacts = await json('/api/methodologies/bmad/artifacts');
    assert.deepStrictEqual(artifacts, { count: 0, artifacts: [] });

    fs.mkdirSync(path.join(projectDir, '_bmad', '_config'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '_bmad', '_config', 'manifest.yaml'), 'installation:\n  version: 6.10.0\nmodules:\n  - name: bmm\nides:\n  - claude-code\n');
    for (const [index, runtime] of ['claude', 'gemini', 'codex', 'cursor'].entries()) {
      const launched = await json('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTT-Request': '1' },
        body: JSON.stringify({
          cli: runtime,
          role: 'backend',
          agent_name: `Native${index}`,
          base_prompt: 'TEMPLATE CUSTOM CONTRACT',
          methodology: { id: 'bmad', mode: 'full', workflow: 'bmad-dev-story' },
        }),
      });
      assert.strictEqual(launched.launched, true);
      assert.match(launched.prompt, /TEMPLATE CUSTOM CONTRACT/);
      assert.match(launched.prompt, /bmad-dev-story/);
    }

    const managed = await json('/api/ollama/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LTT-Request': '1' },
      body: JSON.stringify({
        name: 'ClaudeOllama',
        model: 'qwen-test:1b',
        endpoint_id: 'mock',
        runtime: 'claude',
        role: 'backend',
        base_prompt: 'OLLAMA TEMPLATE CONTRACT',
        methodology: { id: 'bmad', mode: 'quick', workflow: 'bmad-quick-dev' },
      }),
    });
    assert.strictEqual(managed.instance.methodology.id, 'bmad');
    assert.strictEqual(managed.instance.methodology.version, '6.10.0');

    await assert.rejects(() => json('/api/ollama/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-LTT-Request': '1' },
      body: JSON.stringify({
        name: 'Tiny',
        model: 'qwen-test:1b',
        endpoint_id: 'mock',
        runtime: 'ollama',
        role: 'backend',
        methodology: { id: 'bmad', mode: 'quick', workflow: 'bmad-quick-dev' },
      }),
    }), /tool-capable runtime/);
    console.log('BMAD dashboard API tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => modelServer.close(resolve));
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
