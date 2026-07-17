'use strict';

// Shared roadmap-size classification rule (Epic 1, Story 1.1 / AD-2).
//
// A task is roadmap-sized iff its creator (created_by) maps to role
// Coordinator/Lead OR the task carries an explicit size: "roadmap" field.
// Explicit `size` ("small" | "roadmap") always overrides the role default.
// `size` is optional and additive — its absence changes nothing (NFR5).
//
// This is the single source of truth for the classification so FR2
// (shadow-work flagging) and any future FR6 enforcement never diverge.
// Read-only / display-oriented: never changes a task's status, assignee,
// or createability.

const ROADMAP_ROLES = new Set(['coordinator', 'lead']);

/**
 * @param {object} task - a task record (created_by, size)
 * @param {object} profiles - profiles.json contents, keyed by agent name
 * @returns {'roadmap'|'small'}
 */
function classifyTaskSize(task, profiles) {
  if (!task) return 'small';
  const explicit = task.size;
  if (explicit === 'roadmap' || explicit === 'small') return explicit;

  const creator = task.created_by;
  const role = ((profiles && creator && profiles[creator] && profiles[creator].role) || '')
    .toString()
    .toLowerCase();
  return ROADMAP_ROLES.has(role) ? 'roadmap' : 'small';
}

/**
 * Shadow work: a roadmap-sized task with no BMad story link.
 * @returns {boolean}
 */
function isShadowWork(task, profiles) {
  if (!task) return false;
  if (classifyTaskSize(task, profiles) !== 'roadmap') return false;
  return !task.bmad_story_id;
}

module.exports = { classifyTaskSize, isShadowWork, ROADMAP_ROLES };
