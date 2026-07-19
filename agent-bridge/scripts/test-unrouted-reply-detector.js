#!/usr/bin/env node
'use strict';

// Focused tests for the "possible unrouted reply" advisory detector added to
// lib/tmux-agent-state.js — part of the system-level backstop for agents
// answering in the terminal instead of calling send_message().
//
// Scope note: this is a read-only, advisory signal only. It never sends on
// an agent's behalf, never auto-acts, and never overrides any existing
// tmux-state invariant (prompt detection, mapped/unmapped, etc.) — it only
// raises team visibility via broadcastSystemMessage() so a human/Lead can
// manually follow up. See ARCHITECTURE notes in the task/decision log for
// why a full "capture everything to the dashboard" system was intentionally
// NOT built (privacy/noise/false-positive risk) in favor of this thin,
// self-correcting advisory slice.
//
// Run: node scripts/test-unrouted-reply-detector.js

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

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

function freshModule() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-unrouted-'));
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge', 'lib', 'tmux-agent-state'))) delete require.cache[k];
  }
  const broadcasts = [];
  const factory = require('../lib/tmux-agent-state');
  const mod = factory({
    DATA_DIR: testDir,
    helpers: {
      getAgents: () => ({}),
      saveAgents: () => {},
      broadcastSystemMessage: (msg) => broadcasts.push(msg),
    },
  });
  return { mod, broadcasts, testDir };
}

console.log('\n[1] computeOutputDelta()');
{
  const { mod } = freshModule();
  const { computeOutputDelta } = mod.__test__;

  test('returns the appended suffix when prev is a prefix of text', () => {
    const prev = 'line1\nline2\n';
    const text = 'line1\nline2\nline3\nline4\n';
    assert.strictEqual(computeOutputDelta(prev, text), 'line3\nline4');
  });

  test('falls back to the tail of text when prev is not a prefix (pane scrolled/cleared)', () => {
    const prev = 'completely different old content';
    const text = Array.from({ length: 20 }, (_, i) => `new-line-${i}`).join('\n');
    const delta = computeOutputDelta(prev, text);
    assert.ok(delta.includes('new-line-19'), 'includes the most recent line');
    assert.ok(!delta.includes('new-line-0'), 'does not include far-back lines (tail-only fallback)');
  });

  test('caps delta length at 400 chars, keeping the tail', () => {
    const text = 'x'.repeat(1000);
    const delta = computeOutputDelta(undefined, text);
    assert.ok(delta.length <= 400, 'delta is capped');
  });
}

console.log('\n[2] trackUnroutedReplyCandidate() state machine');
{
  const { mod } = freshModule();
  const { trackUnroutedReplyCandidate, UNROUTED_SETTLE_MS } = mod.__test__;
  const paneId = '%1';

  test('new output starts a candidate window and does not immediately notify', () => {
    const result = trackUnroutedReplyCandidate(paneId, 'agent said something', true, null);
    assert.strictEqual(result, null, 'no notification on first sighting');
  });

  test('unchanged output before the settle window elapses does not notify', () => {
    const result = trackUnroutedReplyCandidate(paneId, 'agent said something', false, null);
    assert.strictEqual(result, null, 'still within settle window');
  });

  test('tool call (last_activity advances past firstSeenAt) resolves the candidate — no notification ever', () => {
    const futureIso = new Date(Date.now() + 1000).toISOString();
    const result = trackUnroutedReplyCandidate(paneId, 'agent said something', false, futureIso);
    assert.strictEqual(result, null, 'resolved by a subsequent tool call');
  });

  test('after resolution, new output starts a fresh independent window', () => {
    const result = trackUnroutedReplyCandidate(paneId, 'agent said something else', true, null);
    assert.strictEqual(result, null);
  });
}

console.log('\n[3] trackUnroutedReplyCandidate() notifies exactly once after settling with no tool call');
{
  const { mod } = freshModule();
  const { trackUnroutedReplyCandidate } = mod.__test__;
  const paneId = '%2';

  // Simulate the passage of time by monkey-patching Date.now for this block.
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    test('new output at t=0 starts the window', () => {
      const r = trackUnroutedReplyCandidate(paneId, 'a plain-text reply that never became a tool call', true, null);
      assert.strictEqual(r, null);
    });

    test('still no notification just before the settle threshold', () => {
      fakeNow += 44000; // < UNROUTED_SETTLE_MS (45000)
      const r = trackUnroutedReplyCandidate(paneId, 'a plain-text reply that never became a tool call', false, null);
      assert.strictEqual(r, null);
    });

    test('notifies once the settle threshold is crossed with no tool call', () => {
      fakeNow += 2000; // now > 45000ms since firstSeenAt
      const r = trackUnroutedReplyCandidate(paneId, 'a plain-text reply that never became a tool call', false, null);
      assert.ok(r, 'candidate notifies');
      assert.strictEqual(r.text, 'a plain-text reply that never became a tool call');
      assert.ok(r.ageMs >= 45000);
    });

    test('does not re-notify for the same already-notified candidate', () => {
      fakeNow += 10000;
      const r = trackUnroutedReplyCandidate(paneId, 'a plain-text reply that never became a tool call', false, null);
      assert.strictEqual(r, null, 'already notified — must not repeat');
    });
  } finally {
    Date.now = realNow;
  }
}

console.log('\n[4] checkAgent() wiring — advisory-only, never overrides prompt detection');
{
  const serverSrc = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'tmux-agent-state.js'), 'utf8');
  test('possible_unrouted_reply detection is skipped when a permission prompt matched', () => {
    const idx = serverSrc.indexOf('if (!match.matched) {');
    assert.ok(idx !== -1, 'unrouted-reply block is gated on !match.matched');
  });
  test('broadcast is clearly labeled advisory-only, never claims to act on the agent\'s behalf', () => {
    assert.ok(/POSSIBLE UNROUTED REPLY/.test(serverSrc));
    assert.ok(/Advisory only/i.test(serverSrc));
  });
  test('detector never calls send_message/directDeliver/typeLiteralIntoPane on the agent\'s behalf', () => {
    const idx = serverSrc.indexOf('possible_unrouted_reply) {');
    const window = serverSrc.slice(idx, idx + 400);
    assert.ok(!/directDeliver|typeLiteralIntoPane|sendFixedWake/.test(window), 'no auto-send/auto-inject on unrouted-reply detection');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
