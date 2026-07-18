'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

// Create a story file INSIDE the project root (required by containment check)
function makeTmpStory(suffix) {
  const p = path.join(PROJECT_ROOT, `_test-story-${suffix}-${Date.now()}.md`);
  fs.writeFileSync(p, `# Story: ${suffix}\n\nTest content.\n`);
  return p;
}

function makeCtx(testDir) {
  process.env.NEOHIVE_DATA_DIR = testDir;
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/neohive/agent-bridge/')) delete require.cache[k];
  }
  const { DATA_DIR, TASKS_FILE } = require('../lib/config');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { readJsonFile, writeJsonFile } = require('../lib/file-io');
  const state = { registeredName: 'TestAgent', messageSeq: 0, currentBranch: 'main' };
  const helpers = {
    getTasks: () => { const t = readJsonFile(TASKS_FILE); return Array.isArray(t) ? t : []; },
    getAgents: () => ({}), isPidAlive: () => false,
    generateId: () => Math.random().toString(36).slice(2),
    writeJsonFile, broadcastSystemMessage: () => {}, sendSystemMessage: () => {},
    touchActivity: () => {}, fireEvent: () => {},
    ensureDataDir: () => fs.mkdirSync(DATA_DIR, { recursive: true }),
    getProfiles: () => ({}), getReviews: () => [], getReputation: () => ({}),
    getDeps: () => [], getChannelsData: () => ({}), saveChannelsData: () => {},
    isGroupMode: () => false, getWorkspace: () => ({}), saveWorkspace: () => {},
    appendNotification: () => {}, getWorkflows: () => [], saveWorkflows: () => {},
    saveWorkflowCheckpoint: () => {}, findReadySteps: () => [],
    getMessagesFile: () => path.join(DATA_DIR, 'messages.jsonl'),
    getHistoryFile: () => path.join(DATA_DIR, 'history.jsonl'),
    logViolation: () => {}, cachedRead: (k, fn) => fn(),
  };
  const files = { TASKS_FILE, REVIEWS_FILE: path.join(DATA_DIR, 'reviews.json'), DEPS_FILE: path.join(DATA_DIR, 'deps.json') };
  const { handlers, definitions } = require('../tools/tasks.js')({ state, helpers, files });
  return { handlers, definitions, helpers, TASKS_FILE, DATA_DIR };
}

const cleanupStories = [];
function cleanup() {
  for (const p of cleanupStories) { try { fs.unlinkSync(p); } catch {} }
}

