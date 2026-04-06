const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { createTerminalBridge } = require('./terminal-bridge');

// --- IDE liveness bridge v2 → .neohive/ide-activity-{agent}.json ---
const IDE_IDLE_AFTER_UNFOCUS_MS = 20000;
const IDE_FOCUS_DEBOUNCE_MS = 2000;
const PID_CHECK_INTERVAL_MS = 5000;

function sanitizeAgentName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || !/^[a-zA-Z0-9_-]{1,20}$/.test(s)) return null;
  return s;
}

function stripAnsi(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL or ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, ''); // 2-char escapes
}

function stripUnsafeControlChars(input) {
  if (typeof input !== 'string') return '';
  // Preserve \n and \r; drop other C0 controls and DEL.
  return input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function normalizeTerminalText(input) {
  return stripUnsafeControlChars(stripAnsi(input)).replace(/\r\n/g, '\n');
}

function isLikelyAgentTerminal(terminal, agentName) {
  if (!terminal || !agentName) return false;
  const tn = String(terminal.name || '').toLowerCase();
  const an = String(agentName).toLowerCase();
  if (!tn || !an) return false;
  if (tn === an) return true;
  return tn.includes(an);
}

function appendTerminalOutputLine(outFile, agentName, terminalName, data) {
  if (!outFile || !agentName || !data) return;
  try {
    const payload = {
      ts: new Date().toISOString(),
      agent: agentName,
      terminal: terminalName || null,
      data,
    };
    fs.appendFileSync(outFile, JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // best-effort; terminal output capture must not crash the extension
  }
}

function getNeohiveDataDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  return path.join(folders[0].uri.fsPath, '.neohive');
}

function writeIdeActivityFile(dataDir, agentName, fields) {
  if (!dataDir || !agentName) return;
  // Only write if .neohive/ already exists — don't auto-create it in
  // workspaces that have never run neohive.
  if (!fs.existsSync(dataDir)) return;
  try {
    const f = path.join(dataDir, `ide-activity-${agentName}.json`);
    const payload = Object.assign({}, fields, { timestamp: new Date().toISOString() });
    fs.writeFileSync(f, JSON.stringify(payload) + '\n', 'utf8');
  } catch (e) {
    console.error('[neohive] ide-activity write failed:', e.message);
  }
}

/** Set by createIdeLivenessBridge — call after neohive.agentName changes */
let ideLivenessResync = null;

function createIdeLivenessBridge(context) {
  const WORKING_FRESHNESS_MS = 15000;
  const SHELL_GRACE_MS = 3000;

  let debounceTimer = null;
  let idleTimer = null;
  let pidCheckTimer = null;
  let heartbeatWatcher = null;
  let shellGraceTimer = null;
  let shellWorking = false;
  let lastToolCallTs = 0;
  let disposed = false;

  function clearTimers() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function snapshotConfig() {
    // Use effective name (configured → auto-detected → OS username fallback)
    // so liveness tracking never silently fails just because agentName isn't set.
    const agentName = getEffectiveAgentName();
    const dataDir = getNeohiveDataDir();
    return { agentName, dataDir };
  }

  function isWorking() {
    return lastToolCallTs > 0 && (Date.now() - lastToolCallTs) < WORKING_FRESHNESS_MS;
  }

  function pushState(fields) {
    if (disposed) return;
    const { agentName, dataDir } = snapshotConfig();
    if (!agentName || !dataDir) return;
    const merged = Object.assign({ working: isWorking(), shell_working: shellWorking }, fields);
    writeIdeActivityFile(dataDir, agentName, merged);
  }

  function onWindowFocused() {
    clearTimers();
    pushState({ focused: true, ide_idle: false, extension_online: true });
  }

  function onWindowUnfocused() {
    clearTimers();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (disposed) return;
        pushState({ focused: false, ide_idle: true, extension_online: true });
      }, IDE_IDLE_AFTER_UNFOCUS_MS);
    }, IDE_FOCUS_DEBOUNCE_MS);
  }

  function syncFromWindowState() {
    if (disposed) return;
    if (vscode.window.state.focused) {
      onWindowFocused();
    } else {
      onWindowUnfocused();
    }
  }

  ideLivenessResync = syncFromWindowState;

  // --- Signal 1: Window focus (existing) ---
  context.subscriptions.push(vscode.window.onDidChangeWindowState((e) => {
    if (disposed) return;
    if (e.focused) onWindowFocused(); else onWindowUnfocused();
  }));

  // --- Signal 2: FileSystemWatcher on heartbeat file ---
  function setupHeartbeatWatcher() {
    if (heartbeatWatcher) { heartbeatWatcher.dispose(); heartbeatWatcher = null; }
    const { agentName, dataDir } = snapshotConfig();
    if (!agentName || !dataDir) return;
    const pattern = new vscode.RelativePattern(dataDir, `heartbeat-${agentName}.json`);
    heartbeatWatcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);
    heartbeatWatcher.onDidChange(() => {
      if (disposed) return;
      lastToolCallTs = Date.now();
      pushState({ focused: vscode.window.state.focused, ide_idle: false, extension_online: true, last_tool_call: new Date().toISOString() });
    });
    context.subscriptions.push(heartbeatWatcher);
  }
  setupHeartbeatWatcher();

  // --- Signal 3: PID alive check (same-user only; kill(pid,0) fails across users) ---
  function readAgentPid() {
    const { agentName, dataDir } = snapshotConfig();
    if (!agentName || !dataDir) return null;
    const agentsFile = path.join(dataDir, 'agents.json');
    try {
      const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      return agents[agentName] ? agents[agentName].pid : null;
    } catch { return null; }
  }

  function checkPidAlive() {
    if (disposed) return;
    const pid = readAgentPid();
    if (pid === null) return;
    try {
      process.kill(pid, 0);
    } catch {
      pushState({ focused: false, ide_idle: true, extension_online: false });
    }
  }

  pidCheckTimer = setInterval(checkPidAlive, PID_CHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => { if (pidCheckTimer) clearInterval(pidCheckTimer); } });

  // --- Signal 4: Shell integration events (CLI agents in integrated terminals) ---
  async function captureShellExecutionOutput(e) {
    if (disposed) return;
    const { agentName, dataDir } = snapshotConfig();
    if (!agentName || !dataDir) return;
    const term = e && e.terminal;
    if (!term || !isLikelyAgentTerminal(term, agentName)) return;
    const exec = e.execution;
    if (!exec || typeof exec.read !== 'function') return;

    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch { return; }

    const outFile = path.join(dataDir, `terminal-${agentName}.jsonl`);
    let stream;
    try { stream = exec.read(); } catch { return; }

    try {
      for await (const chunk of stream) {
        if (disposed) break;
        let text = chunk;
        if (text && text instanceof Uint8Array) text = Buffer.from(text).toString('utf8');
        if (typeof text !== 'string' || !text) continue;
        const cleaned = normalizeTerminalText(text);
        if (!cleaned) continue;
        appendTerminalOutputLine(outFile, agentName, term.name, cleaned);
      }
    } catch {
      // best-effort: shell integration output is optional
    }
  }

  context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution((e) => {
    if (disposed) return;
    if (shellGraceTimer) { clearTimeout(shellGraceTimer); shellGraceTimer = null; }
    shellWorking = true;
    pushState({ focused: vscode.window.state.focused, ide_idle: false, extension_online: true });
    captureShellExecutionOutput(e).catch(() => {});
  }));

  context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution(() => {
    if (disposed) return;
    if (shellGraceTimer) { clearTimeout(shellGraceTimer); shellGraceTimer = null; }
    shellGraceTimer = setTimeout(() => {
      shellGraceTimer = null;
      if (disposed) return;
      shellWorking = false;
      pushState({ focused: vscode.window.state.focused, ide_idle: false, extension_online: true });
    }, SHELL_GRACE_MS);
  }));

  // --- Dispose: mark offline ---
  context.subscriptions.push({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ideLivenessResync = null;
      clearTimers();
      if (pidCheckTimer) { clearInterval(pidCheckTimer); pidCheckTimer = null; }
      if (shellGraceTimer) { clearTimeout(shellGraceTimer); shellGraceTimer = null; }
      if (heartbeatWatcher) { heartbeatWatcher.dispose(); heartbeatWatcher = null; }
      const { agentName, dataDir } = snapshotConfig();
      if (agentName && dataDir) {
        writeIdeActivityFile(dataDir, agentName, {
          focused: false, ide_idle: true, extension_online: false,
          working: false, shell_working: false,
        });
      }
    },
  });

  syncFromWindowState();
}

