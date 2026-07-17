'use strict';
// Focused test for Epic 1 Stories 1.2/1.3: the read-only
// GET /api/methodologies/bmad/links endpoint (Story<->Task cross-link view
// + shadow-work surfacing). Verifies zero writes to tasks.json/story files
// and the empty-state degrade path.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const packageDir = path.resolve(__dirname, '..');
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-bmad-links-'));
const dataDir = path.join(projectDir, '.neohive');
fs.mkdirSync(dataDir, { recursive: true });
const port = 33000 + (process.pid % 1000);

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Dashboard did not start')), 10000);
    const inspect = (chunk) => {
      const output = String(chunk || '');
      if (/listening|localhost|dashboard/i.test(output)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dashboard exited early (${code})`));
    });
  });
}

async function json(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

let passed = 0;
let failed = 0;
function assertOk(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

async function run() {
  const child = spawn(process.execPath, ['dashboard.js'], {
    cwd: packageDir,
    env: Object.assign({}, process.env, {
      NEOHIVE_PORT: String(port),
      NEOHIVE_DATA_DIR: dataDir,
      NEOHIVE_PROJECT_ROOT: projectDir,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);

    // --- Scenario 1: zero stories / zero links -> degraded empty state, no crash ---
    console.log('\n--- Scenario 1: empty state ---');
    const empty = await json('/api/methodologies/bmad/links');
    assertOk(Array.isArray(empty.stories) && empty.stories.length === 0, 'degrades to empty stories array with no BMad output');
    assertOk(empty.shadow_work && empty.shadow_work.count === 0, 'shadow_work count is 0 with no tasks');

    // --- Scenario 1b (NFR4/INV-4): roadmap tasks but NO BMad install -> inert ---
    console.log('\n--- Scenario 1b: roadmap tasks + no BMad install stay inert ---');
    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify([
      { id: 'task_pre', title: 'Roadmap work before BMad adoption', status: 'pending', assignee: null, created_by: 'Coordinator1', bmad_story_id: null },
    ]));
    fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({ Coordinator1: { role: 'coordinator' } }));
    const inert = await json('/api/methodologies/bmad/links');
    assertOk(inert.shadow_work && inert.shadow_work.count === 0, 'shadow_work stays 0 when BMad is not installed even with a roadmap task (NFR4)');

    // --- Scenario 2: seed a story + tasks.json (linked, shadow, fast-lane) ---
    console.log('\n--- Scenario 2: cross-link + shadow-work surfacing ---');
    const outputDir = path.join(projectDir, '_bmad-output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'sprint-status.yaml'), [
      'development_status:',
      '  story-one:',
      '    status: ready-for-dev',
      '    file: _bmad-output/story-one.md',
      '    title: Story One',
    ].join('\n'));
    fs.writeFileSync(path.join(outputDir, 'story-one.md'), '# Story One\n');

    const beforeTasksRaw = null; // tasks.json does not exist yet
    const tasks = [
      { id: 'task_linked', title: 'Linked work', status: 'in_progress', assignee: 'Dev1', created_by: 'Coordinator1', bmad_story_id: '_bmad-output/story-one.md' },
      { id: 'task_shadow', title: 'Undocumented roadmap work', status: 'pending', assignee: null, created_by: 'Coordinator1', bmad_story_id: null },
      { id: 'task_fastlane', title: 'Quick fix', status: 'pending', assignee: null, created_by: 'Dev1', bmad_story_id: null },
    ];
    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(tasks));
    fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
      Coordinator1: { role: 'coordinator' },
      Dev1: { role: 'dev' },
    }));
    const beforeTasksJson = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
    const beforeStoryMd = fs.readFileSync(path.join(outputDir, 'story-one.md'), 'utf8');

    const links = await json('/api/methodologies/bmad/links');
    assertOk(links.stories.length === 1, 'one BMad story is returned');
    const story = links.stories[0];
    assertOk(story.linked_tasks.length === 1 && story.linked_tasks[0].id === 'task_linked', 'story-one links to task_linked via bmad_story_id');
    assertOk(links.shadow_work.count === 1, 'shadow_work count is exactly 1');
    assertOk(links.shadow_work.tasks.some((t) => t.id === 'task_shadow'), 'task_shadow (roadmap-sized, no story link) is surfaced as shadow work');
    assertOk(!links.shadow_work.tasks.some((t) => t.id === 'task_fastlane'), 'task_fastlane (small/fast-lane) is NOT flagged as shadow work');
    assertOk(!links.shadow_work.tasks.some((t) => t.id === 'task_linked'), 'linked task is not flagged as shadow work');

    // --- NFR3: zero writes to tasks.json or story files ---
    const afterTasksJson = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
    const afterStoryMd = fs.readFileSync(path.join(outputDir, 'story-one.md'), 'utf8');
    assertOk(afterTasksJson === beforeTasksJson, 'tasks.json is untouched by the read-only endpoint (NFR3)');
    assertOk(afterStoryMd === beforeStoryMd, 'story file is untouched by the read-only endpoint (NFR3)');
  } finally {
    child.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error('Test run failed:', error);
  process.exitCode = 1;
});
