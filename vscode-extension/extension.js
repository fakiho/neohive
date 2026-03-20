const vscode = require('vscode');
const http = require('http');

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
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
