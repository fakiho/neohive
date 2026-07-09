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
    out = await execFilePromise('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{session_name}']);
  } catch {
    return new Map(); // no tmux server running, or no panes — every agent unmapped this cycle
  }
  const panesByPid = new Map();
  out.trim().split('\n').filter(Boolean).forEach((line) => {
    const [paneId, panePid, sessionName] = line.split(' ');
    const pidNum = parseInt(panePid, 10);
    if (paneId && !Number.isNaN(pidNum)) {
      panesByPid.set(pidNum, { pane_id: paneId, session_name: sessionName || null });
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
      return { pane_id: pane.pane_id, session_name: pane.session_name, hops: hop };
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
async function verifyPaneMapping(pid, expectedPaneId) {
  if (!isPidAlive(pid)) return false;
  const panesByPid = await listAllPanes();
  const mapping = walkAncestryToPane(pid, panesByPid);
  return !!(mapping && mapping.pane_id === expectedPaneId);
}

// Per-pane injection lock: prevents a second injected message from
// interleaving into a pane whose previous injection is still being
// captured by waitForReply(), which would scramble reply extraction or
// let one reply be misattributed to the wrong sender.
const _busyPanes = new Set();

function isPaneBusy(paneId) {
  return _busyPanes.has(paneId);
}

function markPaneBusy(paneId) {
  _busyPanes.add(paneId);
}

function markPaneFree(paneId) {
  _busyPanes.delete(paneId);
}

module.exports = function (ctx) {
  const { helpers, DATA_DIR } = ctx;
  const { getAgents, saveAgents, broadcastSystemMessage } = helpers;

  const MARKER_FILE = path.join(DATA_DIR, '.last-tmux-poll');
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  const MATCH_LINES = 15;

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

    if (!mapping) return result;

    result.mapped = true;
    result.pane_id = mapping.pane_id;
    result.session_name = mapping.session_name;
    result.hops = mapping.hops;
    result.confidence = 'low';

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
      info.tmux = tmuxState;
      changed = true;

      if (prevState !== 'blocked_on_prompt' && tmuxState.state === 'blocked_on_prompt') {
        try {
          broadcastSystemMessage(
            `[STATUS] ${name}'s tmux pane shows a possible permission prompt (pattern: ${tmuxState.matched_pattern_id}). Advisory signal only — verify before acting.`
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

// Extracts the agent's most recent reply from a raw capture-pane text.
// Convention (Claude Code CLI, verified against real captures):
//   - agent output is marked with a leading ● per turn/block
//   - a submitted prompt line is marked with a leading ❯
//   - the live, not-yet-processed input box is bordered top and bottom by a
//     horizontal-rule line — always the last thing in any capture — and must
//     be excluded, since its ❯ line may be unsent draft text, not history
// So: drop everything from the second-to-last rule line onward (the live
// box), then return everything after the LAST ❯ line in what remains.
function extractLastReply(paneText) {
  if (!paneText) return null;
  const lines = paneText.split('\n');

  const ruleIndices = [];
  lines.forEach((line, i) => { if (/─{5,}/.test(line)) ruleIndices.push(i); });
  // Fewer than 2 rule lines means the live input box's boundary can't be
  // reliably located in this capture — bail rather than risk treating an
  // unsent draft line (or the box itself) as settled history.
  if (ruleIndices.length < 2) return null;
  const boxStart = ruleIndices[ruleIndices.length - 2];
  const history = lines.slice(0, boxStart);

  let lastPromptIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (/^❯\s/.test(history[i].trim())) { lastPromptIdx = i; break; }
  }

  // Each line is right-padded with spaces to the pane's fixed width — strip that.
  const reply = history.slice(lastPromptIdx + 1).map((l) => l.replace(/\s+$/, '')).join('\n').trim();
  return reply || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the pane until output goes quiet (no change for quietMs) or timeoutMs
// elapses, then extracts the reply from the final capture. Uses a wider
// capture window than the prompt-detection path (capturePane's default 50
// lines) since a real reply plus its preceding ❯ line can run longer.
async function waitForReply(paneId, opts) {
  opts = opts || {};
  const pollMs = opts.pollMs || 800;
  const quietMs = opts.quietMs || 1500;
  const timeoutMs = opts.timeoutMs || 45000;
  const captureLines = opts.captureLines || 300;

  const start = Date.now();
  let prev = null;
  let lastChangeAt = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    const text = await capturePane(paneId, captureLines);
    if (text === null) return null; // pane gone

    // "esc to interrupt" is Claude Code's own live-generation marker (verified
    // empirically — present only while actively generating, gone at rest).
    // Text-diffing alone isn't enough: the animated status line ("Thinking…
    // 4s") can happen to read identical across two polls if it lands on the
    // same second, causing a false "quiet" reading mid-response. Treat any
    // busy capture as a change regardless of whether the text matches.
    const busy = /esc to interrupt/i.test(text);
    if (busy || prev === null || text !== prev) lastChangeAt = Date.now();
    prev = text;
    if (!busy && Date.now() - lastChangeAt >= quietMs) break;
  }

  return prev ? extractLastReply(prev) : null;
}

module.exports.sendKeysToPane = sendKeysToPane;
module.exports.extractLastReply = extractLastReply;
module.exports.waitForReply = waitForReply;
module.exports.verifyPaneMapping = verifyPaneMapping;
module.exports.isPaneBusy = isPaneBusy;
module.exports.markPaneBusy = markPaneBusy;
module.exports.markPaneFree = markPaneFree;
