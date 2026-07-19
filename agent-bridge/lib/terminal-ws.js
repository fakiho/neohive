'use strict';

// Interactive terminal over WebSocket, backed by a real pty (node-pty) attached
// to a shared tmux session. node-pty is an optionalDependency — when it isn't
// installed, attachTerminal() degrades to a clean error message instead of
// throwing, matching lib/github-sync.js's isConfigured()-guarded no-op pattern.
//
// PTY socket bridge (Story 1.3): attachPtySocket() connects to the per-agent
// unix domain socket created by lib/pty-socket-server.js and tails the
// agent-log-{agent}.jsonl for output, bridging a WebSocket to a PTY-launched
// agent without needing node-pty in the dashboard process.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { getConfig } = require('./config');
const { getAgents, isPidAlive } = require('./agents');
const tmuxAgentState = require('./tmux-agent-state');

const DEFAULT_SESSION = 'neohive';
const SESSION_NAME_RE = /^[A-Za-z0-9_-]+$/;
const CONTROL_ACTIONS = new Set([
  'window_previous', 'window_next', 'new_window',
  'pane_left', 'pane_right', 'pane_up', 'pane_down',
  'split_left_right', 'split_top_bottom', 'close_pane', 'focus_pane', 'get_state',
]);
const controlQueues = new Map();

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

function execTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || 'tmux command failed').trim()));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function resolveTerminalClient(sessionName, ptyPid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const output = await execTmux(['list-clients', '-F', '#{client_name}\t#{client_pid}\t#{session_name}']);
      const match = output.split('\n').map((line) => line.split('\t')).find((parts) =>
        parts[1] === String(ptyPid) && parts[2] === sessionName);
      if (match && match[0]) return match[0];
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function getTmuxState(sessionName, clientName) {
  const format = '#{window_index}\t#{session_windows}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{window_panes}';
  const args = ['display-message', '-p'];
  if (clientName) args.push('-c', clientName);
  else args.push('-t', sessionName);
  args.push(format);
  const output = await execTmux(args);
  const [windowIndex, windowCount, windowName, windowId, paneId, paneCount] = output.split('\t');
  return {
    windowIndex: Number(windowIndex),
    windowCount: Number(windowCount),
    windowName,
    windowId,
    paneId,
    paneCount: Number(paneCount),
    canClosePane: Number(paneCount) > 1,
  };
}

async function liveAgentInPane(paneId) {
  const agents = getAgents(true);
  for (const [name, info] of Object.entries(agents)) {
    if (!info) continue;
    if (!isPidAlive(info.pid, info.last_activity)) continue;
    if (info.tmux && info.tmux.pane_id === paneId &&
      await tmuxAgentState.verifyPaneMapping(info.pid, paneId).catch(() => false)) return name;
    const mapping = await tmuxAgentState.resolvePaneForPid(info.pid).catch(() => null);
    if (mapping && mapping.pane_id === paneId) return name;
  }
  return null;
}

async function focusTmuxPane(sessionName, paneId, clientName) {
  if (!/^%\d+$/.test(paneId || '')) throw new Error('Invalid tmux pane ID');
  const target = await execTmux([
    'display-message', '-p', '-t', paneId,
    '#{session_name}\t#{window_index}',
  ]);
  const [targetSession, windowIndex] = target.split('\t');
  if (targetSession !== sessionName || !/^\d+$/.test(windowIndex || '')) {
    throw new Error('Agent pane is not in the dashboard tmux session');
  }

  await execTmux(['select-pane', '-t', paneId]);
  if (clientName) {
    await execTmux(['switch-client', '-c', clientName, '-t', `${sessionName}:${windowIndex}`]);
  } else {
    await execTmux(['select-window', '-t', `${sessionName}:${windowIndex}`]);
  }
}

async function executeTmuxControl(sessionName, action, clientName, options) {
  if (!CONTROL_ACTIONS.has(action)) throw new Error('Unsupported tmux control action');
  let state = await getTmuxState(sessionName, clientName);
  if (action === 'get_state') return state;

  if (action === 'focus_pane') {
    await focusTmuxPane(sessionName, options && options.paneId, clientName);
  } else if (action === 'window_previous') {
    await execTmux(['select-window', '-t', `${sessionName}:-`]);
  } else if (action === 'window_next') {
    await execTmux(['select-window', '-t', `${sessionName}:+`]);
  } else if (action === 'new_window') {
    await execTmux(['new-window', '-t', sessionName, '-c', '#{pane_current_path}']);
  } else if (action.startsWith('pane_')) {
    const direction = {
      pane_left: '-L', pane_right: '-R', pane_up: '-U', pane_down: '-D',
    }[action];
    await execTmux(['select-pane', '-t', state.paneId, direction]);
  } else if (action === 'split_left_right') {
    await execTmux(['split-window', '-h', '-t', state.paneId, '-c', '#{pane_current_path}']);
  } else if (action === 'split_top_bottom') {
    await execTmux(['split-window', '-v', '-t', state.paneId, '-c', '#{pane_current_path}']);
  } else if (action === 'close_pane') {
    if (state.paneCount <= 1) throw new Error('Cannot close the final pane in a window');
    const agentName = await liveAgentInPane(state.paneId);
    if (agentName) throw new Error(`Cannot close pane: live agent "${agentName}" is running there`);
    await execTmux(['kill-pane', '-t', state.paneId]);
  }
  state = await getTmuxState(sessionName, clientName);
  return state;
}

function queueTmuxControl(sessionName, action, clientName, options) {
  const queueKey = `${sessionName}:${clientName || 'session'}`;
  const previous = controlQueues.get(queueKey) || Promise.resolve();
  const next = previous.then(() => executeTmuxControl(sessionName, action, clientName, options));
  controlQueues.set(queueKey, next.catch(() => {}));
  return next;
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
  const clientNamePromise = resolveTerminalClient(sessionName, ptyProcess.pid);

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

  let controlWindowStarted = Date.now();
  let controlCount = 0;
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string' && Buffer.byteLength(msg.data, 'utf8') <= 65536) {
      ptyProcess.write(msg.data);
    } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows) &&
      msg.cols >= 10 && msg.cols <= 500 && msg.rows >= 5 && msg.rows <= 300) {
      try { ptyProcess.resize(msg.cols, msg.rows); } catch { /* pty may have just exited */ }
    } else if (msg.type === 'tmux-control' && typeof msg.action === 'string') {
      const now = Date.now();
      if (now - controlWindowStarted >= 1000) {
        controlWindowStarted = now;
        controlCount = 0;
      }
      controlCount += 1;
      if (controlCount > 20) {
        send(ws, { type: 'tmux-control-result', requestId: msg.requestId || null, ok: false, error: 'Tmux control rate limit exceeded' });
        return;
      }
      try {
        const clientName = await clientNamePromise;
        const state = await queueTmuxControl(sessionName, msg.action, clientName, {
          paneId: msg.paneId,
        });
        send(ws, { type: 'tmux-control-result', requestId: msg.requestId || null, ok: true, state });
      } catch (error) {
        send(ws, { type: 'tmux-control-result', requestId: msg.requestId || null, ok: false, error: error.message });
      }
    }
  });

  ws.on('close', () => {
    try { ptyProcess.kill(); } catch { /* already dead */ }
  });

  clientNamePromise.then((clientName) => queueTmuxControl(sessionName, 'get_state', clientName))
    .then((state) => send(ws, { type: 'tmux-control-result', requestId: null, ok: true, state }))
    .catch(() => {});
}

// ===================== PTY SOCKET BRIDGE (Story 1.3) =====================

