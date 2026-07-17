'use strict';
// Focused test for Epic 3 (Phase 3): Story 3.2 (FR6/AD-6 opt-in enforcement rule)
// and Story 3.3 (FR7/AD-7 fast lane preserved). Mirrors the harness pattern in
// scripts/test-task-story-link.js but with mutable profiles/rules so we can
// exercise the create_task guard directly.

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

function makeCtx(testDir, { profiles = {}, rules = [] } = {}) {
  process.env.NEOHIVE_DATA_DIR = testDir;
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/neohive/agent-bridge/')) delete require.cache[k];
  }
  const { DATA_DIR, TASKS_FILE } = require('../lib/config');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { readJsonFile, writeJsonFile } = require('../lib/file-io');
  const state = { registeredName: 'TestAgent', messageSeq: 0, currentBranch: 'main' };
  const violations = [];
  const helpers = {
    getTasks: () => { const t = readJsonFile(TASKS_FILE); return Array.isArray(t) ? t : []; },
    getAgents: () => ({}), isPidAlive: () => false,
    generateId: () => Math.random().toString(36).slice(2),
    writeJsonFile, broadcastSystemMessage: () => {}, sendSystemMessage: () => {},
    touchActivity: () => {}, fireEvent: () => {},
    ensureDataDir: () => fs.mkdirSync(DATA_DIR, { recursive: true }),
    getProfiles: () => profiles, getReviews: () => [], getReputation: () => ({}),
    getDeps: () => [], getChannelsData: () => ({}), saveChannelsData: () => {},
    isGroupMode: () => false, getWorkspace: () => ({}), saveWorkspace: () => {},
    appendNotification: () => {}, getWorkflows: () => [], saveWorkflows: () => {},
    saveWorkflowCheckpoint: () => {}, findReadySteps: () => [],
    getMessagesFile: () => path.join(DATA_DIR, 'messages.jsonl'),
    getHistoryFile: () => path.join(DATA_DIR, 'history.jsonl'),
    logViolation: (type, agent, details) => { violations.push({ type, agent, details }); },
    cachedRead: (k, fn) => fn(),
    getRules: () => rules,
  };
  const files = { TASKS_FILE, REVIEWS_FILE: path.join(DATA_DIR, 'reviews.json'), DEPS_FILE: path.join(DATA_DIR, 'deps.json') };
  const { handlers } = require('../tools/tasks.js')({ state, helpers, files });
  return { handlers, helpers, violations };
}

function enforcementRule(action) {
  return {
    id: 'rule_enforce1',
    text: `[bmad-story-enforcement${action === 'flag' ? ':flag' : ''}] Roadmap tasks by Coordinator/Lead must derive from bmad-create-story.`,
    category: 'workflow',
    scope_role: 'coordinator',
    active: true,
  };
}

// ---------------------------------------------------------------------------
// (a) NO rule set -> roadmap task with no story link created exactly as today
// ---------------------------------------------------------------------------
console.log('\n--- (a) No rule set: default-off (NFR2) ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-a-'));
  const { handlers } = makeCtx(testDir, { profiles: { TestAgent: { role: 'coordinator' } }, rules: [] });
  const r = handlers.create_task({ title: 'Roadmap task, no rule' });
  assert(r.success === true, 'roadmap task with no bmad_story_id succeeds when no rule is set');
  assert(!r.error, 'no error field present');
  assert(!r.flagged, 'not flagged when no rule is set');
  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (b) rule set -> roadmap Coordinator/Lead task with no story link rejected
// ---------------------------------------------------------------------------
console.log('\n--- (b) Rule set + roadmap + Coordinator, no link: rejected ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-b-'));
  const { handlers } = makeCtx(testDir, {
    profiles: { TestAgent: { role: 'coordinator' } },
    rules: [enforcementRule('reject')],
  });
  const r = handlers.create_task({ title: 'Roadmap task, rule on, no link' });
  assert(!!r.error, 'rejected with an error when enforcement rule is active');
  assert(r.rule_id === 'rule_enforce1', 'error result carries the enforcing rule_id');
  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (c) rule set -> same task WITH a bmad_story_id passes
