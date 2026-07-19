'use strict';

// Story 1.5: optional tmux display surface for the node-pty owner (FR-9, AD-4).
//
// Kept as a standalone module (rather than inline in lib/pty-owner.js) so it
// can be added to the owner with a minimal, additive footprint: pty-owner.js
// only needs to call startMirror() once at spawn time and write()/stop() at
// the same points it already writes to the durable log — the actual tmux
// plumbing lives entirely here.
//
// AD-4 (tmux is a display surface only, never a runtime dependency): every
// operation in this module is best-effort and fire-and-forget. If tmux is
// unavailable, misconfigured, or any step fails, mirroring silently does not
// happen — it must NEVER throw into, block, or otherwise affect the primary
// PTY capture/routing path.
//
// Callers MUST pass already-redacted data to write() (the same string
// already computed for the durable log in pty-owner.js) — this module does
// not re-redact, to guarantee the mirror can never show a secret the log
// itself would have hidden.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getSessionName, ensureSession } = require('./tmux-cli-launcher');

const EXEC_TIMEOUT_MS = 5000;
const MAX_PENDING_CHUNKS = 1000; // defensive cap while mirror setup is still in flight

function execTmux(args, timeout = EXEC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = (stderr || error.message || 'tmux command failed').trim();
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

// Given AC: "Given terminal.tmux_session is configured and tmux is
// available..." — mirrors tmux-cli-launcher.js's getSessionName() config
// convention, but distinguishes "explicitly configured" from that
// function's own 'neohive' fallback default, since the mirror is opt-in
// (an unconfigured project must get zero tmux involvement, AD-4).
function isConfigured(dataDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const configured = config.terminal && config.terminal.tmux_session;
    return typeof configured === 'string' && /^[A-Za-z0-9_-]+$/.test(configured);
  } catch {
    return false;
  }
}

function isTmuxAvailable() {
  return new Promise((resolve) => {
    execFile('tmux', ['-V'], { timeout: 3000 }, (err) => resolve(!err));
  });
}

function mirrorFilePath(dataDir, agentName) {
  return path.join(dataDir, `agent-mirror-${agentName}.raw`);
}

function sanitizeWindowName(name) {
  return String(name || 'mirror').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50) || 'mirror';
}

/**
 * Best-effort, fire-and-forget tmux display mirror for one agent's PTY
 * output. Returns immediately with a handle whose write()/stop() are always
 * safe to call regardless of whether setup has completed, failed, or is
 * disabled (mirroring not configured / tmux unavailable) — the caller never
 * needs to check readiness.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - project .neohive data directory
 * @param {string} [opts.projectDir] - working directory for the mirror tmux window
 * @param {string} opts.agentName - sanitized agent name (already validated by the caller)
 * @param {string} [opts.windowName] - tmux window name (defaults to `mirror-{agentName}`)
 * @returns {{write:(data:string)=>void, stop:()=>void}}
 */
function startMirror({ dataDir, projectDir, agentName, windowName }) {
  let ready = false;
  let disabled = false;
  let mirrorFd = null;
  const pending = [];
  const mirrorPath = mirrorFilePath(dataDir, agentName);

  (async () => {
    try {
      if (!isConfigured(dataDir)) { disabled = true; return; }
      const available = await isTmuxAvailable();
      if (!available) { disabled = true; return; }

      const sessionName = getSessionName(dataDir);
      await ensureSession(sessionName, projectDir || process.cwd());

      const safeWindow = sanitizeWindowName(windowName || `mirror-${agentName}`);
      // tail -f needs a file to already exist before it attaches.
      fs.writeFileSync(mirrorPath, '');

      // Idempotent-ish: reuse an existing window with this name rather than
      // piling up duplicate mirror windows across repeated launches of the
      // same agent name.
      let windowExists = false;
      try {
        const list = await execTmux(['list-windows', '-t', sessionName, '-F', '#{window_name}']);
        windowExists = list.split('\n').includes(safeWindow);
      } catch { /* has-session/list-windows failing just means we (re)create it below */ }

      if (!windowExists) {
        await execTmux(['new-window', '-d', '-t', sessionName, '-n', safeWindow, '-c', projectDir || process.cwd(), 'tail', '-f', mirrorPath]);
      }

      mirrorFd = fs.openSync(mirrorPath, 'a');
      ready = true;
      for (const chunk of pending.splice(0)) {
        try { fs.writeSync(mirrorFd, chunk); } catch { /* best-effort */ }
      }
      // stop() may have already been called while this async setup was still
      // in flight (common for fast-exiting commands — tmux round-trips take
      // real wall-clock time). Rather than dropping everything buffered
      // before that point (the old behavior), we still flush it above so
      // the display file reflects what the agent actually said; we just
      // don't leave the fd open past a stop() that already happened.
      if (disabled && mirrorFd !== null) {
        try { fs.closeSync(mirrorFd); } catch { /* already closed */ }
        mirrorFd = null;
      }
    } catch {
      // Any setup failure (tmux missing mid-flight, permission error, race
      // with a concurrent session teardown, ...) disables mirroring
      // silently — the primary PTY owner is never affected (AD-4).
      disabled = true;
    }
  })();

  return {
    write(data) {
      if (disabled) return;
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(data);
        return;
      }
      try { fs.writeSync(mirrorFd, data); } catch { /* best-effort — never affects the caller */ }
    },
    stop() {
      // Prevents any FUTURE write() calls from queuing new pending data.
      // Deliberately does NOT clear `pending` — if async setup is still in
      // flight (common for fast-exiting commands, since tmux round-trips
      // take real wall-clock time), it will still flush whatever was
      // already buffered when it completes, then close immediately after
      // (see the `disabled` check right after the flush in startMirror's
      // setup IIFE). This is best-effort display fidelity, never a
      // durability guarantee — the redacted log file remains authoritative.
      disabled = true;
      if (mirrorFd !== null) {
        try { fs.closeSync(mirrorFd); } catch { /* already closed */ }
        mirrorFd = null;
      }
    },
  };
}

module.exports = {
  startMirror,
  isConfigured,
  isTmuxAvailable,
  mirrorFilePath,
  __test__: { sanitizeWindowName, execTmux },
};
