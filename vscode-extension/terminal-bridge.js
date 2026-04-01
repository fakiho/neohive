'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Strip ANSI escape sequences from terminal output
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[mGKHFJABCDEFGHnsuhr]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '');
}

function getServerUrl() {
  return vscode.workspace.getConfiguration('neohive').get('serverUrl', 'http://localhost:4321');
}

function postJson(serverUrl, path, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const isHttps = serverUrl.startsWith('https');
    const lib = isHttps ? https : http;
    let parsed;
    try { parsed = new URL(serverUrl + path); } catch { return resolve(false); }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 3000,
    };
    const req = lib.request(options, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

function isNeohiveTerminal(name) {
  const n = (name || '').toLowerCase();
  return n.includes('neohive') || n.includes('claude') || n.includes('gemini') ||
    n.includes('codex') || n.includes('cursor') || n.includes('agent');
}

function extractAgentName(terminalName) {
  // "Claude (ClaudeBackend)" → "ClaudeBackend", or fall back to full name
  const inParens = terminalName.match(/\(([^)]+)\)/);
  if (inParens) return inParens[1].trim();
  const firstWord = terminalName.match(/^(\S+)/);
  return firstWord ? firstWord[1] : terminalName;
}

/**
 * Create the terminal bridge disposable.
 * @param {vscode.ExtensionContext} context
 * @param {{ info: Function, warn: Function, error: Function }} log
 * @returns {{ dispose: Function, onAgentsUpdate: Function, bindAgentTerminal: Function, testTerminalBridge: Function }}
 */
