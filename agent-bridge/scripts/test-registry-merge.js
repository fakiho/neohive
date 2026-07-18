'use strict';

// Test: lib/registry.js#registerAgent writes concurrency-safely (locked,
// atomic-rename) to ~/.neohive/registry.json, and the resulting entries are
// what dashboard.js's apiProjects()-style merge would surface (additively,
// via registry.listDiscoveredProjects()).
//
// Uses a fake HOME so this never touches the real developer's
// ~/.neohive/registry.json.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-registry-test-'));
const realHomedir = os.homedir;
os.homedir = () => fakeHome;

// Must require AFTER stubbing os.homedir since registry.js computes
// REGISTRY_FILE at module-load time from os.homedir().
delete require.cache[require.resolve('../lib/registry')];
const registry = require('../lib/registry');

async function main() {
  let failures = 0;
  function check(cond, label) {
    if (cond) console.log(`PASS: ${label}`);
    else { failures++; console.error(`FAIL: ${label}`); }
  }

  check(registry.REGISTRY_FILE.startsWith(fakeHome), 'registry file path uses the (faked) home dir, not cwd');

  // Single write.
  registry.registerAgent({ name: 'agentA', projectRoot: '/proj/a', dataDir: '/proj/a/.neohive', pid: process.pid });
  let data = registry.readRegistry();
  check(data.agents.length === 1 && data.agents[0].name === 'agentA', 'single registerAgent call recorded');

  // REAL cross-process concurrency: spawn N separate node processes that each
  // call registerAgent against the SAME registry file (via HOME=fakeHome) at the
  // same time. This genuinely exercises the cross-process withFileLock mutex —
  // withFileLock is synchronous, so in-process promises would just run serially
  // and could never catch a lost-update race.
  const { spawnSync, spawn } = require('child_process');
  const regPath = require.resolve('../lib/registry');
  const N = 12;
  const child = (i) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e',
      `const r=require(${JSON.stringify(regPath)});r.registerAgent({name:'agent${i}',projectRoot:'/proj/${i}',dataDir:'/proj/${i}/.neohive',pid:process.pid});`
    ], { env: Object.assign({}, process.env, { HOME: fakeHome }), stdio: 'ignore' });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
  await Promise.all(Array.from({ length: N }, (_, i) => child(i)));

  data = registry.readRegistry();
  const distinctNames = new Set(data.agents.map(a => a.name));
  // N spawned + the 1 pre-existing entry written earlier in this test.
  check(distinctNames.size === N + 1, `all ${N + 1} cross-process concurrent registrations survived (got ${distinctNames.size}) — no lost updates`);

  // File itself must be valid JSON (no partial/torn writes from concurrent renames).
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, 'utf8'));
    check(Array.isArray(parsed.agents), 'registry.json is valid JSON with an agents array after concurrent writes');
  } catch (e) {
    failures++;
    console.error('FAIL: registry.json is not valid JSON after concurrent writes:', e.message);
  }

  // Dashboard-side merge: listDiscoveredProjects() surfaces one entry per
  // distinct dataDir, usable to additively extend the known-projects list.
  const discovered = registry.listDiscoveredProjects();
  check(discovered.length === N + 1, `listDiscoveredProjects() surfaces one project per distinct dataDir (got ${discovered.length})`);
  check(discovered.every(d => d.discovered === true && d.path && d.dataDir), 'each discovered entry has {path, dataDir, discovered:true}');

  // Dead-PID pruning: register with an obviously-dead PID and a stale
  // lastSeen — a subsequent write should prune it.
  registry.registerAgent({ name: 'deadAgent', projectRoot: '/proj/dead', dataDir: '/proj/dead/.neohive', pid: 999999 });
  // Manually age the entry past STALE_MS so pruning has something to act on
  // (registerAgent itself always writes lastSeen=now, so we rewrite the file
  // directly here to simulate the passage of time, then trigger a prune via
  // another registerAgent call).
  const raw = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, 'utf8'));
  for (const e of raw.agents) {
    if (e.name === 'deadAgent') e.lastSeen = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  }
  fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(raw));
  registry.registerAgent({ name: 'triggerPrune', projectRoot: '/proj/x', dataDir: '/proj/x/.neohive', pid: process.pid });
  data = registry.readRegistry();
  check(!data.agents.some(a => a.name === 'deadAgent'), 'stale dead-PID entry pruned on next write');

  os.homedir = realHomedir;
  fs.rmSync(fakeHome, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} registry check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll registry checks passed.');
}

main();