// --- HTTP client for Neohive server ---

function getServerUrl() {
  return vscode.workspace.getConfiguration('neohive').get('serverUrl', 'http://localhost:4321');
}

function getPollInterval() {
  return vscode.workspace.getConfiguration('neohive').get('pollInterval', 300000);
}

function fetchJson(urlPath) {
  const base = getServerUrl();
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    http.get(url.toString(), (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

// --- Agent TreeView ---

class AgentTreeItem extends vscode.TreeItem {
  constructor(name, agent) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.agent = agent;
    const status = agent.status || (agent.alive ? 'working' : 'offline');
    const statusIcon = status === 'offline' ? '$(circle-slash)' :
                       status === 'listening' ? '$(pulse)' :
                       status === 'idle' ? '$(watch)' :
                       '$(circle-filled)';
    this.description = `${status} - ${agent.provider || '?'}`;
    this.iconPath = new vscode.ThemeIcon(
      status === 'offline' ? 'circle-slash' :
      status === 'listening' ? 'pulse' :
      status === 'idle' ? 'watch' :
      'circle-filled',
      new vscode.ThemeColor(
        status === 'offline' ? 'testing.iconFailed' :
        status === 'listening' ? 'charts.yellow' :
        status === 'idle' ? 'charts.orange' :
        'testing.iconPassed'
      )
    );
    this.tooltip = `${name}\nStatus: ${status}\nProvider: ${agent.provider || 'unknown'}\nRole: ${agent.role || 'none'}`;
    if (agent.current_status) {
      this.tooltip += `\n${agent.current_status}`;
    }
  }
}

class AgentTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._agents = {};
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  setAgents(agents) {
    this._agents = agents || {};
    this.refresh();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren() {
    const versionItem = new vscode.TreeItem(`Neohive v${EXT_VERSION}`);
    versionItem.description = detectIde();
    versionItem.iconPath = new vscode.ThemeIcon('symbol-misc');
    versionItem.tooltip = `Neohive v${EXT_VERSION} — running on ${vscode.env.appName}`;
    versionItem.contextValue = 'neohive-version';

    const entries = Object.entries(this._agents)
      .filter(([name]) => name !== '__system__' && name !== 'Dashboard')
      .sort((a, b) => {
        const aAlive = a[1].alive ? 1 : 0;
        const bAlive = b[1].alive ? 1 : 0;
        return bAlive - aAlive;
      });

    if (entries.length === 0) {
      const item = new vscode.TreeItem('No agents online');
      item.description = 'Start agents with: npx neohive serve';
      return [versionItem, item];
    }

    return [versionItem, ...entries.map(([name, agent]) => new AgentTreeItem(name, agent))];
  }
}

// --- Workflow TreeView ---

class WorkflowStepItem extends vscode.TreeItem {
  constructor(step, index) {
    super(`Step ${index + 1}: ${step.description || 'Unnamed'}`, vscode.TreeItemCollapsibleState.None);
    const status = step.status || 'pending';
    this.description = step.assignee ? `${status} - ${step.assignee}` : status;
    this.iconPath = new vscode.ThemeIcon(
      status === 'done' ? 'pass-filled' :
      status === 'in_progress' ? 'loading~spin' :
      status === 'awaiting_approval' ? 'question' :
      'circle-outline',
      status === 'done' ? new vscode.ThemeColor('testing.iconPassed') :
      status === 'in_progress' ? new vscode.ThemeColor('charts.yellow') :
      undefined
    );
  }
}

class WorkflowTreeItem extends vscode.TreeItem {
  constructor(workflow) {
    const doneCount = (workflow.steps || []).filter(s => s.status === 'done').length;
    const total = (workflow.steps || []).length;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    super(workflow.name || 'Workflow', vscode.TreeItemCollapsibleState.Expanded);
    this.workflow = workflow;
    this.description = `${pct}% (${doneCount}/${total})`;
    this.iconPath = new vscode.ThemeIcon(
      workflow.status === 'completed' ? 'pass-filled' : 'git-merge',
      workflow.status === 'completed' ? new vscode.ThemeColor('testing.iconPassed') :
        new vscode.ThemeColor('charts.yellow')
    );
    this.tooltip = `${workflow.name}\nStatus: ${workflow.status}\nProgress: ${doneCount}/${total} steps`;
  }
}

class WorkflowTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._workflows = [];
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  setWorkflows(workflows) {
    this._workflows = workflows || [];
    this.refresh();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      // Root: show workflows
      if (this._workflows.length === 0) {
        const item = new vscode.TreeItem('No active workflows');
        return [item];
      }
      return this._workflows
        .filter(wf => wf.status === 'active' || wf.status === 'completed')
        .map(wf => new WorkflowTreeItem(wf));
    }

    // Children of a workflow: its steps
    if (element.workflow && element.workflow.steps) {
      return element.workflow.steps.map((step, i) => new WorkflowStepItem(step, i));
    }

    return [];
  }
}

// --- Task Board (Kanban) Webview ---

class TaskBoardProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = undefined;
    this._tasks = [];
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(data => {
      if (data.command === 'openTask') {
        // Task detail view could be added later
      }
    });

    if (this._tasks.length > 0) {
      this.updateTasks(this._tasks, {}, {});
    }
  }

  updateTasks(tasks, agents, profiles) {
    this._tasks = tasks || [];
    if (this._view) {
      this._view.webview.postMessage({ 
        type: 'update', 
        tasks: this._tasks, 
        agents: agents || {}, 
        profiles: profiles || {} 
      });
    }
  }

  _getHtmlForWebview(webview) {
    const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'task-board.html');
    try {
      return fs.readFileSync(htmlPath.fsPath, 'utf8');
    } catch (e) {
      return `<html><body>Error loading Task Board: ${e.message}</body></html>`;
    }
  }
}

