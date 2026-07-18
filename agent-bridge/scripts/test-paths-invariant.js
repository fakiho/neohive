'use strict';

// Invariant test: lib/paths.js resolveDataDir/resolveProjectRoot must produce
// IDENTICAL output for the same {env, cwd}, regardless of which "caller"
// (server vs dashboard) invokes it — that identity is the entire point of
// extracting a single shared resolver. Exercises the case matrix called out
// in the datadir-sync-plan: env=data dir, env=project root (unified rule),
// no env + ancestor-walk variations, scored-ancestor fallback.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../lib/paths');

let tmpRoot;
let failures = 0;

function mk(...segs) {
  const p = path.join(tmpRoot, ...segs);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeMcpConfig(dir, dataDirValue) {
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { neohive: { env: { NEOHIVE_DATA_DIR: dataDirValue } } } })
  );
}

function assertIdentical(label, optsA, optsB) {
  const a = paths.resolveDataDir(optsA);
  const b = paths.resolveDataDir(optsB);
  try {
    assert.strictEqual(a, b, `${label}: dataDir mismatch (${a} !== ${b})`);
    const ra = paths.resolveProjectRoot(a, optsA);
    const rb = paths.resolveProjectRoot(b, optsB);
    assert.strictEqual(ra, rb, `${label}: projectRoot mismatch (${ra} !== ${rb})`);
    console.log(`PASS: ${label} -> dataDir=${a} projectRoot=${ra}`);
  } catch (e) {
    failures++;
    console.error(`FAIL: ${e.message}`);
  }
}

function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-paths-test-'));

  // Case 1: env set to a literal data dir (has its own .neohive-less data files
  // directly, so the "value/.neohive has data" unified-rule check should NOT
  // redirect — value used literally).
  const literalDataDir = mk('literal-data');
  fs.writeFileSync(path.join(literalDataDir, 'agents.json'), '{}');
  {
    const env = { NEOHIVE_DATA_DIR: literalDataDir };
    assertIdentical('env=literal data dir (server-call-shape vs dashboard-call-shape)',
      { env, cwd: tmpRoot, serverJsDir: path.join(tmpRoot, 'pkg') },
      { env, cwd: tmpRoot, serverJsDir: path.join(tmpRoot, 'pkg') });
    const resolved = paths.resolveDataDir({ env, cwd: tmpRoot });
    assert.strictEqual(resolved, literalDataDir, 'literal data dir should be used as-is');
    console.log('PASS: literal data dir resolves to itself');
  }

  // Case 2: env set to a project root whose .neohive subdir has data —
  // unified rule must redirect into <root>/.neohive for BOTH callers.
  const projRoot = mk('proj-root');
  const projHive = mk('proj-root', '.neohive');
  fs.writeFileSync(path.join(projHive, 'agents.json'), '{"a":1}');
  {
    const env = { NEOHIVE_DATA_DIR: projRoot };
    assertIdentical('env=project root with populated .neohive subdir',
      { env, cwd: tmpRoot }, { env, cwd: tmpRoot });
    const resolved = paths.resolveDataDir({ env, cwd: tmpRoot });
    assert.strictEqual(resolved, projHive, 'should redirect into <root>/.neohive');
    console.log('PASS: env=project-root redirects into .neohive subdir');
  }

  // Case 3: env set to a project root whose .neohive subdir is empty/missing —
  // literal value should be used (no redirect), preserving server's original
  // literal-path behavior when there's nothing to redirect to.
  const bareRoot = mk('bare-root');
  {
    const env = { NEOHIVE_DATA_DIR: bareRoot };
    assertIdentical('env=project root with empty/missing .neohive subdir',
      { env, cwd: tmpRoot }, { env, cwd: tmpRoot });
    const resolved = paths.resolveDataDir({ env, cwd: tmpRoot });
    assert.strictEqual(resolved, bareRoot, 'should use literal value when no populated .neohive subdir exists');
    console.log('PASS: env=bare project root uses literal value');
  }

  // Case 4: no env, cwd inside a project with an mcp.json defining NEOHIVE_DATA_DIR
  // (ancestor walk, first-match).
  const walkRoot = mk('walk-root');
  const walkDataDir = mk('walk-root', 'custom-data');
  writeMcpConfig(walkRoot, walkDataDir);
  const walkDeepCwd = mk('walk-root', 'a', 'b', 'c');
  {
    const env = {};
    assertIdentical('no env, ancestor walk finds mcp.json',
      { env, cwd: walkDeepCwd }, { env, cwd: walkDeepCwd });
    const resolved = paths.resolveDataDir({ env, cwd: walkDeepCwd });
    assert.strictEqual(resolved, walkDataDir, 'should find the ancestor mcp.json data dir');
    console.log('PASS: ancestor walk finds mcp.json-declared data dir');
  }

  // Case 5: no env, no mcp.json anywhere, but a scored-ancestor .neohive with
  // data exists further up — scored-ancestor fallback (dashboard's original
  // behavior) must fire identically for both callers.
  const scoredRoot = mk('scored-root');
  const scoredHive = mk('scored-root', '.neohive');
  fs.writeFileSync(path.join(scoredHive, 'agents.json'), '{"x":1}');
  fs.writeFileSync(path.join(scoredHive, 'tasks.json'), '[1,2,3]');
  const scoredDeepCwd = mk('scored-root', 'sub', 'dir');
  {
    const env = {};
    assertIdentical('no env, no mcp.json, scored-ancestor fallback',
      { env, cwd: scoredDeepCwd }, { env, cwd: scoredDeepCwd });
    const resolved = paths.resolveDataDir({ env, cwd: scoredDeepCwd });
    assert.strictEqual(resolved, scoredHive, 'should fall back to the scored ancestor .neohive');
    console.log('PASS: scored-ancestor fallback used when no mcp.json found');
  }

  // Case 6: no env, no mcp.json, no scored ancestor with data — cwd/.neohive
  // last resort, identical for both callers.
  // Fake HOME so the *real* dev machine's ~/.cursor/mcp.json (which points at
  // this very repo) can't leak into the fallback chain and produce a false
  // "divergence" that has nothing to do with the resolver logic itself.
  const fakeHome = mk('fake-home');
  const realHome = os.homedir;
  os.homedir = () => fakeHome;
  const emptyCwd = mk('empty-area', 'x', 'y');
  try {
    const env = {};
    assertIdentical('no env, nothing found -> cwd/.neohive last resort',
      { env, cwd: emptyCwd, serverJsDir: '/nonexistent/node_modules/neohive' },
      { env, cwd: emptyCwd, serverJsDir: '/nonexistent/node_modules/neohive' });
    const resolved = paths.resolveDataDir({ env, cwd: emptyCwd, serverJsDir: '/nonexistent/node_modules/neohive' });
    assert.strictEqual(resolved, path.join(emptyCwd, '.neohive'));
    console.log('PASS: last-resort cwd/.neohive');
  } finally {
    os.homedir = realHome;
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} invariant check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll paths.js invariant checks passed.');
}

main();
