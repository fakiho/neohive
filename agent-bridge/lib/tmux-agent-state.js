'use strict';

// Advisory tmux pane-state detection for registered agents.
//
// Reads each agent's tmux pane (via ancestry-walk from its registered PID)
// and pattern-matches recent pane text against known permission/confirmation
// prompts. This is a heuristic, read-only signal — it must never drive task
// reassignment or poison-pilling. Its only sanctioned consumer is a guard in
// watchdogCheck() that skips a nudge when there's fresh evidence an agent is
// still doing something in its terminal, even though it hasn't called listen().
//
// On by default (see getTmuxStateConfig): unlike github-issue-sync, this has
// no external side effects — it only reads the user's own local tmux panes
// and, at most, makes the existing watchdog slightly more conservative.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const PROMPT_PATTERNS = [
  {
    id: 'claude-code-proceed-menu',
    regex: /do you want to proceed\??/i,
    description: 'Claude Code generic tool-permission confirmation banner',
  },
  {
    id: 'claude-code-numbered-yes-menu',
    regex: /❯?\s*1\.\s*yes[\s\S]{0,80}2\.\s*yes,?\s*and\s*don'?t\s*ask\s*again/i,
    description: "Claude Code numbered permission menu (1. Yes / 2. Yes, and don't ask again / 3. No)",
  },
  {
    id: 'generic-yn-prompt',
    regex: /\(y\/n\)\s*$/im,
    description: 'Generic trailing (y/n) prompt, not Claude-specific',
  },
  {
    id: 'generic-press-enter-continue',
    regex: /press\s+enter\s+to\s+continue/i,
    description: 'Generic pause-for-input, seen in some CLI wizards/installers',
  },
  {
    id: 'cursor-cli-allow-prompt',
    regex: /allow\s+this\s+(command|action|tool)\??/i,
    description: 'Approximate Cursor CLI permission phrasing — needs real-world tuning',
  },
];

const CAPTURE_LINES = 50;
const MAX_HOPS = 10;

// Process names that indicate the pane is at an idle shell prompt — i.e. the
// agent process exited and no workload is running in the foreground.
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'csh', 'tcsh']);

function execFilePromise(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ timeout: 5000 }, opts), (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function capturePane(paneId, lines) {
  try {
    // -J rejoins soft-wrapped lines — without it, narrow panes can split a
    // prompt's key phrase (e.g. "don't ask again") across physical lines
    // and silently defeat the regex patterns below.
    return await execFilePromise('tmux', ['capture-pane', '-t', paneId, '-p', '-J', '-S', String(-(lines || CAPTURE_LINES))]);
  } catch {
    return null; // pane died between list-panes and capture-pane — benign race
  }
}

async function listAllPanes() {
  let out;
  try {
    out = await execFilePromise('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{session_name} #{pane_current_command} #{pane_dead}']);
  } catch {
    return new Map(); // no tmux server running, or no panes — every agent unmapped this cycle
  }
  const panesByPid = new Map();
  out.trim().split('\n').filter(Boolean).forEach((line) => {
    const [paneId, panePid, sessionName, currentCommand, paneDead] = line.split(' ');
    const pidNum = parseInt(panePid, 10);
    if (paneId && !Number.isNaN(pidNum)) {
      panesByPid.set(pidNum, { pane_id: paneId, session_name: sessionName || null, current_command: currentCommand || null, dead: paneDead === '1' });
    }
  });
  return panesByPid;
}

function getParentPid(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }).toString().trim();
    const ppid = parseInt(out, 10);
    return Number.isNaN(ppid) ? null : ppid;
  } catch {
    return null; // pid already gone — benign, not an error
  }
}

function walkAncestryToPane(pid, panesByPid, maxHops) {
  maxHops = maxHops || MAX_HOPS;
  let current = pid;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (panesByPid.has(current)) {
      const pane = panesByPid.get(current);
      return { pane_id: pane.pane_id, session_name: pane.session_name, current_command: pane.current_command || null, dead: pane.dead || false, hops: hop };
    }
    const parent = getParentPid(current);
    if (!parent || parent <= 1) break;
    current = parent;
  }
  return null;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// Re-checks a cached tmux mapping right before it's trusted for an actual
// side effect (typing into the pane). The cached agents.json snapshot can be
// up to poll_interval_seconds stale (default 20s) — if the agent's PID died
// and got reused by an unrelated process in that window, a stale mapping
// would otherwise cause literal keystrokes + Enter to be sent into whatever
// pane that unrelated process happens to share ancestry with. Confirms the
// PID is still alive AND a fresh ancestry walk still resolves to the same
// pane_id before returning true.
//
// pane_dead short-circuit: if the expected pane is already in the list but
// marked dead, reject immediately without the multi-hop ps ancestry walk.
async function verifyPaneMapping(pid, expectedPaneId) {
  if (!isPidAlive(pid)) return false;
  const panesByPid = await listAllPanes();
  // Check the target pane directly by pane_id before doing the ancestry walk.
  for (const entry of panesByPid.values()) {
    if (entry.pane_id === expectedPaneId && entry.dead) return false;
  }
  const mapping = walkAncestryToPane(pid, panesByPid);
  return !!(mapping && mapping.pane_id === expectedPaneId);
}

