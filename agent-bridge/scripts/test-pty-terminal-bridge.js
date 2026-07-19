'use strict';

// Tests for lib/terminal-ws.js: discoverPtySockets + attachPtySocket (Story 1.3).
// Uses a fake unix socket server (no node-pty) and a fake WebSocket stub.

const assert = require('assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverPtySockets, attachPtySocket, replayAgentLog } = require('../lib/terminal-ws');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Minimal fake WebSocket that records sent messages.
function makeWs() {
  const sent = [];
  const handlers = {};
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(raw) { sent.push(JSON.parse(raw)); },
    on(evt, fn) { handlers[evt] = fn; },
    _emit(evt, ...args) { if (handlers[evt]) handlers[evt](...args); },
    close() { this._emit('close'); },
  };
}

// Make a temp dataDir with an agents.json and optional sock file.
function makeDataDir(agentName, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-bridge-test-'));
  const agents = {};
  if (opts.register !== false) {
    agents[agentName] = {
      pid: opts.cli_pid || process.pid,
      last_activity: new Date().toISOString(),
      pty_owner: opts.pty_owner !== false,
      pty_owner_pid: opts.owner_pid !== undefined ? opts.owner_pid : process.pid,
    };
  }
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents));
  if (opts.createSock) {
    // Create an empty placeholder — discoverPtySockets checks the file exists
    fs.writeFileSync(path.join(dir, `pty-${agentName}.sock`), '');
  }
  return dir;
}

// Start a real unix server that accepts one connection and records received lines.
function startFakeServer(sockPath) {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          received.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
      });
    });
    server.listen(sockPath, () => resolve({ server, received }));
  });
}

// ============================================================
// discoverPtySockets tests
// ============================================================

test('(a) live sock + live PID → map includes agent', async () => {
  const agentName = 'livesock';
  const dir = makeDataDir(agentName, { createSock: true });
  // owner_pid defaults to process.pid — definitely alive
  const map = discoverPtySockets(dir);
  assert.ok(map.has(agentName), `expected "${agentName}" in live map`);
  assert.strictEqual(map.get(agentName), path.join(dir, `pty-${agentName}.sock`));
  fs.rmSync(dir, { recursive: true });
});

test('(b1) dead owner PID → skipped', async () => {
  const agentName = 'deadsock';
  // Use PID 1 — exists but we can't signal it (EPERM), or use a definitely-dead PID.
  // Find a dead PID: start and immediately kill a child.
  const { spawnSync } = require('child_process');
  const { pid } = require('child_process').spawn('true', [], { detached: true });
  await sleep(50); // let it exit
  const dir = makeDataDir(agentName, { createSock: true, owner_pid: pid });
  const map = discoverPtySockets(dir);
  assert.ok(!map.has(agentName), 'dead-PID agent must not appear in live map');
  fs.rmSync(dir, { recursive: true });
});

test('(b2) no pty_owner flag → skipped', async () => {
  const agentName = 'noflag';
  const dir = makeDataDir(agentName, { createSock: true, pty_owner: false });
  const map = discoverPtySockets(dir);
  assert.ok(!map.has(agentName), 'agent without pty_owner flag must be skipped');
  fs.rmSync(dir, { recursive: true });
});

test('(b3) sock file absent → not in map', async () => {
  const agentName = 'nosock';
  // Registered + alive PID but no .sock file
  const dir = makeDataDir(agentName, { createSock: false });
  const map = discoverPtySockets(dir);
  assert.ok(!map.has(agentName), 'absent sock file must not appear in live map');
  fs.rmSync(dir, { recursive: true });
});

test('(b4) not registered in agents.json → skipped', async () => {
  const agentName = 'unregistered';
  const dir = makeDataDir(agentName, { register: false, createSock: true });
  const map = discoverPtySockets(dir);
  assert.ok(!map.has(agentName), 'unregistered agent must be skipped');
  fs.rmSync(dir, { recursive: true });
});

test('empty dataDir returns empty map', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-empty-'));
  const map = discoverPtySockets(dir);
  assert.strictEqual(map.size, 0);
  fs.rmSync(dir, { recursive: true });
});

// ============================================================
// attachPtySocket tests
// ============================================================

test('(c) input frame forwarded as NDJSON to unix socket', async () => {
  const agentName = 'input-test';
  const sockPath = path.join(os.tmpdir(), `nh-bridge-input-${process.pid}.sock`);
  const logPath = path.join(os.tmpdir(), `nh-bridge-log-${process.pid}.jsonl`);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  fs.writeFileSync(logPath, '');

  const { server, received } = await startFakeServer(sockPath);
  const ws = makeWs();

  attachPtySocket(ws, { agentName, socketPath: sockPath, logPath });
  await sleep(80); // wait for connect

  ws._emit('message', JSON.stringify({ type: 'input', data: 'hello' }));
  await sleep(40);

  server.close();
  ws._emit('close');
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(logPath); } catch {}

  const inputFrames = received.filter((f) => f.type === 'input');
  assert.ok(inputFrames.length > 0, 'no input frames received by fake server');
  assert.strictEqual(inputFrames[0].data, 'hello');
});

