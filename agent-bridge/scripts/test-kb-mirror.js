'use strict';
// Focused test for Epic 2 Story 2.2 (FR4, AD-4): kb_mirror action.
// Verifies: upsert idempotency (re-run updates, not duplicates), one-way only
// (BMad files are never modified), no kb schema change ({content, updated_by,
// updated_at} shape preserved), and clean no-op on non-BMad projects (NFR4).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bmadProvider = require('../lib/bmad-provider');
const knowledgeModule = require('../tools/knowledge');

let passed = 0;
let failed = 0;
function assertOk(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

function makeKnowledgeTools(projectRoot) {
  let kb = {};
  const ctx = {
    state: { registeredName: 'TestAgent', currentBranch: 'main' },
    helpers: {
      getDecisions: () => [],
      getKB: () => kb,
      getProgressData: () => ({}),
      getCompressed: () => ({ segments: [] }),
      getLocks: () => ({}),
      getConfig: () => ({}),
      generateId: () => Math.random().toString(36).slice(2),
      writeJsonFile: (file, data) => { kb = data; },
      readJsonFile: () => null,
      touchActivity: () => {},
      tailReadJsonl: () => [],
      getHistoryFile: () => '/dev/null',
      getAgents: () => ({}),
      isPidAlive: () => false,
      getProfiles: () => ({}),
      getTasks: () => [],
      cachedRead: (k, fn) => fn(),
      inspectMethodology: () => null,
      listArtifacts: bmadProvider.listArtifacts,
      projectRoot,
    },
    files: {},
  };
  return { tools: knowledgeModule(ctx), getKb: () => kb };
}

async function run() {
  // --- Scenario 1: non-BMad project => clean no-op (NFR4) ---
  console.log('\n--- Scenario 1: non-BMad project ---');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-kbmirror-empty-'));
  const { tools: emptyTools, getKb: getEmptyKb } = makeKnowledgeTools(emptyDir);
  const emptyResult = emptyTools.handlers.kb_mirror();
  assertOk(emptyResult.success === true && !emptyResult.error, 'no-op returns success, not an error');
  assertOk(emptyResult.mirrored === 0, 'no-op mirrors zero entries');
  assertOk(Object.keys(getEmptyKb()).length === 0, 'no-op leaves kb empty (no empty entries created)');

  // --- Scenario 2: BMad project with PRD/architecture/decision artifacts ---
  console.log('\n--- Scenario 2: mirror upsert ---');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-kbmirror-'));
  const outDir = path.join(projectDir, '_bmad-output', 'planning-artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const prdPath = path.join(outDir, 'prd.md');
  const archPath = path.join(outDir, 'architecture.md');
  const decisionPath = path.join(outDir, 'decision-log.md');
  fs.writeFileSync(prdPath, '# PRD v1\nOriginal PRD content.');
  fs.writeFileSync(archPath, '# Architecture v1\nOriginal architecture content.');
  fs.writeFileSync(decisionPath, '# Decisions\nDecision A made.');

  const { tools, getKb } = makeKnowledgeTools(projectDir);
  const first = tools.handlers.kb_mirror();
  assertOk(first.success === true, 'mirror run succeeds');
  assertOk(first.mirrored === 3, 'mirrors one entry per artifact (prd, architecture, decision)');

  const kbAfterFirst = getKb();
  const keys = Object.keys(kbAfterFirst);
  assertOk(keys.length === 3, 'kb has exactly 3 entries after first mirror (no extras)');

  for (const k of keys) {
    const entry = kbAfterFirst[k];
    assertOk(
      typeof entry.content === 'string' && typeof entry.updated_by === 'string' && typeof entry.updated_at === 'string',
      `entry "${k}" keeps the existing {content, updated_by, updated_at} schema (no schema change)`
    );
  }
  const prdEntry = Object.values(kbAfterFirst).find(e => e.content.includes('planning-artifacts/prd.md'));
  assertOk(!!prdEntry, 'mirrored entry embeds the source BMad file path in its content');
  assertOk(prdEntry.content.includes('Original PRD content'), 'mirrored entry embeds the artifact content');

  // --- Scenario 3: re-run after artifact update => upsert, not duplicate ---
  console.log('\n--- Scenario 3: idempotent re-run after update ---');
  fs.writeFileSync(prdPath, '# PRD v2\nUpdated PRD content.');
  const second = tools.handlers.kb_mirror();
  assertOk(second.mirrored === 3, 'second run still mirrors 3 artifacts');
  const kbAfterSecond = getKb();
  assertOk(Object.keys(kbAfterSecond).length === 3, 'kb still has exactly 3 entries after re-run (upsert, not duplicate)');
  const updatedPrdEntry = Object.values(kbAfterSecond).find(e => e.content.includes('planning-artifacts/prd.md'));
  assertOk(updatedPrdEntry.content.includes('Updated PRD content'), 'kb entry reflects the updated artifact content');
  assertOk(!updatedPrdEntry.content.includes('Original PRD content'), 'stale content was replaced, not appended');

  // --- Scenario 4: one-way only — BMad files are never modified ---
  console.log('\n--- Scenario 4: one-way only ---');
  const prdOnDisk = fs.readFileSync(prdPath, 'utf8');
  assertOk(prdOnDisk === '# PRD v2\nUpdated PRD content.', 'BMad PRD file on disk is untouched by the mirror run');
  const archOnDisk = fs.readFileSync(archPath, 'utf8');
  assertOk(archOnDisk === '# Architecture v1\nOriginal architecture content.', 'BMad architecture file on disk is untouched');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