const MATCH_LINES = 15;

function matchPromptPatterns(text) {
  if (!text) return { matched: false, pattern_id: null };
  // tmux capture-pane returns the full pane height, padded with blank lines
  // below wherever the cursor currently sits — e.g. a 50-row pane with content
  // ending at row 30 yields 20 trailing blank lines. Trim those first, or
  // "last N lines" grabs blank padding instead of the actual last output.
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const recentLines = lines.slice(-MATCH_LINES).join('\n');
  for (const p of PROMPT_PATTERNS) {
    if (p.regex.test(recentLines)) {
      return { matched: true, pattern_id: p.id };
    }
  }
  return { matched: false, pattern_id: null };
}

// "esc to interrupt" is Claude Code's own live-generation marker (verified
// empirically — present only while actively generating, gone at rest).
function isGenerating(text) {
  return /esc to interrupt/i.test(text || '');
}

// Cheap single-field query — avoids a full capture-pane when all we need is
// the foreground process name to decide whether the pane is idle.
async function getPaneCurrentCommand(paneId) {
  try {
    const out = await execFilePromise('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_command}']);
    return out.trim() || null;
  } catch {
    return null; // pane gone or tmux not running
  }
}

// Live, uncached check of whether it's currently safe to type into a tmux
// pane: the cached agents.json advisory state (from checkAllAgents' ~20s
// poll) is too stale to gate a real-time send — an agent can start
// generating or hit a permission prompt well within that window. Treats a
// failed/empty capture as "not safe" too, since there's no reliable signal
// either way.
//
// Short-circuits via pane_current_command before the more expensive
// capture-pane: if the foreground process is a shell, the agent exited and
// the pane is idle — injecting would type into the bare shell, not the agent.
async function isPaneSafeToInject(paneId) {
  const currentCommand = await getPaneCurrentCommand(paneId);
  if (currentCommand === null) return false; // pane gone
  if (SHELL_COMMANDS.has(currentCommand)) return false; // agent exited, shell is foreground
  const text = await capturePane(paneId);
  if (text === null) return false;
  if (isGenerating(text)) return false;
  if (matchPromptPatterns(text).matched) return false;
  return true;
}