// ---------------------------------------------------------------------------
console.log('\n--- (c) Rule set + roadmap + Coordinator, WITH link: passes ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-c-'));
  const { handlers } = makeCtx(testDir, {
    profiles: { TestAgent: { role: 'coordinator' } },
    rules: [enforcementRule('reject')],
  });
  const r = handlers.create_task({ title: 'Roadmap task, rule on, with link', bmad_story_id: 'docs/stories/story-1.md' });
  assert(r.success === true, 'succeeds when bmad_story_id is provided, even with enforcement on');
  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (d) rule set -> small/fast-lane task passes regardless (FR7)
// ---------------------------------------------------------------------------
console.log('\n--- (d) Rule set + fast lane (size: small): always passes ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-d-'));
  const { handlers } = makeCtx(testDir, {
    profiles: { TestAgent: { role: 'coordinator' } },
    rules: [enforcementRule('reject')],
  });
  const r = handlers.create_task({ title: 'Small fast-lane task', size: 'small' });
  assert(r.success === true, 'explicit size:"small" bypasses enforcement even when Coordinator + rule on');
  assert(!r.flagged, 'fast-lane task is never flagged');
  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (e) rule set -> non-Coordinator/Lead role unaffected
// ---------------------------------------------------------------------------
console.log('\n--- (e) Rule set + non-Coordinator/Lead role: unaffected ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-e-'));
  const { handlers } = makeCtx(testDir, {
    profiles: { TestAgent: { role: 'dev' } },
    rules: [enforcementRule('reject')],
  });
  const r = handlers.create_task({ title: 'Dev-created roadmap-shaped task', size: 'roadmap' });
  assert(r.success === true, 'a non-Coordinator/Lead role is unaffected by the enforcement rule, even for size:"roadmap"');
  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (f) rule is project-local — a rule list is only ever whatever this
// project's getRules() returns; a second, separate project's ctx with an
// empty rules list must behave exactly like case (a).
// ---------------------------------------------------------------------------
console.log('\n--- (f) Rule is project-local ---');
{
  const testDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-f-a-'));
  const testDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-f-b-'));
  const ctxA = makeCtx(testDirA, { profiles: { TestAgent: { role: 'coordinator' } }, rules: [enforcementRule('reject')] });
  const rA = ctxA.handlers.create_task({ title: 'Project A roadmap task' });
  assert(!!rA.error, 'project A (rule enabled) rejects the unlinked roadmap task');

  const ctxB = makeCtx(testDirB, { profiles: { TestAgent: { role: 'coordinator' } }, rules: [] });
  const rB = ctxB.handlers.create_task({ title: 'Project B roadmap task' });
  assert(rB.success === true, 'project B (no rule) is unaffected by project A enabling the rule');

  fs.rmSync(testDirA, { recursive: true, force: true });
  fs.rmSync(testDirB, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (g) flag action: allow creation but mark flagged + audit-log a violation
// ---------------------------------------------------------------------------
console.log('\n--- (g) Rule configured to "flag" instead of reject ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-g-'));
  const { handlers, violations } = makeCtx(testDir, {
    profiles: { TestAgent: { role: 'lead' } },
    rules: [Object.assign(enforcementRule('flag'), { scope_role: 'lead' })],
  });
  const r = handlers.create_task({ title: 'Roadmap task, flag-mode rule' });
  assert(r.success === true, 'flag-mode rule allows creation to succeed');
  assert(r.flagged === true, 'flag-mode rule marks the result as flagged');
  assert(violations.some(v => v.type === 'shadow_work_flagged'), 'flag-mode rule logs a shadow_work_flagged violation');
  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (h) reject-intent rule whose PROSE contains the word "flag" must stay reject
//     (review finding #3: mode comes only from the explicit :flag token)
// ---------------------------------------------------------------------------
console.log('\n--- (h) "flag" word in a reject rule does not downgrade to flag mode ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-enforce-h-'));
  const rule = {
    id: 'rule_enforce_h',
    text: '[bmad-story-enforcement] Unlinked roadmap tasks must be flagged for review and rejected.',
    category: 'workflow',
    scope_role: 'coordinator',
    active: true,
  };
  const { handlers } = makeCtx(testDir, {
    profiles: { TestAgent: { role: 'coordinator' } },
    rules: [rule],
  });
  const r = handlers.create_task({ title: 'Roadmap task, reject rule mentioning flag' });
  assert(!!r.error && r.success !== true, 'reject-intent rule containing the word "flag" still rejects (no accidental flag downgrade)');
  fs.rmSync(testDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
