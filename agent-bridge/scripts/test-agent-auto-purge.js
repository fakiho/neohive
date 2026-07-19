#!/usr/bin/env node
'use strict';

// Focused tests for: "Fix: Unreachable agents not removed and deletion throws error"
//
// Covers:
//  1. watchdogCheck() source contract — unreachable agents are tracked via
//     unreachable_since, marked registry_status "stale" after 2 min, and
//     auto-purged (with work reassignment) after 10 min. Static source
//     assertions, matching the existing test-story-1-3.js pattern, since
//     watchdogCheck has heavy external-state guards (autonomous/group mode,
//     amIWatchdog) not worth mocking end-to-end here.
//  2. purgeUnreachableAgentAuxFiles() — real runtime test: removes profile
//     entry + heartbeat/consumed/recovery/workspace files, idempotently.
//  3. dashboard.js DELETE /api/agents — real runtime test against a live
//     dashboard instance: full cleanup (agents.json, profiles.json,
//     heartbeat/consumed/recovery/workspace files), never throws/500s even
//     when the agent (or its files) are already gone, and is idempotent.
//
// Run: node scripts/test-agent-auto-purge.js

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

const packageDir = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(packageDir, 'server.js'), 'utf8');

// --- 1. Static source contract checks on watchdogCheck() ---
(function testWatchdogSourceContract() {
  console.log('\n[1] watchdogCheck() unreachable-agent auto-purge contract');
  const start = serverSrc.indexOf('function watchdogCheck(');
  assert(start !== -1, 'watchdogCheck function found');
  const nextFn = serverSrc.indexOf('\nfunction ', start + 10);
  const body = serverSrc.slice(start, nextFn === -1 ? start + 6000 : nextFn);

  assert(/unreachable_since/.test(body), 'tracks unreachable_since timestamp for dead-PID agents');
  assert(/registry_status\s*=\s*['"]stale['"]/.test(body), 'marks registry_status "stale" after threshold');
  assert(/unreachableTime > 120000/.test(body), 'stale threshold is 2 minutes (120000ms)');
  assert(/unreachableTime > 600000/.test(body), 'purge threshold is 10 minutes (600000ms)');
  assert(/reassignWorkFrom\(name\)/.test(body), 'reassigns active work before purging');
  assert(/purgeUnreachableAgentAuxFiles\(name\)/.test(body), 'calls purgeUnreachableAgentAuxFiles on purge');
  assert(/delete agents\[name\]/.test(body), 'removes purged agent from in-memory registry object');
  assert(/broadcastSystemMessage\(`\[WATCHDOG\] Auto-purged/.test(body), 'broadcasts an auto-purge notice to the team');
})();

// --- 2. Runtime test of purgeUnreachableAgentAuxFiles() ---
function freshServerModule(testDir) {
  process.env.NEOHIVE_DATA_DIR = testDir;
  process.env.NEOHIVE_TEST_NO_MAIN = '1';
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge'))) delete require.cache[k];
  }
  return require('../server.js');
}

(function testPurgeAuxFiles() {
  console.log('\n[2] purgeUnreachableAgentAuxFiles() runtime cleanup');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-purge-'));
  fs.mkdirSync(path.join(testDir, 'workspaces'), { recursive: true });

  const name = 'GhostAgent';
  fs.writeFileSync(path.join(testDir, 'profiles.json'), JSON.stringify({ [name]: { role: 'test' } }));
  fs.writeFileSync(path.join(testDir, `heartbeat-${name}.json`), JSON.stringify({ pid: 123456 }));
  fs.writeFileSync(path.join(testDir, `consumed-${name}.json`), JSON.stringify([]));
  fs.writeFileSync(path.join(testDir, `recovery-${name}.json`), JSON.stringify({}));
  fs.writeFileSync(path.join(testDir, 'workspaces', `${name}.json`), JSON.stringify({}));

  const mod = freshServerModule(testDir);
  mod.purgeUnreachableAgentAuxFiles(name);

  const profiles = JSON.parse(fs.readFileSync(path.join(testDir, 'profiles.json'), 'utf8'));
  assert(!profiles[name], 'profile entry removed');
  assert(!fs.existsSync(path.join(testDir, `heartbeat-${name}.json`)), 'heartbeat file removed');
  assert(!fs.existsSync(path.join(testDir, `consumed-${name}.json`)), 'consumed file removed');
  assert(!fs.existsSync(path.join(testDir, `recovery-${name}.json`)), 'recovery file removed');
  assert(!fs.existsSync(path.join(testDir, 'workspaces', `${name}.json`)), 'workspace file removed');

  // Idempotent: calling again on an already-purged agent must not throw
  let threw = false;
  try { mod.purgeUnreachableAgentAuxFiles(name); } catch { threw = true; }
  assert(!threw, 'calling purgeUnreachableAgentAuxFiles again on already-purged agent does not throw');

  fs.rmSync(testDir, { recursive: true, force: true });
})();

// --- 3. Runtime test of dashboard.js DELETE /api/agents ---
async function testDashboardDelete() {
  console.log('\n[3] dashboard.js DELETE /api/agents (manual deletion)');
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-delete-'));
  fs.mkdirSync(path.join(testDir, 'workspaces'), { recursive: true });
  const port = 39000 + Math.floor(Math.random() * 900);
  const name = 'DeadAgent';

  fs.writeFileSync(path.join(testDir, 'agents.json'), JSON.stringify({
    [name]: { pid: 999999, last_activity: new Date(Date.now() - 20 * 60000).toISOString() },
  }, null, 2));
  fs.writeFileSync(path.join(testDir, 'profiles.json'), JSON.stringify({ [name]: { role: 'test' } }, null, 2));
  fs.writeFileSync(path.join(testDir, `heartbeat-${name}.json`), JSON.stringify({ pid: 999999 }));
  fs.writeFileSync(path.join(testDir, `consumed-${name}.json`), JSON.stringify([]));
  fs.writeFileSync(path.join(testDir, `recovery-${name}.json`), JSON.stringify({}));
  fs.writeFileSync(path.join(testDir, 'workspaces', `${name}.json`), JSON.stringify({}));

  process.env.NEOHIVE_DATA_DIR = testDir;
  process.env.NEOHIVE_PORT = String(port);
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge'))) delete require.cache[k];
  }
  require('../dashboard.js');
  await new Promise((r) => setTimeout(r, 800));

  function req(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        hostname: 'localhost', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          'X-LTT-Request': '1',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  const r1 = await req('DELETE', '/api/agents', { name });
  assert(r1.status === 200, 'delete of existing dead agent returns 200 (got ' + r1.status + ')');
  assert(JSON.parse(r1.body).success === true, 'response reports success:true');
  assert(!fs.existsSync(path.join(testDir, `heartbeat-${name}.json`)), 'heartbeat file removed by DELETE');
  assert(!fs.existsSync(path.join(testDir, `consumed-${name}.json`)), 'consumed file removed by DELETE');
  assert(!fs.existsSync(path.join(testDir, `recovery-${name}.json`)), 'recovery file removed by DELETE');
  assert(!fs.existsSync(path.join(testDir, 'workspaces', `${name}.json`)), 'workspace file removed by DELETE');
  assert(!JSON.parse(fs.readFileSync(path.join(testDir, 'agents.json'), 'utf8'))[name], 'agents.json entry removed');
  assert(!JSON.parse(fs.readFileSync(path.join(testDir, 'profiles.json'), 'utf8'))[name], 'profiles.json entry removed');

  // Deleting again (already fully gone) must not throw/500 — should be a clean 404
  const r2 = await req('DELETE', '/api/agents', { name });
  assert(r2.status === 404, 'deleting an already-fully-purged agent returns 404, not a 500/throw (got ' + r2.status + ')');

  // Deleting an agent that never existed at all must not throw/500
  const r3 = await req('DELETE', '/api/agents', { name: 'NeverExisted' });
  assert(r3.status === 404, 'deleting a never-existed agent returns 404, not a 500/throw (got ' + r3.status + ')');

  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(passed_failed_exit());
}

function passed_failed_exit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

testDashboardDelete().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
