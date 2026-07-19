#!/usr/bin/env node
'use strict';

// Focused tests for Story 1.4: Retarget SSE routing + unrouted-reply
// detector to the PTY log stream. Governs FR-4, FR-5, FR-6; NFR-2; AD-2.
// See _bmad-output/planning-artifacts/epics-node-pty-launcher.md.
//
// Run: node scripts/test-pty-log-routing.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log('  PASS:', name); passed++; }
  catch (e) { console.error('  FAIL:', name); console.error('   ', e.message); failed++; }
}

const packageDir = path.resolve(__dirname, '..');

// --- 1. Static source contract: fast path bypasses the 2s general debounce (NFR-2) ---
console.log('\n[1] dashboard.js — fast agent-log path bypasses the general debounce (NFR-2)');
{
  const src = fs.readFileSync(path.join(packageDir, 'dashboard.js'), 'utf8');
  assert(src.includes("filename.startsWith('agent-log-')"), 'watcher recognizes agent-log-*.jsonl filenames');
  assert(/tailAgentLogAndPublish\(dataDir, filename\)/.test(src), 'fast path calls tailAgentLogAndPublish directly');
  const idx = src.indexOf("filename.startsWith('agent-log-')");
  const window = src.slice(idx, idx + 300);
  assert(/return;/.test(window), 'fast path returns immediately, bypassing pendingChangeTypes/debounce');
  assert(src.includes('AGENT_OUTPUT_RING_BUFFER_MAX_BYTES = 1024 * 1024'), 'ring buffer capped at 1MB (FR-6)');
  assert(src.includes("event: agent_output"), 'publishes agent_output SSE event type (FR-4)');
  assert(src.includes('backfillAgentOutputRingBuffers'), 'new SSE connections get backfilled from the ring buffer (FR-6)');
}

