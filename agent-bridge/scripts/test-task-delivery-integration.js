'use strict';

// Verifies the wiring between tools/tasks.js and tools/delivery.js: create_task
// and the workflow-advance auto-handoff path must durably back their existing
// notifications (task_reminder / handoff message) with a claimable, idempotent
// delivery record — without changing any existing visible response or adding
// a second visible notification.

const fs = require('fs');
const path = require('path');
const os = require('os');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-task-delivery-'));
process.env.NEOHIVE_DATA_DIR = testDir;

for (const k of Object.keys(require.cache)) {
  if (k.includes('/neohive/agent-bridge/')) delete require.cache[k];
}

const { DATA_DIR, TASKS_FILE } = require('../lib/config');
fs.mkdirSync(DATA_DIR, { recursive: true });

const { readJsonFile, writeJsonFile } = require('../lib/file-io');

let passed = 0;
let failed = 0;
function check(cond, name) {
  if (cond) { passed += 1; console.log(`  PASS: ${name}`); }
  else { failed += 1; console.log(`  FAIL: ${name}`); }
}

// One shared delivery module instance per "agent process", exactly mirroring
// how server.js wires _deliveryCtx (state.registeredName/registeredToken are
// getters into per-process mutable variables).
function makeAgent(name) {
  const agentState = { registeredName: name, registeredToken: `token-${name}-1`, messageSeq: 0, currentBranch: 'main' };
  const delivery = require('../tools/delivery')({
    state: {
      get registeredName() { return agentState.registeredName; },
      get registeredToken() { return agentState.registeredToken; },
    },
    helpers: {
      generateId: () => Math.random().toString(36).slice(2),
      ensureDataDir: () => fs.mkdirSync(DATA_DIR, { recursive: true }),
      touchActivity: () => {},
    },
    files: { DATA_DIR },
  });

  const helpers = {
    getTasks: () => { const t = readJsonFile(TASKS_FILE); return Array.isArray(t) ? t : []; },
    getAgents: () => ({}),
    isPidAlive: () => false,
    generateId: () => Math.random().toString(36).slice(2),
    writeJsonFile,
    broadcastSystemMessage: () => {},
    sendSystemMessage: () => {},
    touchActivity: () => {},
    fireEvent: () => {},
    ensureDataDir: () => fs.mkdirSync(DATA_DIR, { recursive: true }),
    getProfiles: () => ({}),
    getReviews: () => [],
    getReputation: () => ({}),
    getDeps: () => [],
    getChannelsData: () => ({}),
    saveChannelsData: () => {},
    isGroupMode: () => false,
    getWorkspace: () => ({}),
    saveWorkspace: () => {},
    appendNotification: () => {},
    getWorkflows: () => [],
    saveWorkflows: () => {},
    saveWorkflowCheckpoint: () => {},
    findReadySteps: () => [],
    getMessagesFile: () => path.join(DATA_DIR, 'messages.jsonl'),
    getHistoryFile: () => path.join(DATA_DIR, 'history.jsonl'),
    logViolation: () => {},
    cachedRead: (k, fn) => fn(),
    enqueueDurableDelivery: delivery.internalEnqueue,
  };
  const files = { TASKS_FILE, REVIEWS_FILE: path.join(DATA_DIR, 'reviews.json'), DEPS_FILE: path.join(DATA_DIR, 'deps.json') };
  const tasks = require('../tools/tasks.js')({ state: agentState, helpers, files });

  return { agentState, delivery, tasks, helpers };
}

