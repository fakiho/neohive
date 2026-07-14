#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ollama = require('../lib/ollama-bridge-manager');
const launchProfiles = require('../lib/agent-launch-profiles');
const terminal = require('../lib/terminal-ws');

function rejects(fn, pattern) {
  assert.throws(fn, pattern);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  assert.strictEqual(ollama.validateEndpoint('http://192.168.1.120:11434/'), 'http://192.168.1.120:11434');
  assert.strictEqual(ollama.validateEndpoint('https://ollama.example.test'), 'https://ollama.example.test');
  rejects(() => ollama.validateEndpoint('file:///tmp/socket'), /HTTP or HTTPS/);
  rejects(() => ollama.validateEndpoint('http://user:pass@example.test'), /credentials/);
  rejects(() => ollama.validateEndpoint('http://example.test/api'), /paths/);
  rejects(() => ollama.validateEndpoint('http://example.test?token=x'), /query strings/);
  assert.deepStrictEqual(
    ollama.validateEndpointProfile({ id: 'office_ollama', name: 'Office Ollama', url: 'http://10.0.0.2:11434' }),
    { id: 'office_ollama', name: 'Office Ollama', url: 'http://10.0.0.2:11434' }
  );
  const backend = launchProfiles.getRoleProfile('backend');
  assert(backend.skills.includes('nodejs'));
  assert.match(launchProfiles.buildRolePrompt('backend', 'LocalCoder'), /Register as "LocalCoder"/);
  rejects(() => launchProfiles.buildRolePrompt('', 'LocalCoder'), /supported agent role/);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-ollama-test-'));
  const modelServer = http.createServer((req, res) => {
    if (req.url !== '/api/tags') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      models: [
        { name: 'qwen3.5:9b', size: 8229088132, details: { family: 'qwen3', parameter_size: '9.7B', quantization_level: 'Q4_K_M' } },
        { model: 'llama3.2:3b', size: 2019393189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
      ],
    }));
  });
  try {
    await listen(modelServer);
    const address = modelServer.address();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      ollama: { endpoints: [{ id: 'mock', name: 'Mock Ollama', url: `http://127.0.0.1:${address.port}` }] },
    }));

    const discovered = await ollama.listModels(dataDir, 'mock');
    assert.deepStrictEqual(discovered.models.map((model) => model.name), ['llama3.2:3b', 'qwen3.5:9b']);
    assert.strictEqual(discovered.models[1].parameter_size, '9.7B');
    assert.strictEqual((await ollama.requireAvailableModel(dataDir, 'mock', 'qwen3.5:9b')).model.name, 'qwen3.5:9b');
    await assert.rejects(() => ollama.requireAvailableModel(dataDir, 'mock', 'missing:1b'), /not installed/);
    await assert.rejects(() => ollama.startInstance({
      dataDir,
      projectDir: dataDir,
      packageDir: path.resolve(__dirname, '..'),
      name: 'NoRole',
      model: 'qwen3.5:9b',
      endpointId: 'mock',
      runtime: 'ollama',
      role: '',
    }), /supported agent role/);

    await close(modelServer);
    await assert.rejects(() => ollama.listModels(dataDir, 'mock'), /Could not reach Ollama endpoint/);

    fs.writeFileSync(path.join(dataDir, 'ollama-bridges.json'), JSON.stringify({
      instances: [
        { id: 'aaaaaaaaaaaaaaaa', name: 'Stopped', status: 'stopped', tmux_window_id: '@99991' },
        { id: 'bbbbbbbbbbbbbbbb', name: 'Dead', status: 'running', tmux_window_id: '@99992' },
      ],
    }));
    assert.deepStrictEqual(ollama.listInstances(dataDir), []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'ollama-bridges.json'), 'utf8')).instances, []);
  } finally {
    if (modelServer.listening) await close(modelServer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  assert(terminal.CONTROL_ACTIONS.has('split_left_right'));
  assert(terminal.CONTROL_ACTIONS.has('split_top_bottom'));
  assert(terminal.CONTROL_ACTIONS.has('close_pane'));
  assert(!terminal.CONTROL_ACTIONS.has('run_arbitrary_command'));

  const session = `neohive-test-${process.pid}`;
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', session, '-n', 'first']);
    execFileSync('tmux', ['new-window', '-d', '-t', session, '-n', 'second']);
    execFileSync('tmux', ['select-window', '-t', `${session}:first`]);

    const initial = await terminal.executeTmuxControl(session, 'get_state');
    assert.strictEqual(initial.windowName, 'first');
    assert.strictEqual(initial.windowCount, 2);
    assert.strictEqual(initial.paneCount, 1);
    assert.strictEqual(initial.canClosePane, false);

    const split = await terminal.executeTmuxControl(session, 'split_left_right');
    assert.strictEqual(split.paneCount, 2);
    assert.strictEqual(split.canClosePane, true);

    const closed = await terminal.executeTmuxControl(session, 'close_pane');
    assert.strictEqual(closed.paneCount, 1);
    const stacked = await terminal.executeTmuxControl(session, 'split_top_bottom');
    assert.strictEqual(stacked.paneCount, 2);
    const stackedClosed = await terminal.executeTmuxControl(session, 'close_pane');
    assert.strictEqual(stackedClosed.paneCount, 1);
    await assert.rejects(() => terminal.executeTmuxControl(session, 'close_pane'), /final pane/);
    await assert.rejects(() => terminal.executeTmuxControl(session, 'not_allowed'), /Unsupported/);

    const next = await terminal.executeTmuxControl(session, 'window_next');
    assert.strictEqual(next.windowName, 'second');
    const previous = await terminal.executeTmuxControl(session, 'window_previous');
    assert.strictEqual(previous.windowName, 'first');
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', session]); } catch {}
  }

  console.log('Ollama and tmux control tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
