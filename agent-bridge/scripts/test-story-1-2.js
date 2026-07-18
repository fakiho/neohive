#!/usr/bin/env node
'use strict';

// Story 1.2 focused tests — dashboard /api/inject through shared queue-first wake.
// Spawns an isolated dashboard (does not restart any live dashboard). NFR-9.
// Run: node scripts/test-story-1-2.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const packageDir = path.resolve(__dirname, '..');
const { directDeliver } = require('../lib/direct-delivery');
const { WAKE_SIGNAL, claimWake } = (() => {
  const tas = require('../lib/tmux-agent-state');
  const claims = require('../lib/wake-claims');
  return { WAKE_SIGNAL: tas.WAKE_SIGNAL, claimWake: claims.claimWake };
})();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeTmux(binDir, logFile) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/bin/sh
LOG=${JSON.stringify(logFile)}
echo "$@" >> "$LOG"
# Minimal stubs used by verifyPaneMapping / isPaneSafeToInject / send-keys
case "$1" in
  list-panes|list-windows)
    # Report a live pane owned by this test process so mapping can pass when seeded
    printf '%%1\\t%d\\tnode\\n' "$$"
    exit 0
    ;;
  capture-pane)
    # Empty quiet pane → safe to inject under current heuristics
    exit 0
    ;;
  display-message)
    printf '%%1\\n'
    exit 0
    ;;
  send-keys)
    exit 0
    ;;
  set-hook|new-window)
    exit 0
    ;;
esac
exit 0
`;
  const tmuxPath = path.join(binDir, 'tmux');
  fs.writeFileSync(tmuxPath, script);
  fs.chmodSync(tmuxPath, 0o755);
  return tmuxPath;
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Dashboard did not start')), 12000);
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        clearTimeout(timeout);
        resolve();
      });
      req.on('error', () => setTimeout(tryConnect, 100));
    };
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dashboard exited early (${code})`));
    });
    tryConnect();
  });
}

