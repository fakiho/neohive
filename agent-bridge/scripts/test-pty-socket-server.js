'use strict';

// Tests for lib/pty-socket-server.js (Story 1.3).
// Uses a fake owner handle (records write/resize calls) and a real unix socket
// client — no PTY required.

const assert = require('assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startSocketServer } = require('../lib/pty-socket-server');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeOwner(socketPath) {
  const calls = { writes: [], resizes: [], exitFns: [] };
  return {
    handle: {
      agentName: 'testsock',
      socketPath,
      write: (d) => calls.writes.push(d),
      resize: (c, r) => calls.resizes.push([c, r]),
      isExited: () => false,
      onExit: (fn) => calls.exitFns.push(fn),
    },
    calls,
  };
}

function connectAndSend(socketPath, lines) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath, () => {
      c.write(lines.join(''));
    });
    c.on('error', reject);
    // give the server time to process, then resolve the socket for reuse
    setTimeout(() => resolve(c), 120);
  });
}

test('applies input and resize frames to the owner', async () => {
  const socketPath = path.join(os.tmpdir(), `pty-test-${process.pid}-a.sock`);
  const { handle, calls } = makeOwner(socketPath);
  const srv = startSocketServer(handle);
  await sleep(50);
  const c = await connectAndSend(socketPath, [
    JSON.stringify({ type: 'input', data: 'hello' }) + '\n',
    JSON.stringify({ type: 'resize', cols: 100, rows: 40 }) + '\n',
    JSON.stringify({ type: 'input', data: '\x03' }) + '\n',
  ]);
  await sleep(80);
  c.destroy();
  srv.close();
  assert.deepStrictEqual(calls.writes, ['hello', '\x03']);
  assert.deepStrictEqual(calls.resizes, [[100, 40]]);
});

test('ignores malformed lines and unknown frame types without crashing', async () => {
  const socketPath = path.join(os.tmpdir(), `pty-test-${process.pid}-b.sock`);
  const { handle, calls } = makeOwner(socketPath);
  const srv = startSocketServer(handle);
  await sleep(50);
  const c = await connectAndSend(socketPath, [
    'not json at all\n',
    '{bad json\n',
    JSON.stringify({ type: 'bogus', data: 'x' }) + '\n',
    JSON.stringify({ type: 'input', data: 'ok' }) + '\n',
  ]);
  await sleep(80);
  c.destroy();
  srv.close();
  assert.deepStrictEqual(calls.writes, ['ok']); // only the valid input applied
});

test('handles a frame split across two TCP chunks (partial line buffering)', async () => {
  const socketPath = path.join(os.tmpdir(), `pty-test-${process.pid}-c.sock`);
  const { handle, calls } = makeOwner(socketPath);
  const srv = startSocketServer(handle);
  await sleep(50);
  const full = JSON.stringify({ type: 'input', data: 'spanned' }) + '\n';
  const mid = Math.floor(full.length / 2);
  const c = net.createConnection(socketPath, () => {
    c.write(full.slice(0, mid));
    setTimeout(() => c.write(full.slice(mid)), 40);
  });
  await sleep(150);
  c.destroy();
  srv.close();
  assert.deepStrictEqual(calls.writes, ['spanned']);
});

test('last input connection wins (AD-3)', async () => {
  const socketPath = path.join(os.tmpdir(), `pty-test-${process.pid}-d.sock`);
  const { handle, calls } = makeOwner(socketPath);
  const srv = startSocketServer(handle);
  await sleep(50);
  // First client connects; second connects and becomes the active input owner.
  const c1 = net.createConnection(socketPath);
  await sleep(40);
  const c2 = net.createConnection(socketPath);
  await sleep(40);
  // Input from the OLD connection (c1) must be ignored; input from c2 applies.
  c1.write(JSON.stringify({ type: 'input', data: 'from-old' }) + '\n');
  c2.write(JSON.stringify({ type: 'input', data: 'from-new' }) + '\n');
  await sleep(100);
  c1.destroy(); c2.destroy();
  srv.close();
  assert.deepStrictEqual(calls.writes, ['from-new']);
});

test('unlinks the socket file on close', async () => {
  const socketPath = path.join(os.tmpdir(), `pty-test-${process.pid}-e.sock`);
  const { handle } = makeOwner(socketPath);
  const srv = startSocketServer(handle);
  await sleep(50);
  assert.ok(fs.existsSync(socketPath), 'socket should exist while listening');
  srv.close();
  await sleep(30);
  assert.ok(!fs.existsSync(socketPath), 'socket should be unlinked after close');
});

test('removes a stale socket file before listening', async () => {
  const socketPath = path.join(os.tmpdir(), `pty-test-${process.pid}-f.sock`);
  fs.writeFileSync(socketPath, ''); // simulate a stale leftover
  const { handle, calls } = makeOwner(socketPath);
  const srv = startSocketServer(handle);
  await sleep(50);
  const c = await connectAndSend(socketPath, [JSON.stringify({ type: 'input', data: 'ok' }) + '\n']);
  await sleep(60);
  c.destroy();
  srv.close();
  assert.deepStrictEqual(calls.writes, ['ok']);
});

(async () => {
  console.log('\n[pty-socket-server] Story 1.3 tests');
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