console.log('\n--- Suite 1: create_task assignment durably backs task_reminder without changing it ---');
{
  const lead = makeAgent('Lead');
  const coder = makeAgent('Coder');

  const result = lead.tasks.handlers.create_task({ title: 'Deploy service', description: 'Ship it', assignee: 'Coder' });
  check(result.success === true, 'create_task still returns success/task_id/assignee unchanged');
  check(Object.keys(result).sort().join(',') === 'assignee,next_action,success,task_id', 'create_task response shape unchanged (no new visible fields)');

  const listed = coder.delivery.handlers.list_deliveries({});
  check(listed.count === 1, 'exactly one durable delivery backs the assignment');
  check(listed.deliveries[0].kind === 'task', 'delivery kind is "task"');
  check(listed.deliveries[0].status === 'pending', 'delivery starts pending until claimed');

  const claimed = coder.delivery.handlers.claim_deliveries({ limit: 5 });
  check(claimed.count === 1, 'assignee can claim the durable record');
  check(claimed.deliveries[0].payload.task_id === result.task_id, 'claimed payload references the correct task_id');
  check(claimed.deliveries[0].payload.title === 'Deploy service', 'claimed payload carries the task title');

  const acked = coder.delivery.handlers.ack_delivery({ delivery_id: claimed.deliveries[0].delivery_id, lease_token: claimed.deliveries[0].lease_token });
  check(acked.success === true, 'assignee can ack the claimed delivery');
}

console.log('\n--- Suite 2: self-assignment never enqueues a durable delivery ---');
{
  const solo = makeAgent('Solo');
  solo.tasks.handlers.create_task({ title: 'Notes to self', assignee: 'Solo' });
  const listed = solo.delivery.handlers.list_deliveries({ recipient: 'Solo' });
  check(listed.count === 0, 'assigning a task to yourself does not create a self-delivery');
}

console.log('\n--- Suite 3: unassigned task creation never enqueues a durable delivery ---');
{
  const lonely = makeAgent('Lonely');
  const result = lonely.tasks.handlers.create_task({ title: 'Unassigned task' });
  check(result.assignee === null, 'task has no assignee');
  const listed = lonely.delivery.handlers.list_deliveries({});
  check(listed.count === 0, 'no durable delivery created when there is no assignee');
}

console.log('\n--- Suite 4: idempotency key prevents a retried enqueue from duplicating ---');
{
  const lead = makeAgent('Lead2');
  const coder = makeAgent('Coder2');

  // Simulate the exact call tools/tasks.js makes for the same logical task twice
  // (e.g. a crash-retry of the same create_task-equivalent operation).
  const r1 = lead.delivery.internalEnqueue({
    recipient: 'Coder2',
    payload: { type: 'task_assignment', task_id: 'task_fixed123', title: 'Retry-safe task' },
    kind: 'task',
    idempotencyKey: 'task_assignment:task_fixed123',
    messageId: 'task_fixed123',
  });
  const r2 = lead.delivery.internalEnqueue({
    recipient: 'Coder2',
    payload: { type: 'task_assignment', task_id: 'task_fixed123', title: 'Retry-safe task (retried call)' },
    kind: 'task',
    idempotencyKey: 'task_assignment:task_fixed123',
    messageId: 'task_fixed123',
  });
  check(r1 && r1.duplicate === false, 'first enqueue is not a duplicate');
  check(r2 && r2.duplicate === true, 'second enqueue with the same idempotency key is detected as a duplicate');
  check(r1.delivery_id === r2.delivery_id, 'both calls resolve to the same delivery record');

  const listed = coder.delivery.handlers.list_deliveries({ recipient: 'Coder2' });
  check(listed.count === 1, 'only one delivery record exists despite the retried enqueue');
}

