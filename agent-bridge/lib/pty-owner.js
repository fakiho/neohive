'use strict';

// Per-agent PTY owner process (Story 1.1, node-pty Agent Launcher).
//
// Architecture (ARCHITECTURE-SPINE.md, AD-1/AD-2/AD-3/AD-6/AD-7):
//   CLI process (PTY slave) -> this owner (PTY master, captures + redacts)
//     -> durable sink (.neohive/agent-log-{agent}.jsonl)
//     -> agents.json (PID registration / liveness authority)
//     -> .neohive/pty-{agent}.sock (reserved here, served by Story 1.3)
//
// Scope boundary: this module is CLI-agnostic — it owns a PTY running an
// arbitrary `command`/`args`/`env`, and knows nothing about which agent CLI
// (claude/gemini/codex/opencode/cursor) it is running. Resolving a CLI name
// to a concrete command/argv/env is the launcher's job (Story 1.2,
// lib/pty-cli-launcher.js), which reuses tmux-cli-launcher.js's existing
// getCliSpec/findExecutable/buildNativeCliEnvArgs helpers.
//
// This module is meant to run as a standalone, detached process (spawned by
// the launcher with `detached: true` + `.unref()`) so the PTY master fd is
// never held by the dashboard or an MCP server process (AD-1) — a dashboard
// restart must never kill a running agent (NFR-1).

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./file-io');
// Story 1.5 (FR-9, AD-4): optional tmux display mirror. Purely additive and
// best-effort — see lib/pty-tmux-mirror.js's module doc for the AD-4
// contract (never a hard dependency; silently disabled if unconfigured or
// tmux is unavailable).
const ptyTmuxMirror = require('./pty-tmux-mirror');

let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e;
}

