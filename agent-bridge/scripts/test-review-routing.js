'use strict';
// Focused test for Epic 2 Story 2.3 (FR5, AD-5): routing bmad-code-review findings
// into the Neohive review record via submit_review, keyed by task_id with a
// git-branch fallback. Verifies: routing by task_id, branch fallback when no task
// is in play, graceful degrade (auto-attach) when no review exists, the additive
// task_id/branch key on the existing reviews.json shape, and that the pre-existing
// title-substring match path is preserved (not removed).

const assert = require('assert');
const governanceModule = require('../tools/governance');

let passed = 0;
let failed = 0;
function assertOk(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

function makeGovernanceTools({ agentName = 'Reviewer1', tasks = [], reviews = [] } = {}) {
  let reviewsStore = reviews;
  let tasksStore = tasks;
  const writes = [];
  const ctx = {
    state: { registeredName: agentName },
    helpers: {
      getVotes: () => [],
      getReviews: () => reviewsStore,
      getRules: () => [],
      getPushRequests: () => [],
      getAgents: () => ({}),
      isPidAlive: () => false,
      getReputation: () => ({}),
      getTasks: () => tasksStore,
      saveTasks: (t) => { tasksStore = t; },
      generateId: () => 'id_' + Math.random().toString(36).slice(2),
      readJsonFile: () => null,
      writeJsonFile: (file, data) => {
        writes.push(file);
        if (String(file).includes('REVIEWS')) reviewsStore = data;
      },
      cachedRead: (k, fn) => fn(),
      invalidateCache: () => {},
      broadcastSystemMessage: () => {},
      sendSystemMessage: () => {},
      touchActivity: () => {},
      fireEvent: () => {},
    },
    files: {
      VOTES_FILE: 'VOTES', REVIEWS_FILE: 'REVIEWS', RULES_FILE: 'RULES',
      PUSH_REQUESTS_FILE: 'PUSH', AUDIT_LOG_FILE: '/dev/null', REPUTATION_FILE: 'REP',
    },
  };
  const tools = governanceModule(ctx);
  return { tools, getReviews: () => reviewsStore };
}

const FEEDBACK = 'Reviewed the diff line by line: no security issues found, error handling is correct, and tests cover the new branch. Approving.';

function run() {
  // --- Scenario 1: routed by task_id against an existing (pre-tagged) review ---
  console.log('\n--- Scenario 1: route by task_id, existing review ---');
  {
    const reviews = [{ id: 'rev_1', file: 'src/foo.js', status: 'pending', requested_by: 'Author1', reviewer: null, feedback: null, task_id: 'task_1' }];
    const { tools, getReviews } = makeGovernanceTools({ agentName: 'Reviewer1', reviews });
    const result = tools.handlers.submit_review({ status: 'approved', feedback: FEEDBACK, task_id: 'task_1' });
    assertOk(result.success === true, 'submit_review resolves via task_id without a review_id');
    assertOk(result.review_id === 'rev_1', 'resolves to the correct pre-tagged review');
    const stored = getReviews().find(r => r.id === 'rev_1');
    assertOk(stored.status === 'approved', 'review status updated on the resolved record');
  }

  // --- Scenario 2: branch fallback when no task is in play ---
  console.log('\n--- Scenario 2: branch fallback ---');
  {
    const reviews = [{ id: 'rev_2', file: 'src/bar.js', status: 'pending', requested_by: 'Author2', reviewer: null, feedback: null, branch: 'feature/xyz' }];
    const { tools, getReviews } = makeGovernanceTools({ agentName: 'Reviewer1', reviews });
    const result = tools.handlers.submit_review({ status: 'approved', feedback: FEEDBACK, branch: 'feature/xyz' });
    assertOk(result.success === true && result.review_id === 'rev_2', 'routes to the review tagged with the matching branch when no task_id given');
  }

  // --- Scenario 3: graceful degrade — no review exists, findings are not dropped ---
  console.log('\n--- Scenario 3: degrade — auto-attach when nothing matches ---');
  {
    const tasks = [{ id: 'task_9', title: 'Add retry logic', assignee: 'Dev9', status: 'in_progress' }];
    const { tools, getReviews } = makeGovernanceTools({ agentName: 'Reviewer1', tasks, reviews: [] });
    const result = tools.handlers.submit_review({ status: 'changes_requested', feedback: FEEDBACK, task_id: 'task_9' });
    assertOk(result.success === true, 'submit_review does not error when no review exists for the task');
    assertOk(!!result.review_id, 'a review record was created/attached rather than dropping the findings');
    const created = getReviews().find(r => r.id === result.review_id);
    assertOk(!!created && created.task_id === 'task_9', 'auto-attached review carries the task_id key');
    assertOk(created.status === 'changes_requested', 'auto-attached review reflects the submitted findings');
  }

  // --- Scenario 4: additive key — task_id/branch stored without breaking existing shape ---
  console.log('\n--- Scenario 4: additive reviews.json shape ---');
  {
    const reviews = [{ id: 'rev_4', file: 'src/baz.js', status: 'pending', requested_by: 'Author4', reviewer: null, feedback: null }];
    const { tools, getReviews } = makeGovernanceTools({ agentName: 'Reviewer1', reviews });
    tools.handlers.submit_review({ review_id: 'rev_4', status: 'approved', feedback: FEEDBACK, task_id: 'task_4' });
    const stored = getReviews().find(r => r.id === 'rev_4');
    assertOk(stored.task_id === 'task_4', 'task_id key is added additively when submitting via the classic review_id path');
    assertOk('file' in stored && 'status' in stored && 'requested_by' in stored && 'reviewer' in stored && 'feedback' in stored && 'review_round' in Object.assign({ review_round: undefined }, stored) === true, 'existing reviews.json fields are preserved');
  }

  // --- Scenario 5: pre-existing title-substring match is preserved, not removed ---
  console.log('\n--- Scenario 5: legacy title-substring match still works ---');
  {
    const tasks = [{ id: 'task_5', title: 'src/legacy.js cleanup', assignee: 'Dev5', status: 'in_progress' }];
    const reviews = [{ id: 'rev_5', file: 'src/legacy.js cleanup', status: 'pending', requested_by: 'Author5', reviewer: null, feedback: null }];
    const { tools, getReviews } = makeGovernanceTools({ agentName: 'Reviewer1', tasks, reviews });
    // No task_id/branch tag on the review yet — must fall back to the title-substring match.
    const result = tools.handlers.submit_review({ status: 'approved', feedback: FEEDBACK, task_id: 'task_5' });
    assertOk(result.success === true && result.review_id === 'rev_5', 'legacy title-substring match resolves the review when no task_id/branch tag exists yet');
  }

  // --- Scenario 6: self-review guard is NOT bypassed by routing (review finding #1) ---
  console.log('\n--- Scenario 6: cannot approve own code via task_id routing ---');
  {
    const tasks = [{ id: 'task_6', title: 'src/mine.js', assignee: 'Author6', status: 'in_progress' }];
    const reviews = [{ id: 'rev_6', file: 'src/mine.js', status: 'pending', requested_by: 'Author6', reviewer: null, feedback: null }];
    const { tools } = makeGovernanceTools({ agentName: 'Author6', tasks, reviews });
    // Author6 tries to approve their own pre-existing review by routing via task_id instead of review_id.
    const result = tools.handlers.submit_review({ status: 'approved', feedback: FEEDBACK, task_id: 'task_6' });
    assertOk(result.error === 'Cannot review your own code.', 'self-review guard blocks author approving own code via task_id routing');
  }

  // --- Scenario 7: routing does not reopen an already-approved review ---
  console.log('\n--- Scenario 7: no routing onto a terminal (approved) review ---');
  {
    const tasks = [{ id: 'task_7', title: 'src/done.js', assignee: 'Dev7', status: 'in_progress' }];
    const reviews = [{ id: 'rev_7', file: 'src/done.js', status: 'approved', requested_by: 'Dev7', reviewer: 'Reviewer1', feedback: 'ok', task_id: 'task_7' }];
    const { tools, getReviews } = makeGovernanceTools({ agentName: 'Reviewer2', tasks, reviews });
    const result = tools.handlers.submit_review({ status: 'changes_requested', feedback: FEEDBACK, task_id: 'task_7' });
    const stored = getReviews();
    assertOk(result.success === true && result.review_id !== 'rev_7', 'routing onto an approved review creates a fresh review round rather than reopening it');
    assertOk(stored.find(r => r.id === 'rev_7').status === 'approved', 'the pre-existing approved review is left untouched');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