// --- 2. Runtime: SSE agent_output events + ring-buffer backfill for late joiners ---
async function testSseRouting() {
  console.log('\n[2] Runtime: agent_output SSE events + ring-buffer backfill');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-pty-sse-'));
  const port = 39100 + Math.floor(Math.random() * 800);

  process.env.NEOHIVE_DATA_DIR = testDir;
  process.env.NEOHIVE_PORT = String(port);
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge'))) delete require.cache[k];
  }
  require('../dashboard.js');
  await new Promise((r) => setTimeout(r, 800));

  function openSse() {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost', port, path: '/api/events', method: 'GET',
        headers: { 'X-LTT-Request': '1' },
      }, (res) => {
        const events = [];
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            const evMatch = /^event: (.+)$/m.exec(part);
            const dataMatch = /^data: (.+)$/m.exec(part);
            if (dataMatch) events.push({ event: evMatch ? evMatch[1] : 'message', data: dataMatch[1] });
          }
        });
        resolve({ req, res, events });
      });
      req.on('error', reject);
      req.end();
    });
  }

  await testAsync('a live SSE client receives an agent_output event shortly after the log file is written', async () => {
    const client = await openSse();
    await new Promise((r) => setTimeout(r, 200)); // let the connection settle
    const logPath = path.join(testDir, 'agent-log-LiveAgent.jsonl');
    fs.writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'LiveAgent', data: 'hello-from-live-agent\n' }) + '\n');

    const deadline = Date.now() + 3000;
    let found = false;
    while (Date.now() < deadline && !found) {
      await new Promise((r) => setTimeout(r, 50));
      found = client.events.some((e) => e.event === 'agent_output' && e.data.includes('hello-from-live-agent'));
    }
    client.res.destroy();
    if (!found) throw new Error('agent_output event never arrived: ' + JSON.stringify(client.events));
  });

  await testAsync('a late-joining SSE client is immediately backfilled from the ring buffer (FR-6)', async () => {
    // The previous test already wrote LiveAgent's log and it should now be in
    // the in-memory ring buffer. A brand-new connection should see it without
    // any further writes.
    const client = await openSse();
    await new Promise((r) => setTimeout(r, 300));
    const gotBackfill = client.events.some((e) => e.event === 'agent_output' && e.data.includes('hello-from-live-agent'));
    client.res.destroy();
    if (!gotBackfill) throw new Error('late joiner was not backfilled: ' + JSON.stringify(client.events));
  });

  await testAsync('agent_exit marker is routed as a normal agent_output event too (dashboard can react to it)', async () => {
    const client = await openSse();
    await new Promise((r) => setTimeout(r, 200));
    const logPath = path.join(testDir, 'agent-log-ExitAgent.jsonl');
    fs.writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'ExitAgent', event: 'agent_exit', exitCode: 0, signal: null }) + '\n');
    const deadline = Date.now() + 3000;
    let found = false;
    while (Date.now() < deadline && !found) {
      await new Promise((r) => setTimeout(r, 50));
      found = client.events.some((e) => e.event === 'agent_output' && e.data.includes('agent_exit'));
    }
    client.res.destroy();
    if (!found) throw new Error('agent_exit event never arrived: ' + JSON.stringify(client.events));
  });

  await testAsync('ring buffer stays bounded (does not grow unbounded past 1MB per agent)', async () => {
    const bigChunk = 'x'.repeat(50000);
    const logPath = path.join(testDir, 'agent-log-BigAgent.jsonl');
    // Write ~30 chunks of 50KB = ~1.5MB total, well past the 1MB cap.
    for (let i = 0; i < 30; i++) {
      fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'BigAgent', data: bigChunk }) + '\n');
    }
    // Give the fs.watch callback time to process (may batch multiple appendFileSync calls).
    await new Promise((r) => setTimeout(r, 1000));
    const client = await openSse();
    await new Promise((r) => setTimeout(r, 500));
    const bigAgentEvents = client.events.filter((e) => e.event === 'agent_output' && e.data.includes('"agent":"BigAgent"'));
    client.res.destroy();
    const totalBytes = bigAgentEvents.reduce((sum, e) => sum + Buffer.byteLength(e.data, 'utf8'), 0);
    if (totalBytes > 1024 * 1024 * 1.2) throw new Error(`backfilled BigAgent data exceeds ring-buffer cap: ${totalBytes} bytes`);
  });

  fs.rmSync(testDir, { recursive: true, force: true });
}