module.exports = function (ctx) {
  const { helpers, DATA_DIR } = ctx;
  const { getAgents, saveAgents, broadcastSystemMessage } = helpers;

  const MARKER_FILE = path.join(DATA_DIR, '.last-tmux-poll');
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

  let _tmuxChecked = false;
  let _tmuxAvailable = false;
  const _prevCaptures = new Map(); // pane_id -> last captured text (in-memory, resets on process restart)

  function isTmuxAvailable() {
    if (!_tmuxChecked) {
      _tmuxChecked = true;
      try { execFileSync('tmux', ['-V'], { timeout: 3000 }); _tmuxAvailable = true; }
      catch { _tmuxAvailable = false; }
    }
    return _tmuxAvailable;
  }

  function getTmuxStateConfig() {
    let config = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).tmux_agent_state || {}; }
      catch { config = {}; }
    }
    return {
      enabled: config.enabled !== false, // absent key = on (unlike github_issue_sync, which defaults off)
      poll_interval_seconds: config.poll_interval_seconds || 20,
      suppress_nudge_window_seconds: config.suppress_nudge_window_seconds || 90,
      // How long a tmux-mapped agent's listen() call is allowed to block before
      // returning retry:true — longer than the default listen_poll_interval, to
      // cut the number of idle re-poll round-trips (and the context they add)
      // for agents we know are reachable. Capped well under neohive's default
      // 300s MCP client tool-timeout (CLI_CONFIG.MCP_TOOL_TIMEOUT_S in cli.js) —
      // block longer than the client's own timeout and the call errors instead
      // of returning cleanly. 0/false disables (falls back to listen_poll_interval).
      listen_backstop_seconds: config.listen_backstop_seconds === undefined ? 240 : config.listen_backstop_seconds,
    };
  }

  function detectOutputChange(paneId, text) {
    const prev = _prevCaptures.get(paneId);
    _prevCaptures.set(paneId, text);
    if (prev === undefined) return true; // first capture — treat as a change
    return prev !== text;
  }

  async function checkAgent(name, info, panesByPid) {
    const nowIso = new Date().toISOString();
    const result = {
      mapped: false,
      pane_id: null,
      session_name: null,
      current_command: null,
      state: 'unknown',
      confidence: 'none',
      matched_pattern_id: null,
      last_output_at: (info.tmux && info.tmux.last_output_at) || null,
      last_checked_at: nowIso,
      hops: null,
    };

    if (!info.pid) return result;

    let mapping;
    try { mapping = walkAncestryToPane(info.pid, panesByPid); }
    catch { mapping = null; }

    if (!mapping || mapping.dead) return result;

    result.mapped = true;
    result.pane_id = mapping.pane_id;
    result.session_name = mapping.session_name;
    result.current_command = mapping.current_command;
    result.hops = mapping.hops;
    result.confidence = 'low';

    // If the foreground process is a shell, the agent exited and left behind an
    // idle terminal. Mark unmapped so injection is disabled and the watchdog
    // treats this like an offline agent — no capture-pane needed.
    if (mapping.current_command && SHELL_COMMANDS.has(mapping.current_command)) {
      result.mapped = false;
      result.state = 'idle';
      result.confidence = 'high';
      return result;
    }

    let text;
    try { text = await capturePane(mapping.pane_id); }
    catch { text = null; }

    if (text === null) return result;

    if (detectOutputChange(mapping.pane_id, text)) {
      result.last_output_at = nowIso;
    }

    const match = matchPromptPatterns(text);
    if (match.matched) {
      result.state = 'blocked_on_prompt';
      result.confidence = 'high';
      result.matched_pattern_id = match.pattern_id;
    }

    return result;
  }

  async function checkAllAgents() {
    if (!isTmuxAvailable()) return;

    const panesByPid = await listAllPanes();
    const agents = getAgents();
    let changed = false;

    for (const [name, info] of Object.entries(agents)) {
      let tmuxState;
      try { tmuxState = await checkAgent(name, info, panesByPid); }
      catch { continue; } // one agent's failure must never abort the cycle for others

      const prevState = info.tmux && info.tmux.state;
      const prevMapped = info.tmux && info.tmux.mapped;
      info.tmux = tmuxState;
      changed = true;

      if (prevState !== 'blocked_on_prompt' && tmuxState.state === 'blocked_on_prompt') {
        try {
          broadcastSystemMessage(
            `[STATUS] ${name}'s tmux pane shows a possible permission prompt (pattern: ${tmuxState.matched_pattern_id}). Advisory signal only — verify before acting.`
          );
        } catch { /* best-effort */ }
      }

      if (prevMapped && !tmuxState.mapped && tmuxState.state === 'idle') {
        try {
          broadcastSystemMessage(
            `[STATUS] ${name}'s tmux pane foreground process is now a shell (${tmuxState.current_command}) — agent process appears to have exited. Tmux mapping cleared.`
          );
        } catch { /* best-effort */ }
      }
    }

    if (changed) saveAgents(agents);
  }

  function isDue(intervalSeconds) {
    let last = 0;
    if (fs.existsSync(MARKER_FILE)) {
      try { last = parseInt(fs.readFileSync(MARKER_FILE, 'utf8').trim(), 10) || 0; } catch { /* treat as never polled */ }
    }
    return (Date.now() - last) >= intervalSeconds * 1000;
  }

  function claimPoll() {
    fs.writeFileSync(MARKER_FILE, String(Date.now()));
  }

  function pollIfDue() {
    const config = getTmuxStateConfig();
    if (!config.enabled) return;
    if (!isDue(config.poll_interval_seconds)) return;
    claimPoll();
    checkAllAgents().catch(() => {});
  }

  return { isTmuxAvailable, getTmuxStateConfig, checkAllAgents, pollIfDue, walkAncestryToPane, matchPromptPatterns, PROMPT_PATTERNS };
};

// Injects literal text into a tmux pane as a fresh prompt: literal text via
// `send-keys -l` (avoids tmux special-key-name interpretation), then a
// SEPARATE Enter keystroke — empirically required, text alone sits unsent
// in the pane's input box. Newlines are collapsed to spaces first, since a
// literal embedded newline can submit prematurely in a multi-line-aware
// TUI input box. Stateless (no ctx) — throws on failure, caller decides
// what to do about it.
function sendKeysToPane(paneId, text) {
  const flat = String(text).replace(/\r?\n/g, ' ');
  execFileSync('tmux', ['send-keys', '-t', paneId, '-l', flat], { timeout: 5000 });
  execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter'], { timeout: 5000 });
}

module.exports.sendKeysToPane = sendKeysToPane;
module.exports.verifyPaneMapping = verifyPaneMapping;
module.exports.isPaneSafeToInject = isPaneSafeToInject;
