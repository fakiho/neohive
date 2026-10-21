'use strict';

// Tests for lib/terminal-ws.js PTY socket bridge (Story 1.3 follow-up).
// Covers the two gaps flagged in Grok2's STRICT dual-review (AC5):
//   - discoverPtySockets(): live sock+PID included, stale sock (dead PID) skipped,
//     non-pty_owner agents ignored.
//   - attachPtySocket(): forwards input/resize NDJSON frames to a fake unix
//     socket server, and tails a fake agent-log JSONL file, emitting output
//     frames (and an exit frame on agent_exit) back over the fake WebSocket.
//
// No node-pty or real agent process required — the owner process interaction
// is faked with a plain net server, matching test-pty-socket-server.js's style.

const assert = require('assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverPtySockets, attachPtySocket } = require('../lib/terminal-ws');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function mkTmpDir(suffix) {
  const dir = path.join(os.tmpdir(), `terminal-ws-test-${process.pid}-${suffix}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Minimal fake WebSocket: records every sent frame, no real network involved.
function makeFakeWs() {
  const sent = [];
  const handlers = {};
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (raw) => { sent.push(JSON.parse(raw)); },
    close: () => { ws.readyState = 3; },
    on: (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); },
    _emit: (evt, ...args) => { (handlers[evt] || []).forEach((fn) => fn(...args)); },
  };
  return { ws, sent };
}

// ===================== discoverPtySockets =====================

test('discoverPtySockets: includes an agent with a live sock + live owner PID', () => {
  const dataDir = mkTmpDir('discover-live');
  const sockPath = path.join(dataDir, 'pty-agentA.sock');
  fs.writeFileSync(sockPath, ''); // presence is all discoverPtySockets checks for the file
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify({
    agentA: { pty_owner: true, pty_owner_pid: process.pid },
  }));
  const result = discoverPtySockets(dataDir);
  assert.strictEqual(result.get('agentA'), sockPath);
});

test('discoverPtySockets: skips a stale sock whose owner PID is dead', () => {
  const dataDir = mkTmpDir('discover-stale');
  const sockPath = path.join(dataDir, 'pty-agentB.sock');
  fs.writeFileSync(sockPath, '');
  // A PID astronomically unlikely to be alive on any test host.
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify({
    agentB: { pty_owner: true, pty_owner_pid: 999999999 },
  }));
  const result = discoverPtySockets(dataDir);
  assert.ok(!result.has('agentB'), 'stale/dead-owner socket must not be reported live');
});

test('discoverPtySockets: ignores agents without pty_owner even if a sock file exists', () => {
  const dataDir = mkTmpDir('discover-nonowner');
  fs.writeFileSync(path.join(dataDir, 'pty-agentC.sock'), '');
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify({
    agentC: { pid: process.pid }, // no pty_owner flag
  }));
  const result = discoverPtySockets(dataDir);
  assert.ok(!result.has('agentC'));
});

test('discoverPtySockets: ignores agents with pty_owner but no pty_owner_pid', () => {
  const dataDir = mkTmpDir('discover-nopid');
  fs.writeFileSync(path.join(dataDir, 'pty-agentD.sock'), '');
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify({
    agentD: { pty_owner: true },
  }));
  const result = discoverPtySockets(dataDir);
  assert.ok(!result.has('agentD'));
});

test('discoverPtySockets: returns an empty map when agents.json is missing', () => {
  const dataDir = mkTmpDir('discover-noagents');
  fs.writeFileSync(path.join(dataDir, 'pty-agentE.sock'), '');
  const result = discoverPtySockets(dataDir);
  assert.strictEqual(result.size, 0);
});

// ===================== attachPtySocket =====================

test('attachPtySocket: forwards input and resize frames to the unix socket', async () => {
  const dataDir = mkTmpDir('attach-forward');
  const socketPath = path.join(dataDir, 'pty-agentF.sock');
  const logPath = path.join(dataDir, 'agent-log-agentF.jsonl');
  fs.writeFileSync(logPath, '');

  const received = [];
  const srv = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) { try { received.push(JSON.parse(line)); } catch {} }
      }
    });
  });
  await new Promise((resolve) => srv.listen(socketPath, resolve));

  const { ws } = makeFakeWs();
  attachPtySocket(ws, { agentName: 'agentF', socketPath, logPath });
  await sleep(80);

  ws._emit('message', JSON.stringify({ type: 'input', data: 'hello' }));
  ws._emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await sleep(80);

  ws._emit('close');
  srv.close();

  assert.deepStrictEqual(
    received.filter((f) => f.type === 'input'),
    [{ type: 'input', data: 'hello' }],
  );
  assert.ok(
    received.some((f) => f.type === 'resize' && f.cols === 120 && f.rows === 40),
    'expected a resize frame with cols/rows forwarded',
  );
});

test('attachPtySocket: errors and does not connect when the socket file is missing', async () => {
  const dataDir = mkTmpDir('attach-missing');
  const socketPath = path.join(dataDir, 'pty-agentG.sock'); // never created
  const logPath = path.join(dataDir, 'agent-log-agentG.jsonl');
  fs.writeFileSync(logPath, '');

  const { ws, sent } = makeFakeWs();
  attachPtySocket(ws, { agentName: 'agentG', socketPath, logPath });
  await sleep(30);

  assert.ok(sent.some((f) => f.type === 'error' && f.data.includes('agentG')));
  assert.strictEqual(ws.readyState, 3, 'ws should be closed after a missing-socket error');
});

test('attachPtySocket: tails new agent-log lines and emits output frames', async () => {
  const dataDir = mkTmpDir('attach-tail');
  const socketPath = path.join(dataDir, 'pty-agentH.sock');
  const logPath = path.join(dataDir, 'agent-log-agentH.jsonl');
  fs.writeFileSync(logPath, '');

  const srv = net.createServer(() => {});
  await new Promise((resolve) => srv.listen(socketPath, resolve));

  const { ws, sent } = makeFakeWs();
  attachPtySocket(ws, { agentName: 'agentH', socketPath, logPath });
  await sleep(80);

  fs.appendFileSync(logPath, JSON.stringify({ data: 'line one\r\n' }) + '\n');
  await sleep(150);

  srv.close();
  ws._emit('close');

  assert.ok(
    sent.some((f) => f.type === 'output' && f.data === 'line one\r\n'),
    `expected an output frame for the appended log line, got: ${JSON.stringify(sent)}`,
  );
});

test('attachPtySocket: emits an exit frame when the log records agent_exit', async () => {
  const dataDir = mkTmpDir('attach-exit');
  const socketPath = path.join(dataDir, 'pty-agentI.sock');
  const logPath = path.join(dataDir, 'agent-log-agentI.jsonl');
  fs.writeFileSync(logPath, '');

  const srv = net.createServer(() => {});
  await new Promise((resolve) => srv.listen(socketPath, resolve));

  const { ws, sent } = makeFakeWs();
  attachPtySocket(ws, { agentName: 'agentI', socketPath, logPath });
  await sleep(80);

  fs.appendFileSync(logPath, JSON.stringify({ event: 'agent_exit' }) + '\n');
  await sleep(150);

  srv.close();

  assert.ok(sent.some((f) => f.type === 'exit'), `expected an exit frame, got: ${JSON.stringify(sent)}`);
});

(async () => {
  console.log('\n[terminal-ws] PTY bridge tests (discoverPtySockets + attachPtySocket)');
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.stack || e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
