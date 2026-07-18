'use strict';
// Focused test for lib/bmad-watcher.js — verifies BMad artifact changes under
// _bmad-output/ produce coalesced narration events (debounced, capped),
// and that the watcher no-ops cleanly when there's no BMad output at all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bmadWatcher = require('../lib/bmad-watcher');

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-bmad-watcher-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testSingleArtifactCreatesOneEvent() {
  const projectRoot = mkProject();
  const outDir = path.join(projectRoot, '_bmad-output');
  fs.mkdirSync(outDir, { recursive: true });

  const events = [];
  bmadWatcher.start(projectRoot, (event) => events.push(event));

  fs.writeFileSync(path.join(outDir, 'ARCHITECTURE-SPINE.md'), '# Architecture\n');

  // Debounce is 1.5s — wait comfortably past it.
  await sleep(2200);
  bmadWatcher.stop(projectRoot);

  assert.strictEqual(events.length, 1, `expected exactly 1 event, got ${events.length}`);
  assert.strictEqual(events[0].kind, 'bmad_artifact');
  assert.strictEqual(events[0].artifactType, 'architecture');
  assert.ok(events[0].path.includes('ARCHITECTURE-SPINE.md'), 'event path should reference the artifact');
  assert.ok(events[0].phase, 'event should carry a phase');

  fs.rmSync(projectRoot, { recursive: true, force: true });
  console.log('PASS: single artifact creation -> exactly one narration event');
}

async function testRapidWritesCoalesce() {
  const projectRoot = mkProject();
  const outDir = path.join(projectRoot, '_bmad-output');
  fs.mkdirSync(outDir, { recursive: true });

  const events = [];
  bmadWatcher.start(projectRoot, (event) => events.push(event));

  const file = path.join(outDir, 'PRD.md');
  // Burst of rapid writes to the same artifact — should coalesce to one event
  // per artifact once the debounce window settles, not one event per write.
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(file, `# PRD revision ${i}\n`);
    await sleep(50);
  }

  await sleep(2200);
  bmadWatcher.stop(projectRoot);

  const prdEvents = events.filter((e) => e.artifactType === 'prd');
  assert.strictEqual(prdEvents.length, 1, `expected rapid writes to coalesce to 1 event, got ${prdEvents.length}`);

  fs.rmSync(projectRoot, { recursive: true, force: true });
  console.log('PASS: rapid writes to the same artifact coalesce to a single event');
}

async function testMissingOutputDirNoOps() {
  const projectRoot = mkProject(); // no _bmad-output/ created at all
  const events = [];

  assert.doesNotThrow(() => {
    bmadWatcher.start(projectRoot, (event) => events.push(event));
  }, 'watcher must not throw when _bmad-output is absent');

  await sleep(500);
  assert.doesNotThrow(() => bmadWatcher.stop(projectRoot));
  assert.strictEqual(events.length, 0, 'no events expected when there is no BMad output');

  fs.rmSync(projectRoot, { recursive: true, force: true });
  console.log('PASS: missing _bmad-output/ => watcher starts and no-ops without throwing');
}

async function main() {
  await testSingleArtifactCreatesOneEvent();
  await testRapidWritesCoalesce();
  await testMissingOutputDirNoOps();
  console.log('\nAll bmad-watcher tests passed.');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