function createTerminalBridge(context, log) {
  // terminal → { agentName: string, lastNudge: number }
  const agentTerminals = new Map();
  const disposables = [];
  const NUDGE_COOLDOWN_MS = 60000; // minimum 60s between listen() injections per terminal

  // Auto-detect agent terminals when they open
  disposables.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      if (isNeohiveTerminal(terminal.name)) {
        const agentName = extractAgentName(terminal.name);
        agentTerminals.set(terminal, { agentName, lastNudge: 0 });
        log.info(`[terminal-bridge] Auto-detected agent terminal: "${terminal.name}" → ${agentName}`);
      }
    })
  );

  // Clean up closed terminals
  disposables.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      agentTerminals.delete(terminal);
    })
  );

  // Scan already-open terminals at startup
  for (const terminal of vscode.window.terminals) {
    if (isNeohiveTerminal(terminal.name)) {
      agentTerminals.set(terminal, { agentName: extractAgentName(terminal.name), lastNudge: 0 });
    }
  }

  // Terminal output capture: onDidStartTerminalShellExecution (VS Code 1.93+)
  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        const terminal = e.terminal;
        if (!agentTerminals.has(terminal)) return;
        const { agentName } = agentTerminals.get(terminal);
        const serverUrl = getServerUrl();
        try {
          const stream = e.execution.read();
          let buffer = '';
          for await (const chunk of stream) {
            buffer += chunk;
          }
          const cleaned = stripAnsi(buffer).trim();
          if (!cleaned) return;
          await postJson(serverUrl, '/api/inject', {
            from: agentName || 'agent',
            to: '__user__',
            content: cleaned,
          });
        } catch (err) {
          log.warn(`[terminal-bridge] Output capture failed: ${err.message}`);
        }
      })
    );
  }

  /**
   * Called by pollData() each time agent list refreshes.
   * Injects listen() into terminals of agents that appear idle.
   * @param {Array|Object} agents
   */
  function onAgentsUpdate(agents) {
    if (!agents) return;
    const agentList = Array.isArray(agents) ? agents : Object.values(agents);
    const now = Date.now();

    for (const [terminal, info] of agentTerminals) {
      const { agentName, lastNudge } = info;
      if (!agentName) continue;
      if (now - lastNudge < NUDGE_COOLDOWN_MS) continue;

      const agent = agentList.find((a) => a.name === agentName);
      if (!agent) continue;

      const lastActivity = agent.last_activity ? new Date(agent.last_activity).getTime() : 0;
      const idleMs = now - lastActivity;
      const isIdle = !agent.is_listening && idleMs > 60000;

      if (isIdle) {
        // sendText with false = don't auto-execute (no Enter), agent's next prompt picks it up
        terminal.sendText('listen()', false);
        info.lastNudge = now;
        log.info(`[terminal-bridge] Nudged "${agentName}" with listen() (idle ${Math.round(idleMs / 1000)}s)`);
      }
    }
  }

  /**
   * Command: let the user pick a terminal and bind it to an agent name.
   */
  async function bindAgentTerminal() {
    const terminals = [...vscode.window.terminals];
    if (!terminals.length) {
      vscode.window.showWarningMessage('No terminals open. Open a terminal running a neohive agent first.');
      return;
    }

    const picks = terminals.map((t) => ({ label: t.name, terminal: t }));
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Select the terminal running your neohive agent',
    });
    if (!picked) return;

    const agentName = await vscode.window.showInputBox({
      prompt: 'Enter the agent name registered in neohive (e.g. ClaudeBackend)',
      placeHolder: 'AgentName',
      validateInput: (v) => (v && v.trim() ? null : 'Agent name cannot be empty'),
    });
    if (!agentName) return;

    agentTerminals.set(picked.terminal, { agentName: agentName.trim(), lastNudge: 0 });
    log.info(`[terminal-bridge] Manually bound "${picked.label}" → ${agentName.trim()}`);
    vscode.window.showInformationMessage(
      `Terminal "${picked.label}" bound to agent "${agentName.trim()}". Bridge active.`
    );
  }

  /**
   * Command: send a test ping to /api/inject to verify the bridge is working.
   */
  async function testTerminalBridge() {
    const serverUrl = getServerUrl();
    const ok = await postJson(serverUrl, '/api/inject', {
      from: '__vscode_bridge__',
      to: '__user__',
      content: '[Terminal Bridge Test] VS Code extension ↔ dashboard connection verified.',
    });
    if (ok) {
      vscode.window.showInformationMessage('Terminal bridge test passed — message visible in dashboard.');
    } else {
      vscode.window.showErrorMessage(
        `Terminal bridge test failed — could not reach ${serverUrl}/api/inject. Is the dashboard running?`
      );
    }
  }

  // File watcher for neohive-agent-wrap.sh log files
  const logWatchers = new Map(); // agentName → { watcher, lastOffset }

  function watchAgentLogFile(agentName) {
    if (!agentName || logWatchers.has(agentName)) return;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || !workspaceFolders.length) return;
    const dataDir = path.join(workspaceFolders[0].uri.fsPath, '.neohive');
    const logFile = path.join(dataDir, `agent-log-${agentName}.jsonl`);

    // Initialize offset to current file size (skip existing content)
    let lastOffset = 0;
    try {
      if (fs.existsSync(logFile)) lastOffset = fs.statSync(logFile).size;
    } catch { /* ignore */ }

    const serverUrl = getServerUrl();

    async function readNewLines() {
      try {
        if (!fs.existsSync(logFile)) return;
        const size = fs.statSync(logFile).size;
        if (size <= lastOffset) return;
        const buf = Buffer.alloc(size - lastOffset);
        const fd = fs.openSync(logFile, 'r');
        fs.readSync(fd, buf, 0, buf.length, lastOffset);
        fs.closeSync(fd);
        lastOffset = size;
        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (!entry.data) continue;
            await postJson(serverUrl, '/api/inject', {
              from: agentName,
              to: '__user__',
              content: `[terminal:${agentName}]\n${entry.data}`,
            });
          } catch { /* skip malformed lines */ }
        }
      } catch { /* best-effort */ }
    }

    let watcher;
    try {
      watcher = fs.watch(logFile, { persistent: false }, () => { readNewLines().catch(() => {}); });
    } catch {
      // File may not exist yet — watch the directory and pick it up when created
      try {
        const dirWatcher = fs.watch(dataDir, { persistent: false }, (event, filename) => {
          if (filename === path.basename(logFile) && fs.existsSync(logFile)) {
            dirWatcher.close();
            watchAgentLogFile(agentName); // retry now that file exists
          }
        });
        logWatchers.set(agentName, { watcher: dirWatcher, lastOffset: 0 });
        disposables.push({ dispose: () => { try { dirWatcher.close(); } catch {} logWatchers.delete(agentName); } });
      } catch { /* dataDir also missing — give up silently */ }
      return;
    }

    logWatchers.set(agentName, { watcher, lastOffset });
    disposables.push({ dispose: () => { try { watcher.close(); } catch {} logWatchers.delete(agentName); } });
    log.info(`[terminal-bridge] Watching log file for ${agentName}: ${logFile}`);
  }

  // Start watching for the configured agent name
  function startConfiguredAgentWatch() {
    const agentName = vscode.workspace.getConfiguration('neohive').get('agentName', '');
    if (agentName && typeof agentName === 'string' && agentName.trim()) {
      watchAgentLogFile(agentName.trim());
    }
  }

  startConfiguredAgentWatch();

  // Re-watch on config change
  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('neohive.agentName')) {
        startConfiguredAgentWatch();
      }
    })
  );

  function dispose() {
    for (const d of disposables) {
      try { d.dispose(); } catch (_) {}
    }
    agentTerminals.clear();
    logWatchers.clear();
  }

  return { dispose, onAgentsUpdate, bindAgentTerminal, testTerminalBridge };
}

module.exports = { createTerminalBridge };
