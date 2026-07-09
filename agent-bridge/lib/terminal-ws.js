'use strict';

// Interactive terminal over WebSocket, backed by a real pty (node-pty) attached
// to a shared tmux session. node-pty is an optionalDependency — when it isn't
// installed, attachTerminal() degrades to a clean error message instead of
// throwing, matching lib/github-sync.js's isConfigured()-guarded no-op pattern.

const { execFile } = require('child_process');
const { getConfig } = require('./config');

const DEFAULT_SESSION = 'neohive';
const SESSION_NAME_RE = /^[A-Za-z0-9_-]+$/;

let _ptyModule;
let _ptyChecked = false;

function isPtyAvailable() {
  if (!_ptyChecked) {
    _ptyChecked = true;
    try { _ptyModule = require('node-pty'); }
    catch { _ptyModule = null; }
  }
  return !!_ptyModule;
}

function getTerminalConfig() {
  const config = getConfig();
  let sessionName = (config.terminal && config.terminal.tmux_session) || process.env.NEOHIVE_TMUX_SESSION || DEFAULT_SESSION;
  if (typeof sessionName !== 'string' || !SESSION_NAME_RE.test(sessionName)) {
    sessionName = DEFAULT_SESSION;
  }
  return { sessionName };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket closing race — ignore */ }
  }
}

// Attaches a fresh pty to `sessionName` (creating it if it doesn't exist yet)
// and wires bidirectional relay to the given WebSocket. One pty per socket —
// closing the socket detaches (kills the pty client) without touching the
// tmux session itself, same as a normal SSH client disconnecting.
function attachTerminal(ws, { sessionName }) {
  if (!isPtyAvailable()) {
    send(ws, { type: 'error', data: 'Terminal unavailable — node-pty not installed. Run `npm install` and restart the dashboard.' });
    ws.close();
    return;
  }

  const env = Object.assign({}, process.env);
  delete env.TMUX; // avoid nested-tmux confusion if the dashboard process itself runs inside tmux

  let ptyProcess;
  try {
    ptyProcess = _ptyModule.spawn('tmux', ['new-session', '-A', '-s', sessionName], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: env.HOME || process.cwd(),
      env,
    });
  } catch (e) {
    send(ws, { type: 'error', data: 'Failed to start terminal: ' + e.message });
    ws.close();
    return;
  }

  // tmux's default (window-size latest/smallest, depending on version) sizes
  // a shared window to whichever client is smallest or most recently active
  // — if this session is also used directly by a human (not created fresh
  // for this connection), a small browser viewport attaching here can shrink
  // their entire real terminal. "largest" makes the window always follow the
  // biggest attached client instead, so this connection can never shrink it.
  // Best-effort: never let this block or fail the actual terminal attach.
  execFile('tmux', ['set-window-option', '-t', sessionName, 'window-size', 'largest'], () => {});

  ptyProcess.onData((data) => send(ws, { type: 'output', data }));

  ptyProcess.onExit(() => {
    send(ws, { type: 'exit' });
    try { ws.close(); } catch { /* already closing */ }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      ptyProcess.write(msg.data);
    } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      try { ptyProcess.resize(msg.cols, msg.rows); } catch { /* pty may have just exited */ }
    }
  });

  ws.on('close', () => {
    try { ptyProcess.kill(); } catch { /* already dead */ }
  });
}

module.exports = { isPtyAvailable, getTerminalConfig, attachTerminal };
