const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

function getNeohiveDataDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  return path.join(folders[0].uri.fsPath, '.neohive');
}

function writeIdeActivityFile(dataDir, agentName, fields) {
  if (!dataDir || !agentName) return;
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
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
    const agentName = sanitizeAgentName(
      vscode.workspace.getConfiguration('neohive').get('agentName', '')
    );
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
  context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution(() => {
    if (disposed) return;
    if (shellGraceTimer) { clearTimeout(shellGraceTimer); shellGraceTimer = null; }
    shellWorking = true;
    pushState({ focused: vscode.window.state.focused, ide_idle: false, extension_online: true });
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
  return vscode.workspace.getConfiguration('neohive').get('pollInterval', 5000);
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
      return [item];
    }

    return entries.map(([name, agent]) => new AgentTreeItem(name, agent));
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

// --- Status Bar ---

function createStatusBar() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'neohive.showAgents';
  item.text = '$(symbol-misc) Neohive';
  item.tooltip = 'Neohive - Connecting...';
  item.show();
  return item;
}

function updateStatusBar(statusBar, agents, connected) {
  if (!connected) {
    statusBar.text = '$(symbol-misc) Neohive $(circle-slash)';
    statusBar.tooltip = 'Neohive - Not connected';
    statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    return;
  }

  const entries = Object.entries(agents || {}).filter(([n]) => n !== '__system__' && n !== 'Dashboard');
  const alive = entries.filter(([, a]) => a.alive).length;
  const total = entries.length;

  statusBar.text = `$(symbol-misc) Neohive: ${alive}/${total}`;
  statusBar.tooltip = `Neohive - ${alive} agents online, ${total} total`;
  statusBar.color = undefined;
}

// --- Extension Activation ---

function activate(context) {
  createIdeLivenessBridge(context);

  const agentProvider = new AgentTreeProvider();
  const workflowProvider = new WorkflowTreeProvider();

  vscode.window.registerTreeDataProvider('neohive-agents', agentProvider);
  vscode.window.registerTreeDataProvider('neohive-workflows', workflowProvider);

  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('neohive.refreshAgents', () => pollData()),
    vscode.commands.registerCommand('neohive.refreshWorkflows', () => pollData()),
    vscode.commands.registerCommand('neohive.showAgents', () => {
      vscode.commands.executeCommand('neohive-agents.focus');
    }),
    vscode.commands.registerCommand('neohive.showWorkflows', () => {
      vscode.commands.executeCommand('neohive-workflows.focus');
    })
  );

  // Polling loop
  let connected = false;

  async function pollData() {
    try {
      const [agentsRes, workflows] = await Promise.all([
        fetchJson('/api/agents'),
        fetchJson('/api/workflows').catch(() => []),
      ]);

      const agents = agentsRes.agents || agentsRes;
      agentProvider.setAgents(agents);
      workflowProvider.setWorkflows(Array.isArray(workflows) ? workflows : []);
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
}

function deactivate() {
  // Offline marker is written by subscription dispose from createIdeLivenessBridge
}

module.exports = { activate, deactivate };