console.log('\n--- Suite 5: workflow-handoff idempotency key format matches tasks.js usage ---');
{
  // Directly validates the idempotency key scheme (`handoff:<wf.id>:<step.id>`)
  // used inline inside toolUpdateTaskLocked's auto-advance branch, using the
  // same internalEnqueue entry point tasks.js calls into.
  const lead = makeAgent('Lead3');
  const coder = makeAgent('Coder3');
  const key = 'handoff:wf_abc:step_2';
  const first = lead.delivery.internalEnqueue({
    recipient: 'Coder3',
    payload: { type: 'workflow_handoff', workflow_id: 'wf_abc', step_id: 'step_2', description: 'Ship it' },
    kind: 'handoff',
    idempotencyKey: key,
    messageId: 'wf_abc:step_2',
  });
  const retry = lead.delivery.internalEnqueue({
    recipient: 'Coder3',
    payload: { type: 'workflow_handoff', workflow_id: 'wf_abc', step_id: 'step_2', description: 'Ship it (re-advance retry)' },
    kind: 'handoff',
    idempotencyKey: key,
    messageId: 'wf_abc:step_2',
  });
  check(first.duplicate === false, 'first handoff enqueue succeeds');
  check(retry.duplicate === true, 'a re-advance of the same workflow step does not duplicate the handoff delivery');

  const claimed = coder.delivery.handlers.claim_deliveries({ limit: 5 });
  check(claimed.count === 1, 'coder claims exactly one handoff delivery, not two');
  check(claimed.deliveries[0].kind === 'handoff', 'claimed delivery kind is "handoff"');
}

console.log('\n--- Suite 6: a failed backing enqueue is surfaced structurally, never silently, and never blocks the task ---');
{
  // Inject a mock enqueueDurableDelivery that always fails, to verify
  // create_task/update_task surface a structured durable_delivery(_errors)
  // field instead of silently succeeding — while the task/handoff itself
  // still persists normally (constraint: never block on a backing failure).
  const agentState = { registeredName: 'LeadFail', registeredToken: 'token-1', messageSeq: 0, currentBranch: 'main' };
  let enqueueCalls = 0;
  const helpers = {
    getTasks: () => { const t = readJsonFile(TASKS_FILE); return Array.isArray(t) ? t : []; },
    getAgents: () => ({}),
    isPidAlive: () => false,
    generateId: () => Math.random().toString(36).slice(2),
    writeJsonFile,
    broadcastSystemMessage: () => {},
    sendSystemMessage: () => {},
    touchActivity: () => {},
    fireEvent: () => {},
    ensureDataDir: () => fs.mkdirSync(DATA_DIR, { recursive: true }),
    getProfiles: () => ({}),
    getReviews: () => [],
    getReputation: () => ({}),
    getDeps: () => [],
    getChannelsData: () => ({}),
    saveChannelsData: () => {},
    isGroupMode: () => false,
    getWorkspace: () => ({}),
    saveWorkspace: () => {},
    appendNotification: () => {},
    getWorkflows: () => [],
    saveWorkflows: () => {},
    saveWorkflowCheckpoint: () => {},
    findReadySteps: () => [],
    getMessagesFile: () => path.join(DATA_DIR, 'messages.jsonl'),
    getHistoryFile: () => path.join(DATA_DIR, 'history.jsonl'),
    logViolation: () => {},
    cachedRead: (k, fn) => fn(),
    enqueueDurableDelivery: (req) => { enqueueCalls += 1; return { ok: false, error: 'simulated backing-store outage', code: 'SIMULATED_FAILURE' }; },
  };
  const files = { TASKS_FILE, REVIEWS_FILE: path.join(DATA_DIR, 'reviews.json'), DEPS_FILE: path.join(DATA_DIR, 'deps.json') };
  const tasksMod = require('../tools/tasks.js')({ state: agentState, helpers, files });

  const result = tasksMod.handlers.create_task({ title: 'Task with a flaky backing store', assignee: 'SomeoneElse' });
  check(result.success === true, 'create_task still succeeds (task is persisted) despite the backing enqueue failing');
  check(enqueueCalls === 1, 'the enqueue was actually attempted');
  check(!!result.durable_delivery, 'a structured durable_delivery error field is present');
  check(result.durable_delivery.code === 'SIMULATED_FAILURE', 'the structured error carries the underlying failure code');
  check(result.durable_delivery.idempotency_key === `task_assignment:${result.task_id}`, 'the structured error carries the exact idempotency_key a retry must reuse');

  const persisted = helpers.getTasks().find((t) => t.id === result.task_id);
  check(persisted && persisted.assignee === 'SomeoneElse', 'the task itself was persisted correctly regardless of the backing failure');
}