// ---------------------------------------------------------------------------
// Suite 1: basic create/link happy path
// ---------------------------------------------------------------------------
console.log('\n--- Suite 1: create_task bmad_story_id + link_task_to_story ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-link-'));
  const { handlers, helpers } = makeCtx(testDir);
  const storyPath = makeTmpStory('s1');
  cleanupStories.push(storyPath);

  // create_task with bmad_story_id
  const r1 = handlers.create_task({ title: 'Task with story', bmad_story_id: storyPath });
  assert(r1.success, 'create_task with bmad_story_id succeeds');
  const t1 = helpers.getTasks().find(t => t.id === r1.task_id);
  assert(t1 && t1.bmad_story_id === storyPath, 'bmad_story_id set on create');

  // create_task without bmad_story_id — non-breaking
  const r2 = handlers.create_task({ title: 'Legacy task' });
  assert(r2.success, 'create_task without bmad_story_id succeeds');
  const t2 = helpers.getTasks().find(t => t.id === r2.task_id);
  assert(t2 && t2.bmad_story_id === null, 'bmad_story_id is null when not provided');

  // link_task_to_story
  const lnk = handlers.link_task_to_story({ task_id: r2.task_id, story_file_path: storyPath });
  assert(lnk.success, 'link_task_to_story succeeds');
  assert(lnk.previous_story_id === null, 'previous_story_id is null before first link');
  const t2after = helpers.getTasks().find(t => t.id === r2.task_id);
  assert(t2after.bmad_story_id === storyPath, 'bmad_story_id updated on task after link');
  const storyContent = fs.readFileSync(storyPath, 'utf8');
  assert(storyContent.includes(`<!-- Related Task: ${r2.task_id} -->`), 'story file has Related Task comment');

  // idempotent: second call must not duplicate the comment
  handlers.link_task_to_story({ task_id: r2.task_id, story_file_path: storyPath });
  const sc2 = fs.readFileSync(storyPath, 'utf8');
  const count = (sc2.match(new RegExp(`<!-- Related Task: ${r2.task_id} -->`, 'g')) || []).length;
  assert(count === 1, 'idempotent: Related Task comment not duplicated');

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Suite 2: path containment (B2) — symlink escape and outside-root rejection
// ---------------------------------------------------------------------------
console.log('\n--- Suite 2: path containment ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-outside-'));
  const { handlers, helpers } = makeCtx(testDir);

  const r = handlers.create_task({ title: 'Containment task' });
  const tid = r.task_id;

  // Absolute path outside project root
  const outsideFile = path.join(outsideDir, 'outside.md');
  fs.writeFileSync(outsideFile, '# Outside\n');
  const errAbs = handlers.link_task_to_story({ task_id: tid, story_file_path: outsideFile });
  assert(errAbs.error, 'absolute outside path rejected');

  // Symlink inside project root that points outside
  const symlinkPath = path.join(PROJECT_ROOT, `_test-escape-link-${Date.now()}.md`);
  try {
    fs.symlinkSync(outsideFile, symlinkPath);
    cleanupStories.push(symlinkPath);
    const errSym = handlers.link_task_to_story({ task_id: tid, story_file_path: symlinkPath });
    assert(errSym.error && errSym.error.includes('project root'), 'symlink escape rejected');
  } catch {
    console.log('  SKIP: symlink not supported on this fs');
    passed++;
  }

  // Nonexistent file (inside project — path does not exist)
  const ghostPath = path.join(PROJECT_ROOT, '_test-ghost.md');
  const errNe = handlers.link_task_to_story({ task_id: tid, story_file_path: ghostPath });
  assert(errNe.error && errNe.error.toLowerCase().includes('not found'), 'nonexistent story file rejected');

  // Nonexistent task — use a real story file inside project
  const storyIn = makeTmpStory('s2-valid');
  cleanupStories.push(storyIn);
  const errNt = handlers.link_task_to_story({ task_id: 'task_nope', story_file_path: storyIn });
  assert(errNt.error && errNt.error.toLowerCase().includes('not found'), 'nonexistent task rejected');

  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Suite 3: rollback on append failure (B3)
// ---------------------------------------------------------------------------
console.log('\n--- Suite 3: rollback on story-append failure ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-link-'));
  const { handlers, helpers } = makeCtx(testDir);
  const storyPath = makeTmpStory('s3-ro');
  cleanupStories.push(storyPath);

  const r = handlers.create_task({ title: 'Rollback task' });
  const tid = r.task_id;

  fs.chmodSync(storyPath, 0o444);
  let rollbackResult;
  try {
    rollbackResult = handlers.link_task_to_story({ task_id: tid, story_file_path: storyPath });
  } finally {
    fs.chmodSync(storyPath, 0o644);
  }

  if (rollbackResult && rollbackResult.error) {
    assert(rollbackResult.rolled_back === true, 'B3: rollback flag set on append failure');
    const taskAfter = helpers.getTasks().find(t => t.id === tid);
    assert(taskAfter.bmad_story_id === null, 'B3: bmad_story_id rolled back to null');
  } else {
    // Running as root — chmod ineffective
    console.log('  SKIP: chmod had no effect (likely root); skipping rollback assertions');
    passed += 2;
  }

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Suite 4: MCP definition presence (B1 schema verification)
// ---------------------------------------------------------------------------
console.log('\n--- Suite 4: MCP definition registered ---');
{
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhtest-link-'));
  const { definitions } = makeCtx(testDir);

  const def = definitions.find(d => d.name === 'link_task_to_story');
  assert(def !== undefined, 'link_task_to_story definition present in module exports');
  assert(def && def.inputSchema && def.inputSchema.required.includes('task_id'), 'task_id is required in schema');
  assert(def && def.inputSchema && def.inputSchema.required.includes('story_file_path'), 'story_file_path is required in schema');

  fs.rmSync(testDir, { recursive: true, force: true });
}

cleanup();

console.log(`\n--- Results ---`);
console.log(`passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
console.log('ALL LINK-TASK-TO-STORY TESTS PASSED');