// --- Status Bar ---

const EXT_VERSION = require('./package.json').version;

function createStatusBar() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'neohive.showAgents';
  item.text = `$(symbol-misc) Neohive v${EXT_VERSION}`;
  item.tooltip = `Neohive v${EXT_VERSION} - Connecting...`;
  item.show();
  return item;
}

function updateStatusBar(statusBar, agents, connected) {
  if (!connected) {
    statusBar.text = `$(symbol-misc) Neohive v${EXT_VERSION} $(circle-slash)`;
    statusBar.tooltip = `Neohive v${EXT_VERSION} - Not connected`;
    statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    return;
  }

  const entries = Object.entries(agents || {}).filter(([n]) => n !== '__system__' && n !== 'Dashboard');
  const alive = entries.filter(([, a]) => a.alive).length;
  const total = entries.length;

  statusBar.text = `$(symbol-misc) Neohive v${EXT_VERSION}: ${alive}/${total}`;
  statusBar.tooltip = `Neohive v${EXT_VERSION} - ${alive} agents online, ${total} total`;
  statusBar.color = undefined;
}

// --- MCP Auto-Setup ---

function detectIde() {
  const appName = (vscode.env.appName || '').toLowerCase();
  if (appName.includes('cursor')) return 'cursor';
  if (appName.includes('antigravity')) return 'antigravity';
  if (appName.includes('windsurf')) return 'windsurf';
  if (appName.includes('visual studio code') || appName.includes('vscode')) return 'vscode';
  return 'unknown';
}

const SUPPORTED_IDES = { vscode: true, cursor: true, antigravity: true };

function isDevMode() {
  const setting = vscode.workspace.getConfiguration('neohive').get('devMode', false);
  if (setting) return true;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return false;
  return fs.existsSync(path.join(folders[0].uri.fsPath, '.neohive-dev'));
}

