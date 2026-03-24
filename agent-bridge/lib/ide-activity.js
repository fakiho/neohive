'use strict';

const fs = require('fs');
const path = require('path');

const WORKING_STALE_MS = 10000;

/**
 * Read IDE liveness hint written by vscode-extension (ide-activity-{agent}.json).
 * v2 fields: focused, ide_idle, extension_online, working, shell_working, last_tool_call, timestamp.
 * @param {string} dataDir - .neohive directory
 * @param {string} agentName
 */
function readIdeActivity(dataDir, agentName) {
  if (!dataDir || !agentName || !/^[a-zA-Z0-9_-]{1,20}$/.test(agentName)) return null;
  const f = path.join(dataDir, `ide-activity-${agentName}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      focused: j.focused === true,
      ide_idle: j.ide_idle === true,
      extension_online: j.extension_online !== false,
      working: j.working === true,
      shell_working: j.shell_working === true,
      last_tool_call: typeof j.last_tool_call === 'string' ? j.last_tool_call : null,
      timestamp: typeof j.timestamp === 'string' ? j.timestamp : null,
    };
  } catch {
    return null;
  }
}

/**
 * Read last_stdin_activity from heartbeat-{agent}.json (written by server.js stdin tracker).
 * @param {string} dataDir
 * @param {string} agentName
 * @returns {string|null} ISO timestamp or null
 */
function readStdinActivity(dataDir, agentName) {
  if (!dataDir || !agentName) return null;
  const f = path.join(dataDir, `heartbeat-${agentName}.json`);
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return typeof j.last_stdin_activity === 'string' ? j.last_stdin_activity : null;
  } catch {
    return null;
  }
}

/**
 * Layer IDE extension + stdin hints on list_agents / apiAgents entries (mutates entry).
 *
 * Priority order:
 *   1. extension_online: false           → offline
 *   2. listening_since set (from agent)  → listening  (never override)
 *   3. working OR shell_working OR       → working
 *      stdin activity < 10s OR
 *      last_tool_call < 10s
 *   4. ide_idle: true                    → idle
 *   5. default                           → keep existing status
 *
 * @param {object} entry - built agent row
 * @param {ReturnType<typeof readIdeActivity>} ide
 * @param {object} [opts]
 * @param {string} [opts.dataDir] - .neohive dir for reading heartbeat stdin
 * @param {string} [opts.agentName]
 */
function applyIdeActivityHint(entry, ide, opts) {
  if (!ide || !entry) return;

  entry.ide_activity = {
    focused: ide.focused,
    ide_idle: ide.ide_idle,
    extension_online: ide.extension_online,
    working: ide.working,
    shell_working: ide.shell_working,
    last_tool_call: ide.last_tool_call,
    timestamp: ide.timestamp,
  };

  // Priority 1: extension offline → agent offline
  if (ide.extension_online === false) {
    entry.alive = false;
    entry.status = 'offline';
    entry.idle_seconds = null;
    entry.is_listening = false;
    return;
  }

  // Priority 2: listening (set by server via listen()) → never override
  if (entry.is_listening) return;

  // Check stdin freshness from heartbeat
  let stdinRecent = false;
  if (opts && opts.dataDir && opts.agentName) {
    const stdinTs = readStdinActivity(opts.dataDir, opts.agentName);
    if (stdinTs) {
      stdinRecent = (Date.now() - new Date(stdinTs).getTime()) < WORKING_STALE_MS;
    }
  }

  // Check tool call freshness
  let toolCallRecent = false;
  if (ide.last_tool_call) {
    toolCallRecent = (Date.now() - new Date(ide.last_tool_call).getTime()) < WORKING_STALE_MS;
  }

  // Priority 3: active work signals → working
  if ((ide.working || ide.shell_working || stdinRecent || toolCallRecent) && entry.alive) {
    entry.status = 'working';
    return;
  }

  // Priority 4: IDE idle → idle
  if (ide.ide_idle && entry.alive) {
    entry.status = 'idle';
  }
}

module.exports = { readIdeActivity, readStdinActivity, applyIdeActivityHint };