test('(c) resize frame forwarded as NDJSON to unix socket', async () => {
  const agentName = 'resize-test';
  const sockPath = path.join(os.tmpdir(), `nh-bridge-resize-${process.pid}.sock`);
  const logPath = path.join(os.tmpdir(), `nh-bridge-log2-${process.pid}.jsonl`);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  fs.writeFileSync(logPath, '');

  const { server, received } = await startFakeServer(sockPath);
  const ws = makeWs();

  attachPtySocket(ws, { agentName, socketPath: sockPath, logPath });
  await sleep(80);

  ws._emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
  await sleep(40);

  server.close();
  ws._emit('close');
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(logPath); } catch {}

  const resizeFrames = received.filter((f) => f.type === 'resize');
  assert.ok(resizeFrames.length > 0, 'no resize frames received by fake server');
  // On connect a nudge resize (80x24) is sent first; the browser's 120x30 follows.
  const browserResize = resizeFrames.find((f) => f.cols === 120 && f.rows === 30);
  assert.ok(browserResize, 'browser resize frame (120x30) not found');
  assert.strictEqual(browserResize.cols, 120);
  assert.strictEqual(browserResize.rows, 30);
});

test('(d) log tail emits output frames to WebSocket', async () => {
  const agentName = 'log-tail';
  const sockPath = path.join(os.tmpdir(), `nh-bridge-logsock-${process.pid}.sock`);
  const logPath = path.join(os.tmpdir(), `nh-bridge-logfile-${process.pid}.jsonl`);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  // Pre-create empty log so attachPtySocket seeds offset at EOF
  fs.writeFileSync(logPath, '');

  const { server } = await startFakeServer(sockPath);
  const ws = makeWs();

  attachPtySocket(ws, { agentName, socketPath: sockPath, logPath });
  await sleep(80); // wait for connect + watcher

  // Write a data chunk to the log — watcher should fire drainLog
  const entry = JSON.stringify({ ts: new Date().toISOString(), agent: agentName, data: 'hello world\r\n' }) + '\n';
  fs.appendFileSync(logPath, entry);
  await sleep(100); // give watcher time to fire

  server.close();
  ws._emit('close');
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(logPath); } catch {}

  const outputFrames = ws.sent.filter((f) => f.type === 'output' && f.data === 'hello world\r\n');
  assert.ok(outputFrames.length > 0, 'log tail did not emit output frame to WebSocket');
});

test('(d) agent_exit marker emits exit frame', async () => {
  const agentName = 'exit-test';
  const sockPath = path.join(os.tmpdir(), `nh-bridge-exitsock-${process.pid}.sock`);
  const logPath = path.join(os.tmpdir(), `nh-bridge-exitlog-${process.pid}.jsonl`);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  fs.writeFileSync(logPath, '');

  const { server } = await startFakeServer(sockPath);
  const ws = makeWs();

  attachPtySocket(ws, { agentName, socketPath: sockPath, logPath });
  await sleep(80);

  const exitEntry = JSON.stringify({ ts: new Date().toISOString(), agent: agentName, event: 'agent_exit', exitCode: 0, signal: null }) + '\n';
  fs.appendFileSync(logPath, exitEntry);
  await sleep(100);

  server.close();
  ws._emit('close');
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(logPath); } catch {}

  const exitFrames = ws.sent.filter((f) => f.type === 'exit');
  assert.ok(exitFrames.length > 0, 'agent_exit marker did not emit exit frame to WebSocket');
});

// ============================================================
// replayAgentLog + scrollback replay tests
// ============================================================

test('(e) replayAgentLog sends existing data entries to ws', async () => {
  const logPath = path.join(os.tmpdir(), `nh-replay-log-${process.pid}.jsonl`);
  const ws = makeWs();
  const lines = [
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', data: 'line one\r\n' }),
    JSON.stringify({ ts: '2026-01-01T00:00:01Z', data: 'line two\r\n' }),
    JSON.stringify({ ts: '2026-01-01T00:00:02Z', event: 'agent_exit' }), // should be skipped
  ].join('\n') + '\n';
  fs.writeFileSync(logPath, lines);

  const offset = replayAgentLog(ws, logPath);
  try { fs.unlinkSync(logPath); } catch {}

  assert.strictEqual(offset, Buffer.byteLength(lines), 'offset should equal file size after replay');
  const outputFrames = ws.sent.filter((f) => f.type === 'output');
  assert.strictEqual(outputFrames.length, 2, 'expected 2 output frames (data entries only)');
  assert.strictEqual(outputFrames[0].data, 'line one\r\n');
  assert.strictEqual(outputFrames[1].data, 'line two\r\n');
  assert.ok(!ws.sent.some((f) => f.type === 'exit'), 'agent_exit must be skipped during replay');
});