async function postInject(port, body, projectPath) {
  const qs = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
  const res = await fetch(`http://127.0.0.1:${port}/api/inject${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LTT-Request': '1' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function makeAgents(dataDir, name, overrides) {
  const entry = Object.assign({
    pid: process.pid,
    registered_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    tmux: null,
    listening_since: null,
  }, overrides || {});
  const agents = {};
  agents[name] = entry;
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify(agents, null, 2));
}

async function withDashboard(fn) {
  const projectDir = tmpDir('neohive-s12-proj-');
  const dataDir = path.join(projectDir, '.neohive');
  fs.mkdirSync(dataDir, { recursive: true });
  const binDir = path.join(projectDir, 'bin');
  const tmuxLog = path.join(projectDir, 'tmux.log');
  writeFakeTmux(binDir, tmuxLog);
  const port = 35000 + (process.pid % 1000) + Math.floor(Math.random() * 200);

  const child = spawn(process.execPath, ['dashboard.js'], {
    cwd: packageDir,
    env: Object.assign({}, process.env, {
      NEOHIVE_PORT: String(port),
      NEOHIVE_DATA_DIR: dataDir,
      NEOHIVE_PROJECT_ROOT: projectDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child, port);
    await fn({ port, projectDir, dataDir, tmuxLog });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('\nStory 1.2 — /api/inject queue-first + content-free wake');

  // ── Validation contract preserved ──────────────────────────────────────────

  await testAsync('validation: missing to/content still rejected', async () => {
    await withDashboard(async ({ port }) => {
      const r = await postInject(port, { content: 'x' });
      assert.ok(r.body.error, 'must return error');
      assert.ok(/Missing/i.test(r.body.error));
    });
  });

  await testAsync('validation: reserved from name still rejected', async () => {
    await withDashboard(async ({ port }) => {
      const r = await postInject(port, { to: 'Alice', content: 'hi', from: '__system__' });
      assert.ok(r.body.error, 'must return error for reserved from');
    });
  });

  // ── Queue-first for registered / non-tmux / dead PID ───────────────────────

  await testAsync('queues messages+history for registered non-tmux agent (alive)', async () => {
    await withDashboard(async ({ port, dataDir }) => {
      makeAgents(dataDir, 'Alice', { tmux: null });
      const secret = 'SECRET_PAYLOAD_ALIVE_' + Date.now();
      const r = await postInject(port, { to: 'Alice', content: secret, from: 'Ops' });
      assert.strictEqual(r.body.success, true, JSON.stringify(r.body));
      assert.ok(r.body.messageId, 'messageId required');
      const msgs = readJsonl(path.join(dataDir, 'messages.jsonl'));
      const hist = readJsonl(path.join(dataDir, 'history.jsonl'));
      assert.strictEqual(msgs.length, 1, 'exactly one messages.jsonl record');
      assert.strictEqual(hist.length, 1, 'exactly one history record');
      assert.strictEqual(msgs[0].content, secret);
      assert.strictEqual(msgs[0].from, 'Ops');
    });
  });

  await testAsync('queues for registered agent with dead PID (never delivery:none drop)', async () => {
    await withDashboard(async ({ port, dataDir }) => {
      makeAgents(dataDir, 'Alice', { pid: 999999, tmux: null });
      const secret = 'SECRET_PAYLOAD_DEAD_' + Date.now();
      const r = await postInject(port, { to: 'Alice', content: secret });
      assert.strictEqual(r.body.success, true, 'queue success required: ' + JSON.stringify(r.body));
      assert.ok(!r.body.error, 'must not error-drop');
      assert.notStrictEqual(r.body.delivery, 'none');
      const msgs = readJsonl(path.join(dataDir, 'messages.jsonl'));
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].content, secret);
    });
  });

  await testAsync('listening agent: content queued, zero pane keystrokes with content', async () => {
    await withDashboard(async ({ port, dataDir, tmuxLog }) => {
      makeAgents(dataDir, 'Alice', {
        listening_since: new Date().toISOString(),
        tmux: { mapped: true, pane_id: '%1', session_name: 't' },
      });
      const secret = 'SECRET_LISTENING_' + Date.now();
      const r = await postInject(port, { to: 'Alice', content: secret, from: 'Lead' });
      assert.strictEqual(r.body.success, true, JSON.stringify(r.body));
      const msgs = readJsonl(path.join(dataDir, 'messages.jsonl'));
      assert.strictEqual(msgs[0].content, secret);
      const log = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '';
      assert.ok(!log.includes(secret), 'message content must not reach tmux');
      assert.ok(!log.includes('Lead'), 'from must not reach tmux');
      assert.ok(!/reply via send_message/i.test(log), 'reply instruction must not reach tmux');
    });
  });

  // ── Mapped wakeable pane: queue + content-free wake only ───────────────────

  await testAsync('mapped pane: content always in messages.jsonl before any wake', async () => {
    await withDashboard(async ({ port, dataDir, tmuxLog }) => {
      makeAgents(dataDir, 'Alice', {
        pid: process.pid,
        tmux: { mapped: true, pane_id: '%1', session_name: 't' },
      });
      const secret = 'SECRET_MAPPED_' + Date.now();
      const r = await postInject(port, { to: 'Alice', content: secret, from: 'DashUser' });
      assert.strictEqual(r.body.success, true, JSON.stringify(r.body));
      const msgs = readJsonl(path.join(dataDir, 'messages.jsonl'));
      assert.ok(msgs.some((m) => m.content === secret), 'content must be queue-retrievable');
      const log = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '';
      assert.ok(!log.includes(secret), 'body.content must never reach send-keys');
      assert.ok(!log.includes('DashUser'), 'body.from must never reach send-keys');
      assert.ok(!/reply via send_message/i.test(log), 'generated reply instruction must never reach send-keys');
      // If any literal send-keys -l payload was sent, it must be only WAKE_SIGNAL
      const literalPayloads = log.split('\n')
        .filter((line) => line.includes('send-keys') && line.includes(' -l '))
        .map((line) => {
          const idx = line.indexOf(' -l ');
          return idx >= 0 ? line.slice(idx + 4) : '';
        });
      for (const payload of literalPayloads) {
        assert.strictEqual(payload, WAKE_SIGNAL, 'only fixed WAKE_SIGNAL may be sent literally');
      }
    });
  });

  await testAsync('response keeps success/messageId and adds wake metadata', async () => {
    await withDashboard(async ({ port, dataDir }) => {
      makeAgents(dataDir, 'Alice', { tmux: null });
      const r = await postInject(port, { to: 'Alice', content: 'hello' });
      assert.strictEqual(r.body.success, true);
      assert.ok(typeof r.body.messageId === 'string' && r.body.messageId.length > 0);
      assert.ok(['sent', 'coalesced', 'suppressed', 'failed'].includes(r.body.wake),
        'wake status required: ' + JSON.stringify(r.body));
    });
  });

  // ── Cross-process coalescing (dashboard + directDeliver) ───────────────────

  await testAsync('cross-process: pending claim coalesces dashboard wake; both msgs queued', async () => {
    await withDashboard(async ({ port, dataDir }) => {
      makeAgents(dataDir, 'Alice', {
        pid: process.pid,
        tmux: { mapped: true, pane_id: '%1', session_name: 't' },
      });
      // Pre-claim as if another process already owns the wake
      claimWake(dataDir, 'Alice', `${process.pid}:seed`);

      const a = 'MSG_A_' + Date.now();
      const b = 'MSG_B_' + Date.now();
      // Agent-path producer in this process
      await directDeliver({
        msgFile: path.join(dataDir, 'messages.jsonl'),
        histFile: path.join(dataDir, 'history.jsonl'),
        msg: { id: 'agent1', from: 'Bob', to: 'Alice', content: a, timestamp: new Date().toISOString() },
        dataDir,
        to: 'Alice',
      });
      const r = await postInject(port, { to: 'Alice', content: b, from: 'Ops' });
      assert.strictEqual(r.body.success, true, JSON.stringify(r.body));
      assert.strictEqual(r.body.wake, 'coalesced', 'dashboard wake must coalesce: ' + JSON.stringify(r.body));
      const msgs = readJsonl(path.join(dataDir, 'messages.jsonl'));
      assert.ok(msgs.some((m) => m.content === a));
      assert.ok(msgs.some((m) => m.content === b));
      assert.ok(msgs.length >= 2);
    });
  });

  // ── Broadcast / compatibility ──────────────────────────────────────────────

  await testAsync('broadcast __all__ remains queue-compatible without wake requirement', async () => {
    await withDashboard(async ({ port, dataDir }) => {
      const r = await postInject(port, { to: '__all__', content: 'broadcast-hi' });
      assert.strictEqual(r.body.success, true);
      assert.strictEqual(r.body.broadcast, true);
      const msgs = readJsonl(path.join(dataDir, 'messages.jsonl'));
      assert.strictEqual(msgs[0].to, '__group__');
      assert.ok(!('wake' in r.body) || r.body.wake === undefined);
    });
  });

  // ── Export surface: no arbitrary-content delivery API ──────────────────────

  console.log('\nsendKeysToPane export surface (review blocker)');

  test('sendKeysToPane is not exported for arbitrary delivery content', () => {
    const tas = require('../lib/tmux-agent-state');
    assert.strictEqual(
      typeof tas.sendKeysToPane,
      'undefined',
      'sendKeysToPane must not remain a public arbitrary-text delivery export after Story 1.2'
    );
  });

  test('dashboard.js source does not call sendKeysToPane with inject content', () => {
    const src = fs.readFileSync(path.join(packageDir, 'dashboard.js'), 'utf8');
    // Narrow check: the inject path must not invoke sendKeysToPane
    assert.ok(
      !/apiInjectMessage[\s\S]*?sendKeysToPane/.test(src) && !/sendKeysToPane\(targetTmux/.test(src),
      'apiInjectMessage must not call sendKeysToPane'
    );
    assert.ok(
      !/reply via send_message\(to=/.test(src),
      'dashboard must not synthesize reply-instruction pane text for inject'
    );
  });

  test('dashboard.js routes direct inject through directDeliver', () => {
    const src = fs.readFileSync(path.join(packageDir, 'dashboard.js'), 'utf8');
    assert.ok(/directDeliver/.test(src), 'dashboard.js must call directDeliver');
    assert.ok(/require\(['"]\.\/lib\/direct-delivery['"]\)/.test(src)
      || /require\(['"]\.\/lib\/direct-delivery\.js['"]\)/.test(src),
      'dashboard.js must require lib/direct-delivery');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
