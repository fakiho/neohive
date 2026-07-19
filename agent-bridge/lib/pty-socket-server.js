'use strict';

// Per-agent live input/resize socket server (Story 1.3).
//
// Runs INSIDE the PTY owner process (Story 1.1) — the only process holding the
// node-pty master fd — so it can honor AD-3: the owner remains the sole caller
// of pty.write(). The dashboard terminal widget (client) connects to the
// per-agent unix domain socket and sends control frames; agent OUTPUT is not
// served here (consumers tail .neohive/agent-log-{agent}.jsonl per AD-2) — this
// socket carries input and resize only.
//
// Wire protocol: newline-delimited JSON frames, one per line:
//   {"type":"input","data":"<string>"}     → owner.write(data)   (FR-10; "\x03" = Ctrl-C/SIGINT)
//   {"type":"resize","cols":<n>,"rows":<n>} → owner.resize(cols,rows) (FR-2)
// Unknown types and malformed lines are ignored (never crash the owner).
//
// AD-3 "last input connection wins": any number of clients may connect, but
// only the most recently connected client's INPUT frames are applied; resize
// from any client is honored (it is idempotent and non-conflicting).

const fs = require('fs');
const net = require('net');

const MAX_LINE_BYTES = 1 << 20; // 1 MB guard against an unbounded partial line

/**
 * Start the live control socket for one agent.
 *
 * @param {object} owner - handle returned by pty-owner.startOwner():
 *   { agentName, socketPath, write(data), resize(cols,rows), isExited(), onExit(fn) }
 * @param {object} [opts]
 * @param {string} [opts.socketPath] - override owner.socketPath (mainly for tests)
 * @param {(msg:string)=>void} [opts.log] - optional stderr-style logger
 * @returns {{ close: () => void, socketPath: string }}
 */
function startSocketServer(owner, opts = {}) {
  if (!owner || typeof owner.write !== 'function' || typeof owner.resize !== 'function') {
    throw new Error('startSocketServer requires a pty-owner handle with write()/resize()');
  }
  const socketPath = opts.socketPath || owner.socketPath;
  if (!socketPath) throw new Error('startSocketServer requires a socketPath');
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  // Unix domain socket paths are capped by the OS (sun_path ≈ 104-108 bytes).
  // A very deep project path can exceed it; listen() then fails EINVAL. We
  // degrade gracefully (the agent still runs; output capture via the log is
  // unaffected) — but warn clearly so it's diagnosable rather than mysterious.
  if (Buffer.byteLength(socketPath) > 103) {
    log(`[pty-socket] socket path is ${Buffer.byteLength(socketPath)} bytes — may exceed the OS limit (~104); live input/resize may be unavailable for ${owner.agentName}`);
  }

  // A stale socket file from a prior run makes listen() fail with EADDRINUSE.
  // The path is agent-scoped and owned by us, so removing it is safe.
  try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { /* best-effort */ }

  // The connection that currently owns the input channel (AD-3: last wins).
  let activeInput = null;

  const server = net.createServer((socket) => {
    activeInput = socket; // newest connection takes the input channel
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE_BYTES) {
        // Drop an over-long unterminated line rather than grow unbounded.
        buffer = '';
        return;
      }
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line, socket);
      }
    });

    socket.on('error', () => { /* a client error must never crash the owner */ });
    socket.on('close', () => {
      if (activeInput === socket) activeInput = null;
    });
  });

  function handleLine(line, socket) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try { frame = JSON.parse(trimmed); }
    catch { return; } // malformed line — ignore
    if (!frame || typeof frame !== 'object') return;

    if (owner.isExited && owner.isExited()) return;

    try {
      if (frame.type === 'input') {
        // Only the most-recently-connected client may drive input (AD-3).
        if (socket !== activeInput) return;
        if (typeof frame.data === 'string') owner.write(frame.data);
      } else if (frame.type === 'resize') {
        const cols = Number(frame.cols);
        const rows = Number(frame.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
          owner.resize(Math.floor(cols), Math.floor(rows));
        }
      }
      // unknown frame.type: ignore
    } catch (e) {
      log(`[pty-socket] frame handling error: ${e.message}`);
    }
  }

  server.on('error', (e) => {
    log(`[pty-socket] server error for ${owner.agentName}: ${e.message}`);
  });

  server.listen(socketPath, () => {
    log(`[pty-socket] listening for ${owner.agentName} on ${socketPath}`);
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try { server.close(); } catch { /* best-effort */ }
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { /* best-effort */ }
  }

  // Tear down with the PTY: when the agent exits, stop accepting control frames
  // and remove the socket (the owner also unlinks defensively on exit).
  if (typeof owner.onExit === 'function') owner.onExit(close);

  return { close, socketPath };
}

module.exports = { startSocketServer };