// Scan dataDir for live pty-*.sock files, cross-referencing agents.json PIDs.
// Returns Map<agentName, socketPath> for agents whose owner process is alive.
// Stale sockets (dead owner PID) are skipped — AD-3: callers treat them as absent.
function discoverPtySockets(dataDir) {
  const result = new Map();
  try {
    const files = fs.readdirSync(dataDir);
    let agents = {};
    try { agents = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8')); } catch {}
    for (const f of files) {
      const m = f.match(/^pty-(.+)\.sock$/);
      if (!m) continue;
      const agentName = m[1];
      const sockPath = path.join(dataDir, f);
      const info = agents[agentName];
      if (!info || !info.pty_owner) continue;
      const ownerPid = info.pty_owner_pid;
      if (!ownerPid) continue;
      try {
        process.kill(ownerPid, 0); // throws ESRCH if dead
        result.set(agentName, sockPath);
      } catch {
        // stale — owner process is gone
      }
    }
  } catch {}
  return result;
}

// Attach a WebSocket to a PTY-launched agent's input/output:
//   • OUTPUT: tail agent-log-{agent}.jsonl from current EOF, emit {type:'output', data} frames
//   • INPUT/RESIZE: forward {type:'input'|'resize'} frames to the per-agent unix socket
// No node-pty required in the dashboard process — the owner process holds the fd.
function attachPtySocket(ws, { agentName, socketPath, logPath }) {
  let closed = false;
  let sock = null;
  let logWatcher = null;
  let logOffset = 0;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (logWatcher) try { logWatcher.close(); } catch {}
    if (sock) try { sock.destroy(); } catch {}
    try { ws.close(); } catch {}
  }

  // Drain new data from the agent log and forward to browser as terminal output.
  function drainLog() {
    if (closed) return;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size <= logOffset) return;
      const len = stat.size - logOffset;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, len, logOffset);
      fs.closeSync(fd);
      logOffset = stat.size;
      const lines = buf.toString('utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.data === 'string') {
            send(ws, { type: 'output', data: entry.data });
          } else if (entry.event === 'agent_exit') {
            send(ws, { type: 'exit' });
          }
        } catch {}
      }
    } catch {}
  }

  // Start tailing the log. Seed offset from current EOF so we only stream new output.
  try {
    if (fs.existsSync(logPath)) logOffset = fs.statSync(logPath).size;
  } catch {}
  try {
    logWatcher = fs.watch(path.dirname(logPath), (evt, filename) => {
      if (filename === path.basename(logPath)) drainLog();
    });
    logWatcher.on('error', () => {});
  } catch {}

  // Connect to the per-agent unix socket for input/resize (Story 1.3, AD-3).
  if (!fs.existsSync(socketPath)) {
    send(ws, { type: 'error', data: `PTY socket not found for ${agentName}. Is the agent running via PTY launcher?` });
    cleanup();
    return;
  }

  sock = net.createConnection(socketPath);
  sock.on('connect', () => {
    send(ws, { type: 'output', data: `\x1b[33m[Neohive]\x1b[0m PTY agent: ${agentName}\r\n` });
    // Drain any log data written while we were connecting.
    drainLog();
  });
  sock.on('error', (e) => {
    send(ws, { type: 'error', data: `PTY socket error (${agentName}): ${e.message}` });
    cleanup();
  });
  sock.on('close', () => {
    if (!closed) send(ws, { type: 'exit' });
    cleanup();
  });

  // Forward input/resize from browser → unix socket as NDJSON frames.
  ws.on('message', (raw) => {
    if (closed || !sock || sock.destroyed) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string' &&
        Buffer.byteLength(msg.data, 'utf8') <= 65536) {
      sock.write(JSON.stringify({ type: 'input', data: msg.data }) + '\n');
    } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows) &&
        msg.cols >= 10 && msg.cols <= 500 && msg.rows >= 5 && msg.rows <= 300) {
      sock.write(JSON.stringify({ type: 'resize', cols: msg.cols, rows: msg.rows }) + '\n');
    }
    // tmux-control messages are not applicable in PTY mode — silently ignored.
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

// ==========================================================================

module.exports = {
  CONTROL_ACTIONS,
  isPtyAvailable,
  getTerminalConfig,
  resolveTerminalClient,
  getTmuxState,
  focusTmuxPane,
  executeTmuxControl,
  attachTerminal,
  attachPtySocket,
  discoverPtySockets,
};
