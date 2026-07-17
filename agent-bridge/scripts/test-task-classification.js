'use strict';
// Focused test for Epic 1 Story 1.1 (AD-2): shared roadmap-size classification
// helper (lib/task-classification.js) and Story 1.3's isShadowWork rule.

const { classifyTaskSize, isShadowWork } = require('../lib/task-classification');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

console.log('\n--- classifyTaskSize ---');

// Role-inferred default
assert(
  classifyTaskSize({ created_by: 'Coordinator1' }, { Coordinator1: { role: 'coordinator' } }) === 'roadmap',
  'created_by mapping to role "coordinator" classifies roadmap-sized'
);
assert(
  classifyTaskSize({ created_by: 'LeadA' }, { LeadA: { role: 'lead' } }) === 'roadmap',
  'created_by mapping to role "lead" classifies roadmap-sized'
);
assert(
  classifyTaskSize({ created_by: 'Dev1' }, { Dev1: { role: 'dev' } }) === 'small',
  'created_by mapping to any other role classifies small/fast-lane'
);
assert(
  classifyTaskSize({ created_by: 'Unknown' }, {}) === 'small',
  'unknown creator with no profile defaults to small'
);

// Explicit size overrides role default
assert(
  classifyTaskSize({ created_by: 'Coordinator1', size: 'small' }, { Coordinator1: { role: 'coordinator' } }) === 'small',
  'explicit size:"small" overrides a Coordinator/Lead role default'
);
assert(
  classifyTaskSize({ created_by: 'Dev1', size: 'roadmap' }, { Dev1: { role: 'dev' } }) === 'roadmap',
  'explicit size:"roadmap" overrides a non-Coordinator/Lead role default'
);

// NFR5: absent size field behaves exactly as today (role-inferred default)
assert(
  classifyTaskSize({ created_by: 'Coordinator1' }, { Coordinator1: { role: 'coordinator' } }) === 'roadmap' &&
  classifyTaskSize({ created_by: 'Coordinator1', size: undefined }, { Coordinator1: { role: 'coordinator' } }) === 'roadmap',
  'absent size field changes nothing (NFR5)'
);

console.log('\n--- isShadowWork ---');

assert(
  isShadowWork({ created_by: 'Coordinator1', bmad_story_id: null }, { Coordinator1: { role: 'coordinator' } }) === true,
  'roadmap-sized task with null bmad_story_id is shadow work'
);
assert(
  isShadowWork({ created_by: 'Coordinator1' }, { Coordinator1: { role: 'coordinator' } }) === true,
  'roadmap-sized task with absent bmad_story_id is shadow work'
);
assert(
  isShadowWork({ created_by: 'Coordinator1', bmad_story_id: 'stories/foo.md' }, { Coordinator1: { role: 'coordinator' } }) === false,
  'roadmap-sized task WITH a story link is not shadow work'
);
assert(
  isShadowWork({ created_by: 'Dev1', bmad_story_id: null }, { Dev1: { role: 'dev' } }) === false,
  'small/fast-lane task is never flagged as shadow work (NFR1/SM-C1)'
);
assert(
  isShadowWork({ created_by: 'Dev1', size: 'roadmap', bmad_story_id: null }, { Dev1: { role: 'dev' } }) === true,
  'explicit size:"roadmap" on a non-lead role can still be flagged as shadow work'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
