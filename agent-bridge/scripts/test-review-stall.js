'use strict';
// Q1: agent stall-recovery for pending reviews with no live reviewer.
// Exercises selfHealingWatchdog()'s review-stall pass directly against server.js,
// booted with NEOHIVE_TEST_NO_MAIN so it doesn't start a real transport.

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

function freshServer(testDir) {
  process.env.NEOHIVE_DATA_DIR = testDir;
  process.env.NEOHIVE_TEST_NO_MAIN = '1';
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge'))) delete require.cache[k];
  }
  return require('../server.js');
}

function writeAgents(testDir, agents) {
  fs.writeFileSync(path.join(testDir, 'agents.json'), JSON.stringify(agents));
}

function writeReviews(testDir, reviews) {
  fs.writeFileSync(path.join(testDir, 'reviews.json'), JSON.stringify(reviews));
}

function readReviews(testDir) {
  return JSON.parse(fs.readFileSync(path.join(testDir, 'reviews.json'), 'utf8'));
}

function isoAgo(ms) { return new Date(Date.now() - ms).toISOString(); }

const STALE = 6 * 60 * 1000;   // > 5min threshold
const FRESH = 1 * 60 * 1000;   // < 5min threshold

function testStalledNoReviewerGetsMarked() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-review-stall-'));
  const srv = freshServer(testDir);

  // Requester alive, no other agent (no reviewer) alive.
  writeAgents(testDir, {
    Requester: { pid: process.pid, last_activity: new Date().toISOString() },
  });
  writeReviews(testDir, [
    { id: 'rev_1', file: 'foo.js', description: 'd', status: 'pending', requested_by: 'Requester', requested_at: isoAgo(STALE), reviewer: null, feedback: null },
  ]);

  srv.selfHealingWatchdog();
  const reviews = readReviews(testDir);
  assert(reviews[0].stalled === true, 'stale review with no reviewer is marked stalled');
  assert(typeof reviews[0].stalled_at === 'string', 'stalled_at timestamp recorded');

  fs.rmSync(testDir, { recursive: true, force: true });
}

function testNoRenotifyOnSecondPass() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-review-stall-'));
  const srv = freshServer(testDir);

  writeAgents(testDir, {
    Requester: { pid: process.pid, last_activity: new Date().toISOString() },
  });
  writeReviews(testDir, [
    { id: 'rev_2', file: 'bar.js', description: 'd', status: 'pending', requested_by: 'Requester', requested_at: isoAgo(STALE), reviewer: null, feedback: null },
  ]);

  srv.selfHealingWatchdog();
  const firstStalledAt = readReviews(testDir)[0].stalled_at;

  // Force the internal 60s throttle open again to genuinely simulate a second
  // independent watchdog cycle (not just a no-op due to throttling).
  srv.__resetSelfHealThrottle();
  const before = JSON.stringify(readReviews(testDir));
  srv.selfHealingWatchdog();
  const after = JSON.stringify(readReviews(testDir));
  assert(before === after, 'second watchdog pass does not re-notify or mutate an already-stalled review');
  assert(readReviews(testDir)[0].stalled_at === firstStalledAt, 'stalled_at timestamp is not overwritten on re-run');

  fs.rmSync(testDir, { recursive: true, force: true });
}

function testLiveReviewerLeavesReviewUntouched() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-review-stall-'));
  const srv = freshServer(testDir);

  writeAgents(testDir, {
    Requester: { pid: process.pid, last_activity: new Date().toISOString() },
    Reviewer: { pid: process.pid, last_activity: new Date().toISOString() },
  });
  writeReviews(testDir, [
    { id: 'rev_3', file: 'baz.js', description: 'd', status: 'pending', requested_by: 'Requester', requested_at: isoAgo(STALE), reviewer: null, feedback: null },
  ]);

  srv.selfHealingWatchdog();
  const reviews = readReviews(testDir);
  assert(!reviews[0].stalled, 'pending review with a live eligible reviewer is left untouched');

  fs.rmSync(testDir, { recursive: true, force: true });
}

function testFreshReviewUntouched() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-review-stall-'));
  const srv = freshServer(testDir);

  writeAgents(testDir, {
    Requester: { pid: process.pid, last_activity: new Date().toISOString() },
  });
  writeReviews(testDir, [
    { id: 'rev_4', file: 'qux.js', description: 'd', status: 'pending', requested_by: 'Requester', requested_at: isoAgo(FRESH), reviewer: null, feedback: null },
  ]);

  srv.selfHealingWatchdog();
  const reviews = readReviews(testDir);
  assert(!reviews[0].stalled, 'fresh (under-threshold) pending review is left untouched');

  fs.rmSync(testDir, { recursive: true, force: true });
}

testStalledNoReviewerGetsMarked();
testNoRenotifyOnSecondPass();
testLiveReviewerLeavesReviewUntouched();
testFreshReviewUntouched();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