function getMcpConfigPath() {
  const ide = detectIde();
  // Antigravity uses a global user-level config, not workspace-level
  if (ide === 'antigravity') {
    return path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  const root = folders[0].uri.fsPath;
  if (ide === 'vscode') return path.join(root, '.vscode', 'mcp.json');
  if (ide === 'cursor') return path.join(root, '.cursor', 'mcp.json');
  return null;
}

function mcpNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function detectNodePath() {
  const { execSync } = require('child_process');
  try {
    const voltaNode = execSync('volta which node', { encoding: 'utf8', timeout: 5000 }).trim();
    if (voltaNode && fs.existsSync(voltaNode)) return voltaNode;
  } catch {}
  try {
    const whichNode = execSync('which node', { encoding: 'utf8', timeout: 5000 }).trim();
    if (whichNode && fs.existsSync(whichNode)) return whichNode;
  } catch {}
  return process.execPath;
}

function getMcpStatus() {
  const ide = detectIde();
  if (!SUPPORTED_IDES[ide]) return 'unsupported_ide';
  const mcpPath = getMcpConfigPath();
  if (!mcpPath) return 'no_workspace';
  if (!fs.existsSync(mcpPath)) return 'not_configured';
  try {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (ide === 'cursor' || ide === 'antigravity') {
      if (config.mcpServers && config.mcpServers.neohive) return 'ready';
    } else {
      // VSCode uses the `servers` key
      if (config.servers && config.servers.neohive) return 'ready';
    }
    return 'missing_entry';
  } catch {
    return 'invalid';
  }
}

function writeMcpConfig() {
  const ide = detectIde();
  if (!SUPPORTED_IDES[ide]) return false;
  const mcpPath = getMcpConfigPath();
  if (!mcpPath) return false;

  const configDir = path.dirname(mcpPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  const nodePath = detectNodePath();
  const dev = isDevMode();

  if (ide === 'cursor' || ide === 'antigravity') {
    // Cursor and Antigravity both use { mcpServers: { neohive: {...} } }
    let config = { mcpServers: {} };
    if (fs.existsSync(mcpPath)) {
      try {
        config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        if (!config.mcpServers) config.mcpServers = {};
      } catch {
        try { fs.copyFileSync(mcpPath, mcpPath + '.backup'); } catch {}
      }
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return false;
    const abDataDir = path.join(folders[0].uri.fsPath, '.neohive').replace(/\\/g, '/');
    if (dev) {
      config.mcpServers.neohive = {
        command: nodePath,
        args: [path.join(folders[0].uri.fsPath, 'agent-bridge', 'server.js')],
        env: { NEOHIVE_DATA_DIR: abDataDir },
        timeout: 300,
      };
    } else {
      config.mcpServers.neohive = {
        command: mcpNpxCommand(),
        args: ['-y', 'neohive', 'mcp'],
        env: { NEOHIVE_DATA_DIR: abDataDir },
        timeout: 300,
      };
    }
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  } else {
    // VSCode uses { servers: { neohive: {...} } }
    let config = { servers: {} };
    if (fs.existsSync(mcpPath)) {
      try {
        config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        if (!config.servers) config.servers = {};
      } catch {
        try { fs.copyFileSync(mcpPath, mcpPath + '.backup'); } catch {}
      }
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return false;
    const abDataDir = path.join(folders[0].uri.fsPath, '.neohive').replace(/\\/g, '/');
    if (dev) {
      config.servers.neohive = {
        command: nodePath,
        args: [path.join(folders[0].uri.fsPath, 'agent-bridge', 'server.js')],
        env: { NEOHIVE_DATA_DIR: abDataDir },
        cwd: folders[0].uri.fsPath,
        timeout: 300,
      };
    } else {
      config.servers.neohive = {
        command: mcpNpxCommand(),
        args: ['-y', 'neohive', 'mcp'],
        env: { NEOHIVE_DATA_DIR: abDataDir },
        timeout: 300,
      };
    }
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  }
  return true;
}

let mcpStatusBarItem = null;

function updateMcpStatusBar(status) {
  if (!mcpStatusBarItem) return;
  const ide = detectIde();
  const ideName = ide === 'cursor' ? 'Cursor' : ide === 'antigravity' ? 'Antigravity' : ide === 'vscode' ? 'Copilot Chat' : ide;
  switch (status) {
    case 'ready':
      mcpStatusBarItem.text = '$(check) MCP Ready';
      mcpStatusBarItem.tooltip = `Neohive MCP is configured for ${ideName}`;
      mcpStatusBarItem.backgroundColor = undefined;
      break;
    case 'not_configured':
    case 'missing_entry':
    case 'invalid':
      mcpStatusBarItem.text = '$(warning) MCP Not Set Up';
      mcpStatusBarItem.tooltip = `Click to set up Neohive MCP for ${ideName}`;
      mcpStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
    case 'unsupported_ide':
      mcpStatusBarItem.text = '$(info) MCP Manual';
      mcpStatusBarItem.tooltip = `${vscode.env.appName}: auto-setup not available. Run "npx neohive init" in terminal.`;
      mcpStatusBarItem.backgroundColor = undefined;
      break;
    default:
      mcpStatusBarItem.text = '$(circle-slash) MCP';
      mcpStatusBarItem.tooltip = 'No workspace open';
      mcpStatusBarItem.backgroundColor = undefined;
      break;
  }
}

async function checkMcpOnActivate() {
  const ide = detectIde();
  const status = getMcpStatus();
  updateMcpStatusBar(status);

  if (status === 'unsupported_ide') {
    vscode.window.showInformationMessage(
      `Neohive MCP auto-setup is not available for ${vscode.env.appName}. Run "npx neohive init" in your terminal to configure manually.`
    );
    return;
  }

  if (status === 'not_configured' || status === 'missing_entry' || status === 'invalid') {
    const ideName = ide === 'cursor' ? 'Cursor' : ide === 'antigravity' ? 'Antigravity' : 'VS Code Copilot Chat';
    const action = await vscode.window.showInformationMessage(
      `Neohive MCP server is not configured for ${ideName}. Set it up now?`,
      'Set Up Now',
      'Later'
    );
    if (action === 'Set Up Now') {
      await vscode.commands.executeCommand('neohive.setupMcp');
    }
  }
}

async function commandSetupMcp() {
  const ide = detectIde();
  if (!SUPPORTED_IDES[ide]) {
    vscode.window.showErrorMessage(
      `MCP auto-setup is not supported for ${vscode.env.appName}. Run "npx neohive init" in your terminal.`
    );
    return;
  }

  const ok = writeMcpConfig();
  if (!ok) {
    vscode.window.showErrorMessage('No workspace folder open. Open a folder first.');
    return;
  }

  updateMcpStatusBar('ready');
  const mode = isDevMode() ? ' (dev mode: local server.js)' : '';

  if (ide === 'cursor') {
    vscode.window.showInformationMessage(
      `Neohive MCP configured for Cursor${mode}! MCP tools are now available in your AI Agent chat.`
    );
  } else if (ide === 'antigravity') {
    vscode.window.showInformationMessage(
      `Neohive MCP configured for Antigravity${mode}! Restart Antigravity to activate the MCP tools.`
    );
  } else {
    const next = await vscode.window.showInformationMessage(
      `Neohive MCP configured${mode}! To use it: Open Copilot Chat (Ctrl+Shift+I) \u2192 click the tools icon ({}) \u2192 find "neohive" \u2192 toggle it on.`,
      'Open Copilot Chat',
      'Done'
    );
    if (next === 'Open Copilot Chat') {
      vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
    }
  }
}

// --- agentName Configuration Fallback ---

/**
 * Try to auto-detect a usable agent name without user interaction:
 *   1. Explicitly configured neohive.agentName → use it.
 *   2. agents.json has exactly one live agent → adopt it (silent).
 *   3. Fall back to a sanitized OS username so liveness features still work.
 *
 * Never prompts the user — callers decide whether to show UI.
 * Returns a non-empty sanitized string, always.
 */
function getEffectiveAgentName() {
  // 1. Configured value wins
  const configured = sanitizeAgentName(
    vscode.workspace.getConfiguration('neohive').get('agentName', '')
  );
  if (configured) return configured;

  // 2. Single registered agent in agents.json
  const dataDir = getNeohiveDataDir();
  if (dataDir) {
    const agentsFile = path.join(dataDir, 'agents.json');
    if (fs.existsSync(agentsFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
        const live = Object.keys(raw).filter(n => n !== '__system__' && n !== 'Dashboard');
        if (live.length === 1) return live[0];
      } catch {}
    }
  }

  // 3. OS username fallback — sanitized to the allowed character set
  const username = sanitizeAgentName(os.userInfo().username) || 'CursorUser';
  return username;
}

/**
 * Show a quick pick seeded with agents found in agents.json.
 * Returns the selected/typed name, or null if cancelled.
 */
async function commandConfigureAgentName() {
  const dataDir = getNeohiveDataDir();
  const agentsFile = dataDir ? path.join(dataDir, 'agents.json') : null;

  let knownAgents = [];
  if (agentsFile && fs.existsSync(agentsFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      knownAgents = Object.keys(raw).filter(n => n !== '__system__' && n !== 'Dashboard');
    } catch {}
  }

  if (!agentsFile || !fs.existsSync(agentsFile)) {
    vscode.window.showWarningMessage(
      'Neohive: No agents found. Start a neohive session first (run `npx neohive dashboard` or register an agent), then run "Neohive: Configure Agent Name" again.'
    );
    return null;
  }

  if (knownAgents.length === 0) {
    vscode.window.showWarningMessage(
      'Neohive: No registered agents found. Start a neohive session first, then configure your agent name.'
    );
    return null;
  }

  const TYPE_OWN = '$(pencil) Type a different name…';
  const items = [
    ...knownAgents.map(n => ({ label: `$(person) ${n}`, name: n })),
    { label: TYPE_OWN, name: null },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Neohive: Select Your Agent Name',
    placeHolder: 'Pick your registered agent name or type a custom one',
  });

  if (!picked) return null;

  let finalName = picked.name;
  if (!finalName) {
    finalName = await vscode.window.showInputBox({
      title: 'Neohive: Agent Name',
      prompt: 'Enter your agent name (1–20 alphanumeric, _ or - characters)',
      validateInput: (v) => {
        if (!v || !v.trim()) return 'Name cannot be empty';
        if (!/^[a-zA-Z0-9_-]{1,20}$/.test(v.trim())) return 'Must be 1–20 alphanumeric characters (with _ or -)';
        return null;
      },
    });
  }

  if (!finalName) return null;
  const sanitized = sanitizeAgentName(finalName);
  if (!sanitized) {
    vscode.window.showErrorMessage('Invalid agent name. Must be 1–20 alphanumeric characters (with _ or -).');
    return null;
  }

  // Persist to workspace settings
  const config = vscode.workspace.getConfiguration('neohive');
  await config.update('agentName', sanitized, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Neohive: Agent name set to "${sanitized}". IDE liveness tracking is now active.`);
  return sanitized;
}

/**
 * On activation: if neohive.agentName is not explicitly configured AND a
 * .neohive/ directory exists (neohive is actually active in this workspace),
 * notify the user about the fallback name being used and offer to configure.
 *
 * Skips silently for workspaces that have never run neohive — no false alerts.
 */
async function checkAgentNameConfigured() {
  const configured = sanitizeAgentName(
    vscode.workspace.getConfiguration('neohive').get('agentName', '')
  );
  if (configured) return; // explicitly set — nothing to do

  // Only prompt when neohive is actually active in this workspace
  const dataDir = getNeohiveDataDir();
  if (!dataDir || !fs.existsSync(dataDir)) return;

  const fallback = getEffectiveAgentName();
  const action = await vscode.window.showInformationMessage(
    `Neohive: Using "${fallback}" as your agent name (auto-detected). Set a specific name to avoid conflicts.`,
    'Configure',
    'Keep this name'
  );

  if (action === 'Configure') {
    await vscode.commands.executeCommand('neohive.configureAgentName');
  } else if (action === 'Keep this name') {
    // Persist the auto-detected fallback so it stops prompting
    const config = vscode.workspace.getConfiguration('neohive');
    await config.update('agentName', fallback, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`Neohive: Agent name saved as "${fallback}".`);
  }
}

// --- @neohive Chat Participant ---

/**
 * Register the @neohive chat participant.
 * Gracefully no-ops on VS Code versions that don't support the Chat API (<1.90).
 */
function registerNeohiveChatParticipant(context) {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') return;

  const participant = vscode.chat.createChatParticipant('neohive.coordinator', handleNeohiveChatRequest);
  participant.iconPath = new vscode.ThemeIcon('symbol-misc');
  context.subscriptions.push(participant);
}

async function handleNeohiveChatRequest(request, _context, stream, _token) {
  const dataDir = getNeohiveDataDir();
  const command = request.command;

  // ── /status — online agents ────────────────────────────────────────────────
  if (command === 'status') {
    const agentsFile = dataDir && path.join(dataDir, 'agents.json');
    if (!agentsFile || !fs.existsSync(agentsFile)) {
      stream.markdown('⚠️ No `.neohive` directory or agents found. Is the server running?');
      return { metadata: { command } };
    }
    const raw = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    const agents = Object.entries(raw).filter(([n]) => n !== '__system__' && n !== 'Dashboard');
    if (!agents.length) {
      stream.markdown('No agents currently registered.');
      return { metadata: { command } };
    }
    const rows = agents.map(([name, info]) => {
      const status = info.alive ? '🟢 online' : '🔴 offline';
      const ts = info.last_activity ? new Date(info.last_activity).toLocaleTimeString() : '—';
      return `| **${name}** | ${status} | ${ts} |`;
    }).join('\n');
    stream.markdown(`## Neohive Agent Status\n\n| Agent | Status | Last seen |\n|---|---|---|\n${rows}`);
    return { metadata: { command } };
  }

  // ── /who — team roster with roles ─────────────────────────────────────────
  if (command === 'who') {
    const agentsFile = dataDir && path.join(dataDir, 'agents.json');
    const profilesFile = dataDir && path.join(dataDir, 'profiles.json');
    if (!agentsFile || !fs.existsSync(agentsFile)) {
      stream.markdown('⚠️ No agents found.');
      return { metadata: { command } };
    }
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    const profiles = (profilesFile && fs.existsSync(profilesFile))
      ? JSON.parse(fs.readFileSync(profilesFile, 'utf8')) : {};
    const names = Object.keys(agents).filter(n => n !== '__system__' && n !== 'Dashboard');
    const rows = names.map(name => {
      const prof = profiles[name] || {};
      const role = prof.role || agents[name].role || '—';
      const provider = agents[name].provider || '—';
      return `| **${name}** | ${role} | ${provider} |`;
    }).join('\n');
    stream.markdown(`## Neohive Team\n\n| Agent | Role | Provider |\n|---|---|---|\n${rows}`);
    return { metadata: { command } };
  }

  // ── /tasks — active tasks ──────────────────────────────────────────────────
  if (command === 'tasks') {
    const tasksFile = dataDir && path.join(dataDir, 'tasks.json');
    if (!tasksFile || !fs.existsSync(tasksFile)) {
      stream.markdown('⚠️ No tasks found.');
      return { metadata: { command } };
    }
    const tasksRaw = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    const taskArr = Array.isArray(tasksRaw) ? tasksRaw : Object.values(tasksRaw);
    const active = taskArr.filter(t =>
      t.status === 'pending' || t.status === 'in_progress' || t.status === 'in_review'
    );
    if (!active.length) {
      stream.markdown('✅ No active tasks — all done!');
      return { metadata: { command } };
    }
    const statusIcon = { pending: '⏳', in_progress: '🔄', in_review: '🔍' };
    const rows = active.map(t => {
      const icon = statusIcon[t.status] || '';
      return `| ${t.title || t.id} | ${icon} ${t.status} | ${t.assignee || '—'} |`;
    }).join('\n');
    stream.markdown(`## Active Tasks\n\n| Title | Status | Assignee |\n|---|---|---|\n${rows}`);
    return { metadata: { command } };
  }

  // ── /messages — last 10 messages ──────────────────────────────────────────
  if (command === 'messages') {
    const msgFile = dataDir && path.join(dataDir, 'messages.jsonl');
    if (!msgFile || !fs.existsSync(msgFile)) {
      stream.markdown('⚠️ No messages found.');
      return { metadata: { command } };
    }
    const lines = fs.readFileSync(msgFile, 'utf8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-10)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (!recent.length) {
      stream.markdown('No messages yet.');
      return { metadata: { command } };
    }
    const items = recent.map(msg => {
      const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
      const from = msg.from || '?';
      const to = msg.to ? ` → ${msg.to}` : '';
      const content = (msg.content || '').replace(/\n/g, ' ').slice(0, 120);
      return `**[${ts}] ${from}${to}:** ${content}`;
    }).join('\n\n');
    stream.markdown(`## Recent Messages\n\n${items}`);
    return { metadata: { command } };
  }

  // ── catch-all: fire-and-forget pipe to coordinator ────────────────────────
  const prompt = (request.prompt || '').trim();
  if (!prompt) {
    stream.markdown(
      'Try `@neohive /status`, `/who`, `/tasks`, or `/messages` for local reads.\n\n' +
      'Or type any message to pipe it to the coordinator.'
    );
    return {};
  }

  stream.markdown('📡 Dispatching request to ClaudeLead...\n\n');

  const payload = JSON.stringify({ from: '__user__', to: 'ClaudeLead', content: prompt });
  const serverUrl = getServerUrl();

  await new Promise((resolve) => {
    try {
      const url = new URL('/api/inject', serverUrl);
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? require('https') : http;
      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = mod.request(reqOptions, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          stream.markdown('✅ Request queued. Watch the dashboard for the reply, or type `@neohive /messages` in a minute.');
        } else {
          stream.markdown(`⚠️ Server returned HTTP ${res.statusCode}. Is the dashboard running?`);
        }
        resolve();
      });
      req.on('error', () => {
        stream.markdown('⚠️ Could not reach neohive dashboard. Is it running? (`npx neohive dashboard`)');
        resolve();
      });
      req.setTimeout(5000, () => {
        req.destroy();
        stream.markdown('⚠️ Request timed out. Is the neohive dashboard running?');
        resolve();
      });
      req.write(payload);
      req.end();
    } catch {
      stream.markdown('⚠️ Could not reach neohive dashboard. Is it running? (`npx neohive dashboard`)');
      resolve();
    }
  });

  return {};
}

// --- Neohive Webview Chat Panel ---

/**
 * Manages the Neohive Chat Webview panel.
 * Uses a FileSystemWatcher on messages.jsonl for real-time updates.
 */
class NeohiveChatPanel {
  static currentPanel = undefined;
  static viewType = 'neohive-chat';

  constructor(panel, extensionUri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._disposables = [];
    this._lastReadOffset = 0;

    // Set the webview's initial html content
    this._update();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'send':
            await this._injectMessage(message.text, message.to);
            return;
          case 'getAgents':
            this._postAgents();
            return;
        }
      },
      null,
      this._disposables
    );

    // Watch for message file changes
    this._setupFileWatcher();

    // Initial load
    this._postNewMessages();
    this._postAgents();
  }

  static createOrShow(extensionUri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it.
    if (NeohiveChatPanel.currentPanel) {
      NeohiveChatPanel.currentPanel._panel.reveal(column);
      return;
    }

    // Otherwise, create a new panel.
    const panel = vscode.window.createWebviewPanel(
      NeohiveChatPanel.viewType,
      'Neohive Team Chat',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    NeohiveChatPanel.currentPanel = new NeohiveChatPanel(panel, extensionUri);
  }

  async _injectMessage(text, to = '__group__') {
    if (!text || !text.trim()) return;
    const serverUrl = getServerUrl();
    const payload = JSON.stringify({ from: '__user__', to, content: text.trim() });

    return new Promise((resolve) => {
      try {
        const url = new URL('/api/inject', serverUrl);
        const isHttps = url.protocol === 'https:';
        const mod = isHttps ? require('https') : require('http');
        const req = mod.request({
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-LTT-Request': '1',
          },
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const result = JSON.parse(data);
                if (result.messageId && to !== '__group__' && to !== '__all__') {
                  this._trackPendingRead(result.messageId, to);
                }
                resolve(result.messageId);
              } catch { resolve(null); }
            } else {
              vscode.window.showErrorMessage(`Neohive: Failed to send message (HTTP ${res.statusCode})`);
              resolve(null);
            }
          });
        });
        req.on('error', (e) => {
          vscode.window.showErrorMessage(`Neohive: Server unreachable (${e.message})`);
          resolve(null);
        });
        req.write(payload);
        req.end();
      } catch (e) {
        vscode.window.showErrorMessage(`Neohive: Error sending message (${e.message})`);
        resolve(null);
      }
    });
  }

  _trackPendingRead(msgId, recipient) {
    if (!msgId || !recipient) return;
    if (!this._pendingReads) this._pendingReads = new Map();
    this._pendingReads.set(msgId, recipient);
    this._watchConsumedFile(recipient);
  }

  _watchConsumedFile(agentName) {
    if (!this._consumedWatchers) this._consumedWatchers = new Set();
    if (this._consumedWatchers.has(agentName)) return;
    this._consumedWatchers.add(agentName);

    const dataDir = getNeohiveDataDir();
    if (!dataDir) return;
    const consumedFile = path.join(dataDir, `consumed-${agentName}.json`);
    const dir = path.dirname(consumedFile);
    const base = path.basename(consumedFile);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, base)
    );
    const check = () => this._checkReadReceipts(agentName, consumedFile);
    watcher.onDidChange(check, null, this._disposables);
    watcher.onDidCreate(check, null, this._disposables);
    this._disposables.push(watcher);
  }

  _checkReadReceipts(agentName, consumedFile) {
    if (!this._pendingReads || this._pendingReads.size === 0) return;
    try {
      if (!fs.existsSync(consumedFile)) return;
      const ids = new Set(JSON.parse(fs.readFileSync(consumedFile, 'utf8')));
      for (const [msgId, recipient] of this._pendingReads) {
        if (recipient === agentName && ids.has(msgId)) {
          this._pendingReads.delete(msgId);
          this._panel.webview.postMessage({ command: 'markRead', msgId });
        }
      }
    } catch {}
  }

  _setupFileWatcher() {
    const dataDir = getNeohiveDataDir();
    const msgFile = dataDir && path.join(dataDir, 'messages.jsonl');
    if (!msgFile) return;

    // Use a relative pattern for stability across OS/environments
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(msgFile), path.basename(msgFile))
    );

    watcher.onDidChange(() => this._postNewMessages(), null, this._disposables);
    watcher.onDidCreate(() => {
      this._lastReadOffset = 0;
      this._postNewMessages();
    }, null, this._disposables);
    
    this._disposables.push(watcher);
  }

  _postAgents() {
    const dataDir = getNeohiveDataDir();
    const agentsFile = dataDir && path.join(dataDir, 'agents.json');
    if (!agentsFile || !fs.existsSync(agentsFile)) {
      this._panel.webview.postMessage({ command: 'agents', agents: [] });
      return;
    }

    try {
      const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      // Filter for online agents (or just send all, webview can filter)
      const agentList = Object.keys(agents).filter(name => agents[name].status === 'alive');
      this._panel.webview.postMessage({ command: 'agents', agents: agentList });
    } catch (err) {
      console.error('[neohive] Failed to read agents.json:', err);
    }
  }

  _postNewMessages() {
    const dataDir = getNeohiveDataDir();
    const msgFile = dataDir && path.join(dataDir, 'messages.jsonl');
    if (!msgFile || !fs.existsSync(msgFile)) return;

    try {
      const stats = fs.statSync(msgFile);
      if (stats.size < this._lastReadOffset) {
        this._lastReadOffset = 0; // File was truncated or rotated
      }

      const fd = fs.openSync(msgFile, 'r');
      const buffer = Buffer.alloc(stats.size - this._lastReadOffset);
      fs.readSync(fd, buffer, 0, buffer.length, this._lastReadOffset);
      fs.closeSync(fd);

      const newContent = buffer.toString('utf8');
      const lines = newContent.trim().split('\n').filter(Boolean);
      const messages = lines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      if (messages.length > 0) {
        this._panel.webview.postMessage({ command: 'messages', messages });
      }
      this._lastReadOffset = stats.size;
    } catch (err) {
      console.error('[neohive] Failed to read messages.jsonl:', err);
    }
  }

  dispose() {
    NeohiveChatPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  _update() {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  _getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Neohive Chat</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #0f0f10; color: #e0e0e0; margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
        #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        .message { max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.5; position: relative; animation: fadeIn 0.2s ease-out; }
        .message.system { align-self: center; background: rgba(255,255,255,0.05); color: #888; font-style: italic; font-size: 11px; max-width: 100%; border: 1px solid rgba(255,255,255,0.1); }
        .message.from-me { align-self: flex-end; background: #2c3e50; color: #fff; border-bottom-right-radius: 2px; }
        .message.from-others { align-self: flex-start; background: #1e1e20; border: 1px solid #333; border-bottom-left-radius: 2px; }
        .header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; gap: 8px; }
        .header-left { display: flex; align-items: baseline; gap: 8px; }
        .header-right { display: flex; align-items: center; gap: 6px; }
        .from { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
        .time { font-size: 10px; color: #666; }
        .read-status { font-size: 10px; color: #666; }
        .read-status.read { color: #4fc3f7; }
        .content { white-space: pre-wrap; word-wrap: break-word; }
        .reply-btn { background: transparent; border: 1px solid #444; color: #aaa; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 500; transition: all 0.15s; opacity: 0; pointer-events: none; }
        .message:hover .reply-btn { opacity: 1; pointer-events: auto; }
        .reply-btn:hover { background: #333; color: #fff; border-color: #666; }
        #input-area { padding: 16px; background: #0f0f10; border-top: 1px solid #222; display: flex; flex-direction: column; gap: 6px; }
        #reply-indicator { display: none; font-size: 11px; color: #4fc3f7; padding: 0 4px; }
        #reply-indicator.visible { display: flex; align-items: center; gap: 6px; }
        #reply-indicator button { background: transparent; border: none; color: #888; cursor: pointer; padding: 0 4px; font-size: 12px; }
        #reply-indicator button:hover { color: #fff; }
        #input-row { display: flex; gap: 10px; }
        input { flex: 1; background: #1a1a1c; border: 1px solid #333; color: #fff; padding: 8px 12px; border-radius: 6px; outline: none; }
        input:focus { border-color: #007acc; }
        button { background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; transition: background 0.2s; }
        button:hover { background: #0062a3; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body>
    <div id="messages"></div>
    <div id="input-area">
        <div id="reply-indicator">
            <span id="reply-label"></span>
            <button id="clear-reply" title="Cancel reply">✕</button>
        </div>
        <div id="input-row">
            <input type="text" id="chat-input" placeholder="Type a message..." />
            <button id="send-btn">Send</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const msgContainer = document.getElementById('messages');
        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('send-btn');
        const replyIndicator = document.getElementById('reply-indicator');
        const replyLabel = document.getElementById('reply-label');
        const clearReplyBtn = document.getElementById('clear-reply');

        let replyTo = null;
        const seenIds = new Set();

        function escapeHtml(s) {
            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }

        function setReply(agentName) {
            replyTo = agentName;
            replyLabel.textContent = \`↩ Replying to \${agentName}\`;
            replyIndicator.classList.add('visible');
            input.placeholder = \`Message to \${agentName}...\`;
            input.focus();
        }

        function clearReply() {
            replyTo = null;
            replyIndicator.classList.remove('visible');
            input.placeholder = 'Type a message...';
        }

        clearReplyBtn.onclick = clearReply;

        function appendMessage(msg) {
            if (msg.id && seenIds.has(msg.id)) return;
            if (msg.id) seenIds.add(msg.id);

            const div = document.createElement('div');
            const isMe = msg.from === '__user__';
            const isSystem = msg.system || msg.from === '__system__';
            
            div.className = 'message ' + (isSystem ? 'system' : (isMe ? 'from-me' : 'from-others'));
            if (msg.id) div.dataset.msgId = msg.id;
            
            if (!isSystem) {
                const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
                const displayName = isMe ? 'You' : escapeHtml(msg.from);
                const replyBtnHtml = !isMe ? \`<button class="reply-btn" data-agent="\${escapeHtml(msg.from)}">↩ Reply</button>\` : '';
                const readHtml = isMe ? \`<span class="read-status" data-msg-id="\${msg.id || ''}">✓</span>\` : '';
                div.innerHTML = \`
                    <div class="header">
                        <div class="header-left">
                            <span class="from" style="color: \${getAgentColor(msg.from)}">\${displayName}</span>
                            <span class="time">\${ts}</span>
                        </div>
                        <div class="header-right">
                            \${readHtml}
                            \${replyBtnHtml}
                        </div>
                    </div>
                    <div class="content">\${escapeHtml(msg.content)}</div>
                \`;
                if (!isMe) {
                    div.querySelector('.reply-btn').addEventListener('click', () => setReply(msg.from));
                }
            } else {
                div.innerHTML = \`<div class="content">\${escapeHtml(msg.content)}</div>\`;
            }
            
            msgContainer.appendChild(div);
            msgContainer.scrollTop = msgContainer.scrollHeight;
        }

        function markRead(msgId) {
            const el = document.querySelector(\`[data-msg-id="\${msgId}"] .read-status\`) ||
                       document.querySelector(\`.read-status[data-msg-id="\${msgId}"]\`);
            if (el) { el.textContent = '✓✓'; el.classList.add('read'); }
        }

        function getAgentColor(name) {
            if (name === '__user__') return '#4fc3f7';
            if (name === 'ClaudeLead') return '#ff8a65';
            const colors = ['#81c784', '#ba68c8', '#ffd54f', '#4db6ac', '#95a5a6'];
            let hash = 0;
            for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
            return colors[Math.abs(hash) % colors.length];
        }

        sendBtn.onclick = () => {
            const text = input.value.trim();
            if (text) {
                vscode.postMessage({ command: 'send', text, to: replyTo || '__group__' });
                input.value = '';
                clearReply();
            }
        };

        input.onkeydown = (e) => {
            if (e.key === 'Enter') sendBtn.onclick();
            if (e.key === 'Escape') clearReply();
        };

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'messages':
                    message.messages.forEach(appendMessage);
                    break;
                case 'markRead':
                    if (message.msgId) markRead(message.msgId);
                    break;
            }
        });
    </script>
</body>
</html>`;
  }
}

// --- Claude Hooks Auto-Setup ---


/**
 * Write/merge neohive hooks into .claude/settings.json on activate.
 * Only runs if the workspace has a .claude/ directory (Claude Code is in use).
 * Merges — never removes existing user hooks outside the neohive keys.
 * Script paths use ${CLAUDE_PROJECT_DIR} so they work on any machine.
 */
function setupClaudeHooks() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return;
  const root = folders[0].uri.fsPath;
  const claudeDir = path.join(root, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Only auto-setup if .claude/ already exists (user is a Claude Code user)
  if (!fs.existsSync(claudeDir)) return;

  // Detect whether the neohive plugin scripts directory is present
  const scriptsDir = path.join(root, 'agent-bridge', 'neohive-plugin', 'scripts');
  const hasScripts = fs.existsSync(scriptsDir);
  const scriptRef = hasScripts
    ? '${CLAUDE_PROJECT_DIR}/agent-bridge/neohive-plugin/scripts'
    : null;

  // Build the hook definitions — use script references when available,
  // fall back to minimal inline commands for external installs
  const listenReminder = "echo '\\n📡 NEOHIVE: Call listen() now to receive your next task. Do not stop without calling listen().'";

  const neohiveHooks = {
    UserPromptSubmit: scriptRef ? [
      {
        hooks: [{
          type: 'command',
          command: `${scriptRef}/before-prompt.sh`,
          timeout: 5,
          statusMessage: 'Loading Neohive team context...',
        }],
      },
    ] : [],
    PreToolUse: scriptRef ? [
      {
        matcher: 'Edit|Write',
        hooks: [{
          type: 'command',
          command: `${scriptRef}/enforce-locks.sh`,
          timeout: 5,
          statusMessage: 'Checking file locks...',
        }],
      },
    ] : [],
    PostToolUse: [
      ...(scriptRef ? [{
        matcher: 'mcp__neohive__.*',
        hooks: [{
          type: 'command',
          command: `${scriptRef}/track-activity.sh`,
          async: true,
          timeout: 5,
        }],
      }] : []),
      {
        matcher: 'mcp__neohive__send_message|mcp__neohive__advance_workflow|mcp__neohive__update_task|mcp__neohive__broadcast|mcp__neohive__add_rule|mcp__neohive__remove_rule|mcp__neohive__toggle_rule',
        hooks: [{
          type: 'command',
          command: listenReminder,
          timeout: 3,
        }],
      },
      ...(scriptRef ? [{
        matcher: 'Edit|Write|MultiEdit|mcp__neohive__update_task',
        hooks: [{
          type: 'command',
          command: `${scriptRef}/post-tool-use.sh`,
          async: true,
          timeout: 5,
        }],
      }] : []),
    ],
    Stop: [
      {
        hooks: [{
          type: 'command',
          command: scriptRef
            ? `${scriptRef}/enforce-listen.sh`
            : `node -e "const h=require('fs').existsSync(process.env.CLAUDE_PROJECT_DIR+'/.neohive/activity.jsonl');process.exit(h?0:0)"`,
          timeout: 5,
        }],
      },
    ],
  };

  try {
    let existing = {};
    if (fs.existsSync(settingsPath)) {
      try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    }

    // Merge: replace only the neohive-managed hook events; preserve everything else
    existing.hooks = Object.assign({}, existing.hooks || {}, neohiveHooks);

    // Drop empty arrays (e.g. UserPromptSubmit when no scripts available)
    for (const key of Object.keys(existing.hooks)) {
      if (Array.isArray(existing.hooks[key]) && existing.hooks[key].length === 0) {
        delete existing.hooks[key];
      }
    }

    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error('[neohive] Failed to write .claude/settings.json:', e.message);
  }
}

// --- Extension Activation ---

function activate(context) {
  createIdeLivenessBridge(context);

  const logChannel = vscode.window.createOutputChannel('Neohive');
  context.subscriptions.push(logChannel);
  const log = {
    info: (m) => logChannel.appendLine(String(m)),
    warn: (m) => logChannel.appendLine(String(m)),
    error: (m) => logChannel.appendLine(String(m)),
  };

  const terminalBridge = createTerminalBridge(context, log);
  context.subscriptions.push(terminalBridge);

  const agentProvider = new AgentTreeProvider();
  const workflowProvider = new WorkflowTreeProvider();
  const taskBoardProvider = new TaskBoardProvider(context.extensionUri);

  vscode.window.registerTreeDataProvider('neohive-agents', agentProvider);
  vscode.window.registerTreeDataProvider('neohive-workflows', workflowProvider);
  vscode.window.registerWebviewViewProvider('neohive-tasks', taskBoardProvider);

  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  mcpStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  mcpStatusBarItem.command = 'neohive.setupMcp';
  context.subscriptions.push(mcpStatusBarItem);
  mcpStatusBarItem.show();

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('neohive.refreshAgents', () => pollData()),
    vscode.commands.registerCommand('neohive.refreshWorkflows', () => pollData()),
    vscode.commands.registerCommand('neohive.refreshTasks', () => pollData()),
    vscode.commands.registerCommand('neohive.showAgents', () => {
      vscode.commands.executeCommand('neohive-agents.focus');
    }),
    vscode.commands.registerCommand('neohive.showWorkflows', () => {
      vscode.commands.executeCommand('neohive-workflows.focus');
    }),
    vscode.commands.registerCommand('neohive.setupMcp', commandSetupMcp),
    vscode.commands.registerCommand('neohive.configureAgentName', commandConfigureAgentName),
    vscode.commands.registerCommand('neohive.setupHooks', () => {
      setupClaudeHooks();
      vscode.window.showInformationMessage('Neohive: Claude Code hooks configured in .claude/settings.json');
    }),
    vscode.commands.registerCommand('neohive.bindAgentTerminal', () => terminalBridge.bindAgentTerminal()),
    vscode.commands.registerCommand('neohive.testTerminalBridge', () => terminalBridge.testTerminalBridge()),
    vscode.commands.registerCommand('neohive.openChat', () => NeohiveChatPanel.createOrShow(context.extensionUri))
  );

  // Auto-configure Claude Code hooks on every activate (idempotent merge)
  setupClaudeHooks();

  // @neohive chat participant (no-ops gracefully on VS Code < 1.90)
  registerNeohiveChatParticipant(context);

  checkMcpOnActivate();

  // agentName fallback: warn and offer configuration if not set
  checkAgentNameConfigured();

  // Polling loop
  let connected = false;

  async function pollData() {
    try {
      const [agentsRes, workflows, tasksRes, profilesRes] = await Promise.all([
        fetchJson('/api/agents'),
        fetchJson('/api/workflows').catch(() => []),
        fetchJson('/api/tasks').catch(() => []),
        fetchJson('/api/profiles').catch(() => ({})),
      ]);

      const agents = agentsRes.agents || agentsRes;
      const tasks = Array.isArray(tasksRes) ? tasksRes : (tasksRes.tasks || []);
      const profiles = profilesRes.profiles || profilesRes;

      try { terminalBridge.onAgentsUpdate(agents); } catch (_) {}
      agentProvider.setAgents(agents);
      workflowProvider.setWorkflows(Array.isArray(workflows) ? workflows : []);
      taskBoardProvider.updateTasks(tasks, agents, profiles);

      connected = true;
      updateStatusBar(statusBar, agents, true);
    } catch {
      connected = false;
      updateStatusBar(statusBar, {}, false);
    }
  }

  // Initial poll
  pollData();

  // Recurring poll
  const interval = setInterval(pollData, getPollInterval());
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  // Re-poll on config change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('neohive')) {
        pollData();
        if (e.affectsConfiguration('neohive.agentName') && typeof ideLivenessResync === 'function') {
          try {
            ideLivenessResync();
          } catch (_) {}
        }
      }
    })
  );

  // Watch for MCP config changes to update MCP status bar
  // Note: Antigravity uses a global path outside the workspace — use Uri-based watcher
  const mcpPath = getMcpConfigPath();
  if (mcpPath) {
    const mcpFilename = path.basename(mcpPath);
    const mcpDir = path.dirname(mcpPath);
    const ide = detectIde();
    const watchPattern = ide === 'antigravity'
      ? new vscode.RelativePattern(vscode.Uri.file(mcpDir), mcpFilename)
      : new vscode.RelativePattern(mcpDir, mcpFilename);
    const mcpWatcher = vscode.workspace.createFileSystemWatcher(watchPattern);
    mcpWatcher.onDidChange(() => updateMcpStatusBar(getMcpStatus()));
    mcpWatcher.onDidCreate(() => updateMcpStatusBar(getMcpStatus()));
    mcpWatcher.onDidDelete(() => updateMcpStatusBar(getMcpStatus()));
    context.subscriptions.push(mcpWatcher);
  }

  // Watch for task.json changes for real-time Kanban updates
  const dataDir = getNeohiveDataDir();
  if (dataDir) {
    const tasksWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dataDir, 'tasks.json')
    );
    tasksWatcher.onDidChange(() => pollData());
    tasksWatcher.onDidCreate(() => pollData());
    tasksWatcher.onDidDelete(() => pollData());
    context.subscriptions.push(tasksWatcher);
  }
}

function deactivate() {
  // Offline marker is written by subscription dispose from createIdeLivenessBridge
}

module.exports = { activate, deactivate };