// --- 3. Runtime: unrouted-reply detector reading the PTY log (lib/tmux-agent-state.js) ---
async function testLogBasedDetector() {
  console.log('\n[3] lib/tmux-agent-state.js — unrouted-reply detection via PTY log stream');

  function freshFactory() {
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('agent-bridge', 'lib', 'tmux-agent-state'))) delete require.cache[k];
    }
    return require('../lib/tmux-agent-state');
  }

  await testAsync('checkAgent() prefers the PTY log over tmux mapping when a log file exists', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-log-detector-'));
    const factory = freshFactory();
    const mod = factory({ DATA_DIR: testDir, helpers: { getAgents: () => ({}), saveAgents: () => {}, broadcastSystemMessage: () => {} } });
    fs.writeFileSync(path.join(testDir, 'agent-log-Solo.jsonl'), JSON.stringify({ ts: new Date().toISOString(), agent: 'Solo', data: 'hi\n' }) + '\n');
    const r = await mod.__test__.checkAgent('Solo', { pid: 123, last_activity: new Date().toISOString() }, new Map());
    if (r.source !== 'pty-log') throw new Error('expected source=pty-log, got ' + r.source);
    if (!r.mapped) throw new Error('expected mapped=true for an agent with an active log');
  });

  await testAsync('checkAgent() falls back to the tmux path when no log file exists for the agent', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-log-detector2-'));
    const factory = freshFactory();
    const mod = factory({ DATA_DIR: testDir, helpers: { getAgents: () => ({}), saveAgents: () => {}, broadcastSystemMessage: () => {} } });
    const r = await mod.__test__.checkAgent('NoLog', { pid: 999999999 }, new Map());
    if (r.source === 'pty-log') throw new Error('should not report pty-log source when no log file exists');
  });

  await testAsync('checkAgent() reports idle/unmapped once an agent_exit marker is seen in the log', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-log-detector3-'));
    const factory = freshFactory();
    const mod = factory({ DATA_DIR: testDir, helpers: { getAgents: () => ({}), saveAgents: () => {}, broadcastSystemMessage: () => {} } });
    const logPath = path.join(testDir, 'agent-log-Gone.jsonl');
    fs.writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'Gone', data: 'bye\n' }) + '\n');
    await mod.__test__.checkAgent('Gone', { pid: 1, last_activity: new Date().toISOString() }, new Map());
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'Gone', event: 'agent_exit', exitCode: 0, signal: null }) + '\n');
    const r = await mod.__test__.checkAgent('Gone', { pid: 1, last_activity: new Date().toISOString() }, new Map());
    if (r.mapped !== false || r.state !== 'idle') throw new Error('expected mapped=false/state=idle after agent_exit, got ' + JSON.stringify(r));
  });

  await testAsync('checkAgent() fires possible_unrouted_reply via the log stream within the SM-3 window (<46s)', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-log-detector4-'));
    const factory = freshFactory();
    const mod = factory({ DATA_DIR: testDir, helpers: { getAgents: () => ({}), saveAgents: () => {}, broadcastSystemMessage: () => {} } });
    const logPath = path.join(testDir, 'agent-log-Unrouted.jsonl');
    fs.writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'Unrouted', data: 'I will just answer here instead of calling send_message\n' }) + '\n');

    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      const lastActivityIso = new Date(fakeNow - 1000).toISOString();
      const r1 = await mod.__test__.checkAgent('Unrouted', { pid: 1, last_activity: lastActivityIso }, new Map());
      if (r1.possible_unrouted_reply) throw new Error('should not notify on first sighting');

      fakeNow += 46000; // past SM-3's <46s requirement / UNROUTED_SETTLE_MS
      const r2 = await mod.__test__.checkAgent('Unrouted', { pid: 1, last_activity: lastActivityIso }, new Map());
      if (!r2.possible_unrouted_reply) throw new Error('expected possible_unrouted_reply=true after settling with no tool call');
      if (!r2.unrouted_snippet || !r2.unrouted_snippet.includes('send_message')) {
        throw new Error('unrouted_snippet missing expected content: ' + r2.unrouted_snippet);
      }
    } finally {
      Date.now = realNow;
    }
  });

  await testAsync('checkAgent() resolves the candidate with zero notification if the agent calls a tool afterward', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-log-detector5-'));
    const factory = freshFactory();
    const mod = factory({ DATA_DIR: testDir, helpers: { getAgents: () => ({}), saveAgents: () => {}, broadcastSystemMessage: () => {} } });
    const logPath = path.join(testDir, 'agent-log-Responsible.jsonl');
    fs.writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent: 'Responsible', data: 'thinking out loud\n' }) + '\n');

    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      await mod.__test__.checkAgent('Responsible', { pid: 1, last_activity: new Date(fakeNow - 1000).toISOString() }, new Map());
      fakeNow += 46000;
      // Agent called a tool (e.g. listen()) after the text appeared — last_activity advances past firstSeenAt.
      const freshActivity = new Date(fakeNow).toISOString();
      const r2 = await mod.__test__.checkAgent('Responsible', { pid: 1, last_activity: freshActivity }, new Map());
      if (r2.possible_unrouted_reply) throw new Error('should have resolved silently — agent called a tool');
    } finally {
      Date.now = realNow;
    }
  });
}

(async () => {
  await testSseRouting();
  await testLogBasedDetector();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