console.log('\n--- Suite 7: durable-delivery enqueue never happens while the TASKS_FILE lock is held (no nested lock order) ---');
{
  const agentState = { registeredName: 'LockOrderLead', registeredToken: 'token-1', messageSeq: 0, currentBranch: 'main' };
  let tasksLockHeld = false;
  let sawEnqueueWhileLocked = false;
  let enqueueCallCount = 0;

  // Wrap withFileLock as tools/tasks.js sees it, tracking TASKS_FILE lock state.
  const fileIo = require('../lib/file-io');
  const originalWithFileLock = fileIo.withFileLock;
  const trackedWithFileLock = (filePath, fn) => {
    const isTasksFile = filePath === TASKS_FILE;
    if (isTasksFile) tasksLockHeld = true;
    try {
      return originalWithFileLock(filePath, fn);
    } finally {
      if (isTasksFile) tasksLockHeld = false;
    }
  };

  // tools/tasks.js destructures withFileLock from require('../lib/file-io') at
  // module load time, so we must re-require it fresh with a patched module.
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('/tools/tasks.js')) delete require.cache[k];
  }
  const fileIoPath = require.resolve('../lib/file-io');
  const originalExports = require.cache[fileIoPath].exports;
  require.cache[fileIoPath].exports = Object.assign({}, fileIo, { withFileLock: trackedWithFileLock });

  const helpers = {
    getTasks: () => { const t = readJsonFile(TASKS_FILE); return Array.isArray(t) ? t : []; },
    getAgents: () => ({}),
    isPidAlive: () => false,
    generateId: () => Math.random().toString(36).slice(2),
    writeJsonFile,
    broadcastSystemMessage: () => {},
    sendSystemMessage: () => {},
    touchActivity: () => {},
    fireEvent: () => {},
    ensureDataDir: () => fs.mkdirSync(DATA_DIR, { recursive: true }),
    getProfiles: () => ({}),
    getReviews: () => [],
    getReputation: () => ({}),
    getDeps: () => [],
    getChannelsData: () => ({}),
    saveChannelsData: () => {},
    isGroupMode: () => false,
    getWorkspace: () => ({}),
    saveWorkspace: () => {},
    appendNotification: () => {},
    getWorkflows: () => [],
    saveWorkflows: () => {},
    saveWorkflowCheckpoint: () => {},
    findReadySteps: () => [],
    getMessagesFile: () => path.join(DATA_DIR, 'messages.jsonl'),
    getHistoryFile: () => path.join(DATA_DIR, 'history.jsonl'),
    logViolation: () => {},
    cachedRead: (k, fn) => fn(),
    enqueueDurableDelivery: (req) => {
      enqueueCallCount += 1;
      if (tasksLockHeld) sawEnqueueWhileLocked = true;
      return { ok: true, delivery_id: 'fake', duplicate: false };
    },
  };
  const files = { TASKS_FILE, REVIEWS_FILE: path.join(DATA_DIR, 'reviews.json'), DEPS_FILE: path.join(DATA_DIR, 'deps.json') };
  const tasksModFresh = require('../tools/tasks.js')({ state: agentState, helpers, files });

  const result = tasksModFresh.handlers.create_task({ title: 'Lock order probe', assignee: 'SomeoneElse2' });
  check(result.success === true, 'create_task succeeds under the instrumented lock tracker');
  check(enqueueCallCount === 1, 'the durable-delivery enqueue was invoked exactly once');
  check(sawEnqueueWhileLocked === false, 'enqueueDurableDelivery was never called while the TASKS_FILE lock was held');

  // Restore the original module exports for any code loaded after this point.
  require.cache[fileIoPath].exports = originalExports;
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('/tools/tasks.js')) delete require.cache[k];
  }
}

fs.rmSync(testDir, { recursive: true, force: true });
console.log(`\n--- Results ---\npassed: ${passed}, failed: ${failed}`);
if (failed > 0) { process.exitCode = 1; console.log('SOME TESTS FAILED'); }
else console.log('ALL TASK-DELIVERY INTEGRATION TESTS PASSED');