test('(e) replayAgentLog on empty file returns 0 and sends nothing', async () => {
  const logPath = path.join(os.tmpdir(), `nh-replay-empty-${process.pid}.jsonl`);
  fs.writeFileSync(logPath, '');
  const ws = makeWs();

  const offset = replayAgentLog(ws, logPath);
  try { fs.unlinkSync(logPath); } catch {}

  assert.strictEqual(offset, 0);
  assert.strictEqual(ws.sent.length, 0, 'empty log must send no frames');
});

test('(e) replayAgentLog skips truncated first line when reading mid-file', async () => {
  const logPath = path.join(os.tmpdir(), `nh-replay-trunc-${process.pid}.jsonl`);
  // Build a file large enough that REPLAY_BYTES slices mid-line
  const padding = 'x'.repeat(51200); // > 50 KB
  const lines = JSON.stringify({ data: padding }) + '\n' +
    JSON.stringify({ data: 'visible\r\n' }) + '\n';
  fs.writeFileSync(logPath, lines);
  const ws = makeWs();

  replayAgentLog(ws, logPath);
  try { fs.unlinkSync(logPath); } catch {}

  // The first line is truncated — only 'visible' should appear
  const out = ws.sent.filter((f) => f.type === 'output').map((f) => f.data);
  assert.ok(out.includes('visible\r\n'), 'last complete line must be replayed');
  assert.ok(!out.includes(padding), 'truncated first line must be skipped');
});

test('(f) attachPtySocket replays existing log on attach', async () => {
  const agentName = 'replay-attach';
  const sockPath = path.join(os.tmpdir(), `nh-replay-sock-${process.pid}.sock`);
  const logPath = path.join(os.tmpdir(), `nh-replay-attach-${process.pid}.jsonl`);
  const preExisting = JSON.stringify({ data: 'scrollback line\r\n' }) + '\n';
  fs.writeFileSync(logPath, preExisting);

  const { server } = await startFakeServer(sockPath);
  const ws = makeWs();

  attachPtySocket(ws, { agentName, socketPath: sockPath, logPath });
  await sleep(80);

  server.close();
  ws._emit('close');
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(logPath); } catch {}

  const scrollback = ws.sent.filter((f) => f.type === 'output' && f.data === 'scrollback line\r\n');
  assert.ok(scrollback.length > 0, 'pre-existing log must be replayed on attach');
});

test('(g) resize nudge sent to socket on connect (before browser resize)', async () => {
  const agentName = 'nudge-test';
  const sockPath = path.join(os.tmpdir(), `nh-nudge-sock-${process.pid}.sock`);
  const logPath = path.join(os.tmpdir(), `nh-nudge-log-${process.pid}.jsonl`);
  fs.writeFileSync(logPath, '');

  const { server, received } = await startFakeServer(sockPath);
  const ws = makeWs();

  attachPtySocket(ws, { agentName, socketPath: sockPath, logPath });
  await sleep(80); // wait for connect only — no browser resize sent

  server.close();
  ws._emit('close');
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(logPath); } catch {}

  const resizeFrames = received.filter((f) => f.type === 'resize');
  assert.ok(resizeFrames.length > 0, 'resize nudge must be sent on connect even without browser resize');
  assert.ok(Number.isInteger(resizeFrames[0].cols) && resizeFrames[0].cols > 0, 'nudge cols must be positive integer');
  assert.ok(Number.isInteger(resizeFrames[0].rows) && resizeFrames[0].rows > 0, 'nudge rows must be positive integer');
});

test('attachPtySocket sends error when socket file absent', async () => {
  const logPath = path.join(os.tmpdir(), `nh-bridge-nolog-${process.pid}.jsonl`);
  fs.writeFileSync(logPath, '');
  const ws = makeWs();

  attachPtySocket(ws, {
    agentName: 'noagent',
    socketPath: '/tmp/definitely-does-not-exist-nh.sock',
    logPath,
  });
  await sleep(30);
  try { fs.unlinkSync(logPath); } catch {}

  const errorFrames = ws.sent.filter((f) => f.type === 'error');
  assert.ok(errorFrames.length > 0, 'expected an error frame when socket file is absent');
});

// ============================================================

(async () => {
  console.log('\n[pty-terminal-bridge] Story 1.3 bridge tests');
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
