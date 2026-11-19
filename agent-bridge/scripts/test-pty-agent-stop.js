'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { stopPtyOwnerProcesses } = require('../lib/pty-agent-stop');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

console.log('\n[pty-agent-stop] DELETE must stop PTY owner\n');

test('dashboard exposes explicit Stop Agent and refuses hidden live-owner deletion', async () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
  assert.ok(dashboard.includes("/^\\/api\\/agents\\/[^/]+\\/stop$/"));
  assert.ok(dashboard.includes('agent was not removed'));
  assert.ok(html.includes('id="terminal-stop-agent-btn"'));
  assert.ok(html.includes('Use End if you only want to disconnect this browser'));
});

test('non-pty entry → no-op', async () => {
  const r = await stopPtyOwnerProcesses('/tmp', 'x', { pid: 1 });
  assert.strictEqual(r.attempted, false);
  assert.deepStrictEqual(r.killed, []);
});

test('invalid agent name is rejected before any stop attempt', async () => {
  const r = await stopPtyOwnerProcesses('/tmp', '../other', { pty_owner: true, pty_owner_pid: 111 });
  assert.strictEqual(r.attempted, false);
  assert.ok(r.errors.some((e) => e.label === 'invalid-agent-name'));
});

test('socket terminate acknowledgement completes graceful stop', async () => {
  const kills = [];
  const alive = new Set([111, 222]);
  const r = await stopPtyOwnerProcesses('/tmp', 'bob', {
    pty_owner: true,
    pty_owner_pid: 111,
    cli_pid: 222,
    pid: 999,
  }, {
    graceMs: 100,
    aliveFn: (pid) => alive.has(pid),
    requestTerminateFn: async () => { alive.clear(); return true; },
    verifyOwnerFn: () => true,
    killFn: (pid, signal) => kills.push([pid, signal]),
    sleepFn: async () => {},
  });
  assert.strictEqual(r.attempted, true);
  assert.strictEqual(r.graceful, true);
  assert.strictEqual(r.stopped, true);
  assert.deepStrictEqual(kills, []);
});

test('missing socket falls back to verified SIGTERM', async () => {
  const kills = [];
  const alive = new Set([111, 222]);
  const r = await stopPtyOwnerProcesses('/tmp', 'bob', {
    pty_owner: true,
    pty_owner_pid: 111,
    cli_pid: 222,
  }, {
    graceMs: 0,
    forceMs: 20,
    aliveFn: (pid) => alive.has(pid),
    requestTerminateFn: async () => false,
    verifyOwnerFn: () => true,
    killFn: (pid, signal) => {
      kills.push([pid, signal]);
      alive.clear();
    },
    sleepFn: async () => {},
  });
  assert.deepStrictEqual(kills, [[111, 'SIGTERM']]);
  assert.strictEqual(r.stopped, true);
});

test('unverified owner identity is never signalled', async () => {
  const kills = [];
  const alive = new Set([111]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-stop-unverified-'));
  const socketPath = path.join(dir, 'pty-bob.sock');
  fs.writeFileSync(socketPath, '');
  const r = await stopPtyOwnerProcesses(dir, 'bob', {
    pty_owner: true,
    pty_owner_pid: 111,
  }, {
    graceMs: 0,
    forceMs: 0,
    aliveFn: (pid) => alive.has(pid),
    requestTerminateFn: async () => false,
    verifyOwnerFn: () => false,
    killFn: (pid, signal) => kills.push([pid, signal]),
    sleepFn: async () => {},
  });
  assert.deepStrictEqual(kills, []);
  assert.strictEqual(r.stopped, false);
  assert.ok(r.errors.some((e) => e.label === 'identity-check'));
  assert.strictEqual(fs.existsSync(socketPath), true, 'failed stop must preserve live owner socket');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verified owner that ignores SIGTERM receives bounded SIGKILL', async () => {
  const kills = [];
  const alive = new Set([111]);
  const r = await stopPtyOwnerProcesses('/tmp', 'bob', {
    pty_owner: true,
    pty_owner_pid: 111,
  }, {
    graceMs: 0,
    forceMs: 0,
    aliveFn: (pid) => alive.has(pid),
    requestTerminateFn: async () => false,
    verifyOwnerFn: () => true,
    killFn: (pid, signal) => {
      kills.push([pid, signal]);
      if (signal === 'SIGKILL') alive.delete(pid);
    },
    sleepFn: async () => {},
  });
  assert.deepStrictEqual(kills, [[111, 'SIGTERM'], [111, 'SIGKILL']]);
  assert.strictEqual(r.forced, true);
  assert.strictEqual(r.stopped, true);
});

test('unlinks pty sock when present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-stop-'));
  const sock = path.join(dir, 'pty-bob.sock');
  fs.writeFileSync(sock, '');
  const r = await stopPtyOwnerProcesses(dir, 'bob', {
    pty_owner: true,
    pty_owner_pid: 1,
  }, {
    graceMs: 0,
    forceMs: 0,
    aliveFn: () => false,
    killFn: () => {},
    requestTerminateFn: async () => false,
    verifyOwnerFn: () => false,
    sleepFn: async () => {},
  });
  assert.strictEqual(r.sock_unlinked, true);
  assert.strictEqual(fs.existsSync(sock), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live detached owner stops through socket and cleans registry/socket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-stop-live-'));
  const agentName = 'StopSmoke';
  const config = {
    dataDir: dir,
    agentName,
    command: '/bin/bash',
    args: ['-lc', 'trap "exit 0" TERM; while true; do sleep 1; done'],
    cwd: dir,
    env: {},
    cols: 80,
    rows: 24,
  };
  const owner = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'pty-owner.js'), JSON.stringify(config)], {
    detached: true,
    stdio: 'ignore',
  });
  owner.unref();
  const agentsFile = path.join(dir, 'agents.json');
  const socketPath = path.join(dir, `pty-${agentName}.sock`);
  let entry = null;
  const readyDeadline = Date.now() + 4000;
  while (Date.now() < readyDeadline) {
    try {
      const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      if (agents[agentName] && fs.existsSync(socketPath)) {
        entry = Object.assign({}, agents[agentName]);
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    assert.ok(entry, 'owner did not become ready');
    const result = await stopPtyOwnerProcesses(dir, agentName, entry, { graceMs: 2000, forceMs: 500 });
    assert.strictEqual(result.stopped, true, JSON.stringify(result));
    assert.strictEqual(fs.existsSync(socketPath), false);
    const remaining = fs.existsSync(agentsFile) ? JSON.parse(fs.readFileSync(agentsFile, 'utf8')) : {};
    assert.ok(!remaining[agentName], 'registry entry remained after stop');
  } finally {
    try { process.kill(-owner.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓', name); passed++; }
    catch (e) { console.error('  ✗', name + '\n   ', e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
