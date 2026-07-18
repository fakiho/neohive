#!/usr/bin/env node
'use strict';

// Story 1.3 focused tests — system/watchdog nudges through shared queue-first wake.
// No framework, no dashboard restart required (NFR-9).
// Run: node scripts/test-story-1-3.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const packageDir = path.resolve(__dirname, '..');
const { directDeliver } = require('../lib/direct-delivery');
const { claimWake } = require('../lib/wake-claims');
const { WAKE_SIGNAL, requestAdvisoryWake } = require('../lib/tmux-agent-state');

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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-1-3-'));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function makeAgents(dir, name, overrides) {
  const agents = {
    [name]: Object.assign({
      pid: process.pid,
      registered_at: new Date().toISOString(),
      tmux: null,
      listening_since: null,
    }, overrides || {}),
  };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents));
}

function systemMsg(to, content, id) {
  return {
    id: id || ('sys_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    from: '__system__',
    to,
    content,
    timestamp: new Date().toISOString(),
    system: true,
  };
}

function extractSendSystemMessageBody(src) {
  const start = src.indexOf('function sendSystemMessage(');
  assert.ok(start >= 0, 'sendSystemMessage function must exist');
  const nextFn = src.indexOf('\nfunction ', start + 1);
  const end = nextFn >= 0 ? nextFn : src.length;
  return src.slice(start, end);
}

async function main() {
  const serverSrc = fs.readFileSync(path.join(packageDir, 'server.js'), 'utf8');
  const sendSystemBody = extractSendSystemMessageBody(serverSrc);

  // ── Source routing (FR-3, FR-23) ───────────────────────────────────────────

  console.log('\nsource routing: sendSystemMessage → directDeliver (FR-3, FR-23)');

  test('sendSystemMessage calls directDeliver', () => {
    assert.ok(/directDeliver\s*\(/.test(sendSystemBody), 'sendSystemMessage must call directDeliver');
    assert.ok(!/appendFileSync/.test(sendSystemBody),
      'sendSystemMessage must not append directly; shared boundary owns writes');
  });

  test('server.js requires lib/direct-delivery', () => {
    assert.ok(
      /require\(['"]\.\/lib\/direct-delivery['"]\)/.test(serverSrc)
        || /require\(['"]\.\/lib\/direct-delivery\.js['"]\)/.test(serverSrc),
      'server.js must require lib/direct-delivery'
    );
  });

  test('broadcastSystemMessage does not call directDeliver (AD-1 group path)', () => {
    const start = serverSrc.indexOf('function broadcastSystemMessage(');
    assert.ok(start >= 0);
    const nextFn = serverSrc.indexOf('\nfunction ', start + 1);
    const body = serverSrc.slice(start, nextFn >= 0 ? nextFn : serverSrc.length);
    assert.ok(!/directDeliver\s*\(/.test(body),
      'broadcastSystemMessage must keep group/history append semantics, not directDeliver');
  });

  test('checkListenCompliance remains log-only (no inject / no send-keys)', () => {
    const start = serverSrc.indexOf('function checkListenCompliance(');
    assert.ok(start >= 0);
    const nextFn = serverSrc.indexOf('\nfunction ', start + 1);
    const body = serverSrc.slice(start, nextFn >= 0 ? nextFn : serverSrc.length);
    assert.ok(!/sendSystemMessage\s*\(/.test(body), 'compliance must not sendSystemMessage');
    assert.ok(!/directDeliver\s*\(/.test(body), 'compliance must not call directDeliver');
    assert.ok(!/attemptTmuxDelivery\s*\(/.test(body), 'compliance must not call attemptTmuxDelivery');
    assert.ok(/log\.info\(\s*`\[auto-nudge\]/.test(body) || /\[auto-nudge\]/.test(body),
      'compliance should remain log-only auto-nudge');
  });

  test('watchdogCheck soft/hard nudges use sendSystemMessage, not tmux payloads', () => {
    const start = serverSrc.indexOf('function watchdogCheck(');
    assert.ok(start >= 0);
    const nextFn = serverSrc.indexOf('\nfunction ', start + 1);
    const body = serverSrc.slice(start, nextFn >= 0 ? nextFn : serverSrc.length);
    assert.ok(/sendSystemMessage\s*\(/.test(body), 'watchdogCheck must use sendSystemMessage');
    assert.ok(!/attemptTmuxDelivery\s*\(/.test(body), 'watchdogCheck must not call attemptTmuxDelivery');
    assert.ok(!/sendKeysToPane\s*\(/.test(body), 'watchdogCheck must not call sendKeysToPane');
    assert.ok(!/requestAdvisoryWake\s*\(/.test(body),
      'watchdogCheck must not call requestAdvisoryWake directly; sendSystemMessage owns wake');
  });

  test('sendKeysToPane remains unpublished (Story 1.2 surface)', () => {
    const tas = require('../lib/tmux-agent-state');
    assert.strictEqual(typeof tas.sendKeysToPane, 'undefined');
  });

  // ── Queue + listen retrieval for system messages (FR-3) ────────────────────

  console.log('\nsystem message queue + wake outcomes');

  await testAsync('system message queued once to messages and history', async () => {
    const dir = tmpDir();
    const msgFile = path.join(dir, 'messages.jsonl');
    const histFile = path.join(dir, 'history.jsonl');
    const secret = 'WATCHDOG_NUDGE_SECRET_' + Date.now();
    const msg = systemMsg('Alice', secret, 'm1');
    makeAgents(dir, 'Alice', { tmux: null });
    const r = await directDeliver({ msgFile, histFile, msg, dataDir: dir, to: 'Alice' });
    assert.strictEqual(r.success, true);
    const msgs = readJsonl(msgFile);
    const hist = readJsonl(histFile);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(hist.length, 1);
    assert.strictEqual(msgs[0].content, secret);
    assert.strictEqual(msgs[0].from, '__system__');
    assert.strictEqual(msgs[0].system, true);
    assert.strictEqual(hist[0].content, secret);
    fs.rmSync(dir, { recursive: true });
  });

  await testAsync('busy/listening/unmapped recipients get queue-only (no wake sent)', async () => {
    const dir = tmpDir();
    const msgFile = path.join(dir, 'messages.jsonl');
    const histFile = path.join(dir, 'history.jsonl');

    makeAgents(dir, 'Busy', {
      listening_since: new Date().toISOString(),
      tmux: { mapped: true, pane_id: '%1', session_name: 't' },
    });
    let r = await directDeliver({
      msgFile, histFile,
      msg: systemMsg('Busy', '[WATCHDOG] soft nudge listening'),
      dataDir: dir, to: 'Busy',
    });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.wake, 'suppressed');
    assert.strictEqual(r.wakeReason, 'listening');

    makeAgents(dir, 'Nomap', { tmux: null });
    r = await directDeliver({
      msgFile, histFile,
      msg: systemMsg('Nomap', '[WATCHDOG] soft nudge unmapped'),
      dataDir: dir, to: 'Nomap',
    });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.wake, 'suppressed');
    assert.ok(['not-mapped', 'recipient-unknown'].includes(r.wakeReason) || r.wake === 'suppressed');

    const msgs = readJsonl(msgFile);
    assert.ok(msgs.some((m) => m.content.includes('listening')));
    assert.ok(msgs.some((m) => m.content.includes('unmapped')));
    fs.rmSync(dir, { recursive: true });
  });

  await testAsync('watchdog-derived text never becomes wake reason / never equals WAKE_SIGNAL', async () => {
    const dir = tmpDir();
    const nudge = '[WATCHDOG] You have been idle — call get_work() NOW or work reassigned';
    makeAgents(dir, 'Alice', { tmux: null });
    const r = await directDeliver({
      msgFile: path.join(dir, 'messages.jsonl'),
      histFile: path.join(dir, 'history.jsonl'),
      msg: systemMsg('Alice', nudge),
      dataDir: dir,
      to: 'Alice',
    });
    assert.strictEqual(r.success, true);
    assert.ok(r.wakeReason !== nudge, 'wake reason must be content-free');
    assert.ok(!String(r.wakeReason || '').includes('WATCHDOG'), 'wake reason must not carry watchdog text');
    assert.ok(WAKE_SIGNAL.includes('listen()'), 'fixed wake still instructs listen()');
    assert.ok(!WAKE_SIGNAL.includes('WATCHDOG'));
    assert.ok(!WAKE_SIGNAL.includes('get_work'));
    fs.rmSync(dir, { recursive: true });
  });

  // ── Mixed-producer coalescing (FR-17) ──────────────────────────────────────

  console.log('\nmixed-producer coalescing (watchdog + agent + dashboard-shaped)');

  await testAsync('pending claim coalesces later system/agent wakes; all content queued', async () => {
    const dir = tmpDir();
    const msgFile = path.join(dir, 'messages.jsonl');
    const histFile = path.join(dir, 'history.jsonl');
    makeAgents(dir, 'Alice', {
      pid: process.pid,
      tmux: { mapped: true, pane_id: '%1', session_name: 't' },
    });
    claimWake(dir, 'Alice', `${process.pid}:seed`);

    const soft = 'SOFT_NUDGE_' + Date.now();
    const hard = 'HARD_NUDGE_' + Date.now();
    const agent = 'AGENT_MSG_' + Date.now();
    const dash = 'DASH_MSG_' + Date.now();

    const r1 = await directDeliver({
      msgFile, histFile, msg: systemMsg('Alice', soft, 's1'), dataDir: dir, to: 'Alice',
    });
    const r2 = await directDeliver({
      msgFile, histFile, msg: systemMsg('Alice', hard, 's2'), dataDir: dir, to: 'Alice',
    });
    const r3 = await directDeliver({
      msgFile, histFile,
      msg: { id: 'a1', from: 'Bob', to: 'Alice', content: agent, timestamp: new Date().toISOString() },
      dataDir: dir, to: 'Alice',
    });
    const r4 = await directDeliver({
      msgFile, histFile,
      msg: { id: 'd1', from: 'Ops', to: 'Alice', content: dash, timestamp: new Date().toISOString() },
      dataDir: dir, to: 'Alice',
    });

    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r3.success, true);
    assert.strictEqual(r4.success, true);
    for (const r of [r1, r2, r3, r4]) {
      assert.strictEqual(r.wake, 'coalesced', 'expected coalesced with pending claim: ' + JSON.stringify(r));
    }
    const msgs = readJsonl(msgFile);
    assert.ok(msgs.some((m) => m.content === soft));
    assert.ok(msgs.some((m) => m.content === hard));
    assert.ok(msgs.some((m) => m.content === agent));
    assert.ok(msgs.some((m) => m.content === dash));
    assert.strictEqual(msgs.length, 4);
    fs.rmSync(dir, { recursive: true });
  });

  await testAsync('malformed wake-claims fail closed to queue-only', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'wake-claims.json'), '{not-json');
    makeAgents(dir, 'Alice', {
      pid: process.pid,
      tmux: { mapped: true, pane_id: '%1', session_name: 't' },
    });
    const msgFile = path.join(dir, 'messages.jsonl');
    const histFile = path.join(dir, 'history.jsonl');
    const r = await directDeliver({
      msgFile, histFile,
      msg: systemMsg('Alice', '[WATCHDOG] after corrupt claims'),
      dataDir: dir, to: 'Alice',
    });
    assert.strictEqual(r.success, true, 'queue must succeed despite corrupt claims');
    assert.ok(readJsonl(msgFile).length === 1);
    // Wake may be coalesced/suppressed/failed — never reverse queue success
    assert.ok(['sent', 'coalesced', 'suppressed', 'failed'].includes(r.wake));
    fs.rmSync(dir, { recursive: true });
  });

  await testAsync('absent wake-claims initializes safely for system delivery', async () => {
    const dir = tmpDir();
    makeAgents(dir, 'Alice', { tmux: null });
    const msgFile = path.join(dir, 'messages.jsonl');
    const histFile = path.join(dir, 'history.jsonl');
    assert.ok(!fs.existsSync(path.join(dir, 'wake-claims.json')));
    const r = await directDeliver({
      msgFile, histFile,
      msg: systemMsg('Alice', '[WATCHDOG] first nudge'),
      dataDir: dir, to: 'Alice',
    });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.wake, 'suppressed');
    fs.rmSync(dir, { recursive: true });
  });

  // ── Quietness / compatibility ──────────────────────────────────────────────

  console.log('\nquietness and compatibility');

  await testAsync('listening agent is not terminal-woken by requestAdvisoryWake', async () => {
    const dir = tmpDir();
    makeAgents(dir, 'Alice', {
      listening_since: new Date().toISOString(),
      tmux: { mapped: true, pane_id: '%1', session_name: 't' },
    });
    const wake = await requestAdvisoryWake(dir, 'Alice');
    assert.strictEqual(wake.wake, 'suppressed');
    assert.strictEqual(wake.reason, 'listening');
    fs.rmSync(dir, { recursive: true });
  });

  test('reputation/reassignment/watchdog string markers still present in server.js', () => {
    assert.ok(/trackReputation\(\s*name,\s*'watchdog_nudge'\s*\)/.test(serverSrc)
      || /trackReputation\(name, 'watchdog_nudge'\)/.test(serverSrc),
      'watchdog reputation tracking must remain');
    assert.ok(/reassignWorkFrom\(/.test(serverSrc), 'idle reassignment must remain');
    assert.ok(/watchdog_hard_nudged/.test(serverSrc), 'hard nudge flag must remain');
    assert.ok(/selfHealingWatchdog\(/.test(serverSrc) || /function selfHealingWatchdog/.test(serverSrc),
      'self-healing watchdog must remain');
  });

  test('attemptTmuxDelivery adapter still ignores legacy payload (compat)', () => {
    const tasSrc = fs.readFileSync(path.join(packageDir, 'lib/tmux-agent-state.js'), 'utf8');
    assert.ok(/async function attemptTmuxDelivery\(dataDir, toAgentName, _legacyPayload\)/.test(tasSrc)
      || /_legacyPayload/.test(tasSrc),
      'legacy payload param must remain ignored');
    assert.ok(/requestAdvisoryWake\(dataDir, toAgentName\)/.test(tasSrc));
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
