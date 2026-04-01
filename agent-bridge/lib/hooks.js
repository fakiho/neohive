'use strict';

// Event hooks system — agents subscribe to events and get auto-notified via system messages.
// Hooks registry stored in .neohive/hooks.json.
//
// Supported events:
//   task.status_changed  — fires when any task changes status (filter by status, assignee)
//   agent.idle           — fires when an agent is idle for >2 min
//   agent.stuck          — fires when an agent is unresponsive for >10 min
//   workflow.advanced    — fires when a workflow step completes
//   review.submitted     — fires when a review is submitted

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const log = require('./logger');

const HOOKS_FILE = path.join(DATA_DIR, 'hooks.json');
const VALID_EVENTS = ['task.status_changed', 'agent.idle', 'agent.stuck', 'workflow.advanced', 'review.submitted', 'rule.changed'];

// --- Registry ---

function getHooks() {
  if (!fs.existsSync(HOOKS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf8')); } catch { return []; }
}

function saveHooks(hooks) {
  fs.writeFileSync(HOOKS_FILE, JSON.stringify(hooks, null, 2));
}

/**
 * Subscribe an agent to an event.
 * @param {string} agent - agent name
 * @param {string} event - event name (e.g. 'task.status_changed')
 * @param {object} filter - optional filter (e.g. { status: 'done', assignee: 'Nick' })
 * @returns {{ success, hook_id } | { error }}
 */
function subscribe(agent, event, filter) {
  if (!VALID_EVENTS.includes(event)) {
    return { error: `Invalid event. Must be one of: ${VALID_EVENTS.join(', ')}` };
  }

  const hooks = getHooks();

  // Prevent duplicate subscriptions
  const existing = hooks.find(h => h.agent === agent && h.event === event &&
    JSON.stringify(h.filter || {}) === JSON.stringify(filter || {}));
  if (existing) {
    return { success: true, hook_id: existing.id, message: 'Already subscribed to this event.' };
  }

  if (hooks.length >= 500) return { error: 'Hook limit reached (max 500).' };

  const hook = {
    id: 'hook_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    agent,
    event,
    filter: filter || {},
    created_at: new Date().toISOString(),
  };
  hooks.push(hook);
  saveHooks(hooks);

  return { success: true, hook_id: hook.id, event, filter: hook.filter, message: `Subscribed to ${event}. You will receive system messages when this event fires.` };
}

/**
 * Unsubscribe from a hook by ID, or all hooks for an agent.
 */
function unsubscribe(agent, hookId) {
  const hooks = getHooks();
  if (hookId) {
    const idx = hooks.findIndex(h => h.id === hookId && h.agent === agent);
    if (idx === -1) return { error: 'Hook not found or not owned by you.' };
    hooks.splice(idx, 1);
    saveHooks(hooks);
    return { success: true, message: 'Unsubscribed.' };
  }
  // Unsubscribe all for this agent
  const before = hooks.length;
  const filtered = hooks.filter(h => h.agent !== agent);
  saveHooks(filtered);
  return { success: true, removed: before - filtered.length, message: `Removed ${before - filtered.length} hook(s).` };
}

/**
 * List hooks for an agent (or all if agent is null).
 */
function listHooks(agent) {
  const hooks = getHooks();
  const filtered = agent ? hooks.filter(h => h.agent === agent) : hooks;
  return {
    count: filtered.length,
    hooks: filtered.map(h => ({ id: h.id, agent: h.agent, event: h.event, filter: h.filter, created_at: h.created_at })),
  };
}

/**
 * Emit an event — checks all subscriptions and returns list of agents to notify.
 * Caller (fireEvent in server.js) is responsible for actually sending the messages.
 *
 * @param {string} event - event name
 * @param {object} data - event data (varies by event type)
 * @returns {Array<{ agent, message }>} - agents to notify with formatted messages
 */
function emit(event, data) {
  const hooks = getHooks();
  const subscribers = hooks.filter(h => h.event === event);
  if (subscribers.length === 0) return [];

  const notifications = [];

  for (const hook of subscribers) {
    // Apply filters
    if (!matchesFilter(hook.filter, data)) continue;
    // Don't notify the agent that triggered the event
    if (data._source_agent && data._source_agent === hook.agent) continue;

    const message = formatEventMessage(event, data);
    if (message) {
      notifications.push({ agent: hook.agent, message });
    }
  }

  return notifications;
}

function matchesFilter(filter, data) {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [key, value] of Object.entries(filter)) {
    if (data[key] !== undefined && data[key] !== value) return false;
  }
  return true;
}

function formatEventMessage(event, data) {
  switch (event) {
    case 'task.status_changed':
      return `[HOOK] Task "${data.title || data.task_id}" status → ${data.status}` +
        (data.assignee ? ` (assignee: ${data.assignee})` : '') +
        (data.changed_by ? ` by ${data.changed_by}` : '');
    case 'agent.idle':
      return `[HOOK] Agent ${data.agent} has been idle for ${Math.round((data.idle_seconds || 0) / 60)} minutes.`;
    case 'agent.stuck':
      return `[HOOK] Agent ${data.agent} is unresponsive (${Math.round((data.idle_seconds || 0) / 60)}+ min). ${data.tasks_reassigned || 0} task(s) may need reassignment.`;
    case 'workflow.advanced':
      return `[HOOK] Workflow "${data.workflow_name}" step ${data.step_id} completed` +
        (data.progress ? ` (${data.progress})` : '') +
        (data.next_assignee ? `. Next: ${data.next_assignee}` : '');
    case 'review.submitted':
      return `[HOOK] Review "${data.file}" ${data.status} by ${data.reviewer}` +
        (data.feedback ? `: ${data.feedback.substring(0, 100)}` : '');
    case 'rule.changed': {
      const action = data.action || 'changed';
      const scope = data.scope_role || data.scope_provider || data.scope_agent
        ? ` (scoped to: ${[data.scope_role, data.scope_provider, data.scope_agent].filter(Boolean).join(', ')})`
        : '';
      return `[HOOK] Rule ${action} by ${data.changed_by || 'unknown'}: "${(data.text || data.rule_id || '').substring(0, 100)}"${scope}. Call get_briefing() to load updated rules.`;
    }
    default:
      return `[HOOK] ${event}: ${JSON.stringify(data).substring(0, 200)}`;
  }
}

module.exports = {
  VALID_EVENTS,
  subscribe,
  unsubscribe,
  listHooks,
  emit,
  getHooks,
};