// --- Secret redaction (AD-7, NFR-5) ---
//
// Best-effort, pattern-based redaction applied to every captured chunk
// before it is persisted. Not a substitute for not leaking secrets to a
// terminal in the first place — just a defense-in-depth layer so a captured
// agent-log-*.jsonl file is less dangerous than the raw PTY stream.
const REDACTION_PATTERNS = [
  { id: 'aws-access-key-id', regex: /AKIA[0-9A-Z]{16}/g },
  { id: 'bearer-token', regex: /Bearer\s+[A-Za-z0-9\-_.]{20,}/g },
  {
    id: 'key-value-secret',
    regex: /((?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*)(['"]?)([A-Za-z0-9\-_./+=]{12,})\2/gi,
    replace: (_m, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`,
  },
  { id: 'pem-private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

function redact(text) {
  let out = text;
  for (const p of REDACTION_PATTERNS) {
    out = typeof p.replace === 'function' ? out.replace(p.regex, p.replace) : out.replace(p.regex, '[REDACTED]');
  }
  return out;
}

// --- Naming / path helpers ---

function sanitizeAgentName(name) {
  const safe = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
  if (!safe) throw new Error(`Invalid agent name "${name}": must be 1-20 alphanumeric/underscore/hyphen chars`);
  return safe;
}

function agentLogPath(dataDir, agentName) {
  return path.join(dataDir, `agent-log-${sanitizeAgentName(agentName)}.jsonl`);
}

function agentSocketPath(dataDir, agentName) {
  return path.join(dataDir, `pty-${sanitizeAgentName(agentName)}.sock`);
}

function agentsJsonPath(dataDir) {
  return path.join(dataDir, 'agents.json');
}

// --- agents.json registration (AD-6: registry is the single liveness authority) ---

function writeAgentsJsonAtomic(dataDir, agents) {
  const file = agentsJsonPath(dataDir);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(agents, null, 2));
  fs.renameSync(tmp, file);
}

function readAgentsJson(dataDir) {
  try { return JSON.parse(fs.readFileSync(agentsJsonPath(dataDir), 'utf8')); }
  catch { return {}; }
}

// Registers/updates the agent's PID in agents.json (FR-7). Best-effort under
// lock — a registration failure must never crash the owner or leave the PTY
// dangling; callers already have the log file as the source of truth.
function registerPid(dataDir, agentName, pid) {
  try {
    withFileLock(agentsJsonPath(dataDir), () => {
      const agents = readAgentsJson(dataDir);
      const nowIso = new Date().toISOString();
      agents[agentName] = Object.assign({}, agents[agentName], {
        pid,
        last_activity: nowIso,
        pty_owner: true,
        pty_owner_pid: process.pid,
      });
      writeAgentsJsonAtomic(dataDir, agents);
    });
  } catch { /* best-effort — log file remains authoritative for capture */ }
}

// Removes the agent from agents.json on exit (FR-8, AD-6). Idempotent — safe
// to call even if the entry is already gone (e.g. manual deletion raced us).
function unregisterAgent(dataDir, agentName) {
  try {
    withFileLock(agentsJsonPath(dataDir), () => {
      const agents = readAgentsJson(dataDir);
      if (agents[agentName]) {
        delete agents[agentName];
        writeAgentsJsonAtomic(dataDir, agents);
      }
    });
  } catch { /* best-effort */ }
}

// --- Durable log sink (AD-2: the log is the source of truth, not the ring buffer) ---

function appendLogLine(dataDir, agentName, payload) {
  const line = JSON.stringify(payload) + '\n';
  // 0o600: the log may contain agent output; inherit restrictive .neohive perms (AD-7).
  fs.appendFileSync(agentLogPath(dataDir, agentName), line, { mode: 0o600 });
}

// Returns the redacted string that was written, so callers (the Story 1.5
// tmux mirror) can reuse the exact same redacted text instead of redacting
// twice — guarantees the mirror can never show a secret the log hid.
function appendDataChunk(dataDir, agentName, data) {
  const redacted = redact(data);
  appendLogLine(dataDir, agentName, {
    ts: new Date().toISOString(),
    agent: agentName,
    data: redacted,
  });
  return redacted;
}

function appendExitMarker(dataDir, agentName, { exitCode, signal }) {
  appendLogLine(dataDir, agentName, {
    ts: new Date().toISOString(),
    agent: agentName,
    event: 'agent_exit',
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    signal: signal || null,
  });
}

// Idempotent — Story 1.3 owns actually creating/serving this socket; Story
// 1.1 only needs to guarantee cleanup never leaves a stale socket file
// behind regardless of which story created it (AD-3: stale sockets with no
// live PID must be ignorable/removable).
function unlinkSocketIfPresent(dataDir, agentName) {
  try {
    const sockPath = agentSocketPath(dataDir, agentName);
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
  } catch { /* best-effort */ }
}

/**
 * Spawn `command`/`args` inside a real PTY, tee its output to the durable
 * per-agent log, register its PID in agents.json, and clean up fully on
 * exit. CLI-agnostic — callers (the launcher, Story 1.2) resolve which
 * binary/argv/env to pass.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - project .neohive data directory
 * @param {string} opts.agentName - 1-20 char alphanumeric/underscore/hyphen name
 * @param {string} opts.command - executable to run (already resolved, e.g. via findExecutable)
 * @param {string[]} [opts.args] - argv for the command
 * @param {object} [opts.env] - extra environment variables (merged over process.env)
 * @param {string} [opts.cwd] - working directory (defaults to process.cwd())
 * @param {number} [opts.cols] - initial PTY columns (default 220 per architecture)
 * @param {number} [opts.rows] - initial PTY rows (default 50 per architecture)
 * @returns {{pid:number, logPath:string, socketPath:string, write:Function, resize:Function, kill:Function, onExit:Function}}
 * @throws {Error} with `.code` set to `PTY_UNAVAILABLE` (node-pty failed to
 *   load — the launcher should fall back to tmux, AD-5) or `BIN_NOT_FOUND`
 *   (the command could not be spawned — FR-3).
 */
function startOwner(opts) {
  const { dataDir, agentName: rawAgentName, command, args = [], env = {}, cwd, cols = 220, rows = 50 } = opts || {};

  if (!dataDir) throw new Error('startOwner requires dataDir');
  if (!command) throw new Error('startOwner requires command');
  const agentName = sanitizeAgentName(rawAgentName);

  if (!pty) {
    const err = new Error(`node-pty is unavailable: ${ptyLoadError ? ptyLoadError.message : 'module failed to load'}`);
    err.code = 'PTY_UNAVAILABLE';
    throw err;
  }

  // Best-effort session detach (AD-1). The launcher is expected to have
  // spawned this process with {detached: true} + .unref() already; calling
  // setsid() here too is defensive belt-and-suspenders for the case this
  // module is invoked directly. setsid() throws if this process is already
  // a process-group leader (e.g. already detached) — safe to ignore.
  try { if (typeof process.setsid === 'function') process.setsid(); } catch { /* already detached, or unsupported platform */ }

  // FR-3: fail synchronously and cleanly if the binary isn't resolvable,
  // rather than letting node-pty fork and fail asynchronously inside the
  // child (see resolveCommandPath's doc comment).
  const resolvedCommand = resolveCommandPath(command);
  if (!resolvedCommand) {
    const err = new Error(`Executable not found on PATH: "${command}"`);
    err.code = 'BIN_NOT_FOUND';
    err.command = command;
    throw err;
  }

  let term;
  try {
    term = pty.spawn(resolvedCommand, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || process.cwd(),
      env: Object.assign({}, process.env, env),
    });
  } catch (e) {
    // Defensive fallback for any other synchronous node-pty spawn failure
    // (e.g. cwd doesn't exist) not caught by the preflight check above.
    const err = new Error(`Failed to spawn "${command}": ${e.message}`);
    err.code = 'BIN_NOT_FOUND';
    err.command = command;
    throw err;
  }

  const logPath = agentLogPath(dataDir, agentName);
  const socketPath = agentSocketPath(dataDir, agentName);

  // FR-7 / AD-6: register PID within 200ms of spawn (synchronous, well under budget).
  registerPid(dataDir, agentName, term.pid);

  let exited = false;
  const exitListeners = [];

  // Story 1.5 (FR-9, AD-4): opt-in tmux display mirror. startMirror() is
  // always safe to call — it checks config.json's terminal.tmux_session and
  // tmux availability itself, and silently no-ops (never throws, never
  // blocks) if either is absent. Core PTY capture/routing above is fully
  // set up and running before this line, so mirroring is strictly additive.
  const mirror = ptyTmuxMirror.startMirror({ dataDir, projectDir: cwd, agentName });

  term.onData((data) => {
    let redacted;
    try { redacted = appendDataChunk(dataDir, agentName, data); }
    catch { /* a log-write failure must never crash the owner or kill the PTY */ }
    if (redacted !== undefined) {
      try { mirror.write(redacted); } catch { /* best-effort — never affects the primary PTY (AD-4) */ }
    }
  });

  term.onExit(({ exitCode, signal }) => {
    if (exited) return; // onExit should fire once, but guard against double-fire defensively
    exited = true;
    try { appendExitMarker(dataDir, agentName, { exitCode, signal }); } catch { /* best-effort */ }
    unregisterAgent(dataDir, agentName); // FR-8, AD-6
    unlinkSocketIfPresent(dataDir, agentName); // FR-8, AD-3 — no leaked stale socket
    try { mirror.stop(); } catch { /* best-effort */ }
    for (const fn of exitListeners) {
      try { fn({ exitCode, signal }); } catch { /* one listener's failure must not break others */ }
    }
  });

  return {
    pid: term.pid,
    agentName,
    logPath,
    socketPath,
    // Story 1.5: informational only — the mirror file backing the optional
    // tmux display window, if/when mirroring activates (config-gated, AD-4).
    // Not part of the core contract other modules (launcher, socket server)
    // depend on.
    mirrorPath: ptyTmuxMirror.mirrorFilePath(dataDir, agentName),
    // Reserved for Story 1.3 (live input/resize over the per-agent socket) —
    // exposed now so the socket-server story doesn't need to reach back into
    // this module's internals; the owner remains the sole pty.write() caller (AD-3).
    write(data) { if (!exited) term.write(data); },
    resize(newCols, newRows) { if (!exited) term.resize(newCols, newRows); },
    kill(signal) { if (!exited) term.kill(signal); },
    isExited() { return exited; },
    onExit(fn) { if (typeof fn === 'function') exitListeners.push(fn); },
  };
}

function isPtyAvailable() {
  return pty !== null;
}

// Preflight PATH/executable-bit check (mirrors tmux-cli-launcher.js's
// findExecutable). Required because node-pty does NOT throw synchronously
// for a missing binary — it forks successfully and the child's execvp(3)
// failure only surfaces later as PTY *data* (e.g. "execvp(3) failed.: No
// such file or directory") followed by a nonzero exit. Checking PATH up
// front turns that into the clean, synchronous BIN_NOT_FOUND error FR-3
// requires, instead of a race-prone data/exit-code guess after the fact.
function resolveCommandPath(command) {
  if (command.includes(path.sep)) {
    try { fs.accessSync(command, fs.constants.X_OK); return command; }
    catch { return null; }
  }
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { /* keep searching */ }
  }
  return null;
}

module.exports = {
  startOwner,
  isPtyAvailable,
  sanitizeAgentName,
  agentLogPath,
  agentSocketPath,
  agentsJsonPath,
  // Exposed for focused testing without spawning a real PTY.
  __test__: { redact, REDACTION_PATTERNS, registerPid, unregisterAgent, readAgentsJson, unlinkSocketIfPresent, resolveCommandPath, ptyTmuxMirror },
};

// --- Standalone CLI entry point ---
//
// Usage: node lib/pty-owner.js '<json-config>'
// config: { dataDir, agentName, command, args, env, cwd, cols, rows }
//
// Intended caller: the launcher (Story 1.2), which spawns this file with
// {detached: true, stdio: 'ignore'} and calls .unref() so the master fd is
// never held by the launching (dashboard/MCP) process (AD-1).
if (require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    console.error('[pty-owner] usage: node lib/pty-owner.js \'<json-config>\'');
    process.exit(1);
  }
  let config;
  try { config = JSON.parse(raw); }
  catch (e) {
    console.error('[pty-owner] invalid JSON config:', e.message);
    process.exit(1);
  }
  try {
    const owner = startOwner(config);
    // Story 1.3: serve live input/resize on the per-agent socket. Lives in this
    // process because the owner must stay the sole pty.write() caller (AD-3).
    // Lazy-required so programmatic importers of startOwner() don't pull it in;
    // a socket-server failure must never prevent the agent from running.
    try {
      require('./pty-socket-server').startSocketServer(owner, {
        log: (m) => process.stderr.write(m + '\n'),
      });
    } catch (e) {
      console.error('[pty-owner] socket server failed to start:', e.message);
    }
    owner.onExit(({ exitCode }) => { process.exit(typeof exitCode === 'number' ? exitCode : 0); });
  } catch (e) {
    console.error(`[pty-owner] failed to start (${e.code || 'ERROR'}):`, e.message);
    process.exit(1);
  }
}
