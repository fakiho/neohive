#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { upsertNeohiveMcpInToml } = require('./lib/codex-neohive-toml');

const command = process.argv[2];

function printUsage() {
  console.log(`
  Neohive v6.0.3
  The MCP collaboration layer for AI CLI tools.

  Usage:
    npx neohive init                Auto-detect CLI and configure MCP
    npx neohive init --claude       Configure for Claude Code only
    npx neohive init --gemini       Configure for Gemini CLI only
    npx neohive init --codex        Configure for Codex CLI only
    npx neohive init --cursor       Configure for Cursor IDE only (.cursor/mcp.json)
    npx neohive init --vscode       Configure for VS Code GitHub Copilot
    npx neohive init --antigravity  Configure for Antigravity IDE
    npx neohive init --all          Configure for all supported CLIs
    npx neohive mcp                 Start MCP stdio server (used internally by IDE configs)
    npx neohive init --ollama       Setup Ollama local LLM bridge
    npx neohive init --template T   Initialize with a team template
    npx neohive serve               Run MCP server in HTTP mode (port 4321)
    npx neohive serve --port 8080   Custom port for HTTP server
    npx neohive dashboard           Launch web dashboard (http://localhost:3000)
    npx neohive dashboard --lan     Dashboard accessible on LAN
    npx neohive status              Show active agents and tasks
    npx neohive msg <agent> <text>  Send a message from CLI
    npx neohive doctor              Diagnostic health check
    npx neohive templates           List available team templates
    npx neohive reset --force       Clear all data (auto-archives first)
    npx neohive uninstall           Remove from all CLI configs
    npx neohive help                Show this help

  Templates: pair, team, review, debate, managed
  Docs: https://github.com/fakiho/neohive
  `);
}

// Detect which CLIs are installed
function detectCLIs() {
  const detected = [];
  const home = os.homedir();

  // Claude Code: ~/.claude/ directory exists
  if (fs.existsSync(path.join(home, '.claude'))) {
    detected.push('claude');
  }

  // Gemini CLI: ~/.gemini/ or GEMINI_API_KEY set
  if (fs.existsSync(path.join(home, '.gemini')) || process.env.GEMINI_API_KEY) {
    detected.push('gemini');
  }

  // Codex CLI: ~/.codex/ directory exists
  if (fs.existsSync(path.join(home, '.codex'))) {
    detected.push('codex');
  }

  // Cursor IDE: ~/.cursor/ (app support) exists
  if (fs.existsSync(path.join(home, '.cursor'))) {
    detected.push('cursor');
  }

  return detected;
}

// Detect Ollama installation
function detectOllama() {
  try {
    const version = execSync('ollama --version', { encoding: 'utf8', timeout: 5000 }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false };
  }
}

// The data directory where all agents read/write — must be the same for server + dashboard
function dataDir(cwd) {
  return path.join(cwd, '.neohive');
}

// Absolute Node binary for MCP configs — CLIs often spawn without Volta/nvm PATH, so plain "node" fails.
function mcpNodeCommand() {
  return process.execPath;
}

// MCP stdio "command" for npx — do not use /usr/bin/env (not portable on Windows).
function mcpNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

// Configure for Claude Code (.mcp.json in project root)
function setupClaude(serverPath, cwd) {
  const mcpConfigPath = path.join(cwd, '.mcp.json');
  let mcpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      // Backup corrupted file before overwriting
      const backup = mcpConfigPath + '.backup';
      fs.copyFileSync(mcpConfigPath, backup);
      console.log('  [warn] Existing .mcp.json was invalid — backed up to .mcp.json.backup');
    }
  }

  mcpConfig.mcpServers['neohive'] = {
    command: mcpNodeCommand(),
    args: [serverPath],
    timeout: 300,
  };

  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
  console.log('  [ok] Claude Code: .mcp.json updated');
}

// Configure for Gemini CLI (.gemini/settings.json or GEMINI.md with MCP config)
function setupGemini(serverPath, cwd) {
  // Gemini CLI uses .gemini/settings.json for MCP configuration
  const geminiDir = path.join(cwd, '.gemini');
  const settingsPath = path.join(geminiDir, 'settings.json');

  if (!fs.existsSync(geminiDir)) {
    fs.mkdirSync(geminiDir, { recursive: true });
  }

  let settings = { mcpServers: {} };
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.mcpServers) settings.mcpServers = {};
    } catch {
      const backup = settingsPath + '.backup';
      fs.copyFileSync(settingsPath, backup);
      console.log('  [warn] Existing settings.json was invalid — backed up to settings.json.backup');
    }
  }

  settings.mcpServers['neohive'] = {
    command: mcpNodeCommand(),
    args: [serverPath],
    timeout: 300,
    trust: true,
  };

  if (!settings.context) settings.context = {};
  if (!settings.context.files) settings.context.files = [];
  if (!settings.context.files.includes('GEMINI.md')) {
    settings.context.files.push('GEMINI.md');
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('  [ok] Gemini CLI: .gemini/settings.json updated');

  // Write GEMINI.md agent rules if not already present
  const geminiMdPath = path.join(cwd, 'GEMINI.md');
  if (!fs.existsSync(geminiMdPath)) {
    fs.writeFileSync(geminiMdPath, geminiMdTemplate());
    console.log('  [ok] Gemini CLI: GEMINI.md created with agent rules');
  } else {
    console.log('  [skip] GEMINI.md already exists — not overwriting');
  }
}

function geminiMdTemplate() {
  return `# Neohive Agent — Gemini CLI

You are a Neohive team agent. Follow these rules exactly, every session, no exceptions.

## First thing to do — always

1. Call \`register\` with your assigned name (e.g. \`register(name="Gemini")\`)
2. Call \`get_briefing\` to load project context and current work
3. Call \`listen\` to wait for messages from the Coordinator

Do NOT explore the codebase, ask questions, or take initiative before completing these 3 steps.

## Core rules

- **After every action** — call \`listen()\`. This is how you receive your next task.
- **Before starting a task** — call \`update_task(id, status="in_progress")\`
- **After finishing a task** — call \`update_task(id, status="done")\`, then report to Coordinator
- **Before editing a file** — call \`lock_file(path)\`. Call \`unlock_file(path)\` when done.
- **Check tasks first** — call \`list_tasks()\` before starting anything new. Never work on another agent's task.
- **Keep messages short** — 2–3 paragraphs max. Lead with what changed, then files, then decisions.

## Workflow

\`\`\`
register → get_briefing → listen → [receive task] → update_task(in_progress)
→ do work → update_task(done) → send_message(Coordinator, summary) → listen
\`\`\`

Repeat the last 5 steps for every task. Never exit the listen loop.

## Available MCP tools

**Messaging:** \`register\`, \`send_message\`, \`broadcast\`, \`listen\`, \`check_messages\`, \`get_history\`, \`handoff\`
**Tasks:** \`create_task\`, \`update_task\`, \`list_tasks\`
**Workflows:** \`create_workflow\`, \`advance_workflow\`, \`workflow_status\`
**Workspaces:** \`workspace_write\`, \`workspace_read\`, \`workspace_list\`
**Branching:** \`fork_conversation\`, \`switch_branch\`, \`list_branches\`

## What NOT to do

- Do not self-assign tasks
- Do not modify files without a task assigned to you
- Do not skip \`listen()\` after responding
- Do not send long messages — be concise
- Do not ask the Coordinator for permission before starting an assigned task — just do it
`;
}

// Configure for VS Code GitHub Copilot (.vscode/mcp.json + copilot instructions)
function setupVSCode(cwd) {
  const vscodeDir = path.join(cwd, '.vscode');
  const mcpPath = path.join(vscodeDir, 'mcp.json');
  if (!fs.existsSync(vscodeDir)) fs.mkdirSync(vscodeDir, { recursive: true });

  let config = { servers: {} };
  if (fs.existsSync(mcpPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (!config.servers) config.servers = {};
    } catch {
      fs.copyFileSync(mcpPath, mcpPath + '.backup');
      console.log('  [warn] Existing .vscode/mcp.json was invalid — backed up');
    }
  }

  config.servers['neohive'] = {
    type: 'stdio',
    command: mcpNpxCommand(),
    args: ['-y', 'neohive', 'mcp'],
    env: {
      NEOHIVE_DATA_DIR: '${workspaceFolder}/.neohive',
    },
    cwd: '${workspaceFolder}',
  };

  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  console.log('  [ok] VS Code: .vscode/mcp.json updated');

  // Write copilot instructions
  const githubDir = path.join(cwd, '.github');
  const instructionsPath = path.join(githubDir, 'copilot-instructions.md');
  if (!fs.existsSync(githubDir)) fs.mkdirSync(githubDir, { recursive: true });
  if (!fs.existsSync(instructionsPath)) {
    fs.writeFileSync(instructionsPath, neohiveAgentRules('Copilot'));
    console.log('  [ok] VS Code: .github/copilot-instructions.md created');
  }
}

// Configure for Antigravity (~/.gemini/antigravity/mcp_config.json + skill)
function setupAntigravity(cwd) {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
  const mcpPath = path.join(antigravityDir, 'mcp_config.json');
  if (!fs.existsSync(antigravityDir)) fs.mkdirSync(antigravityDir, { recursive: true });

  let config = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    try {
      // Strip JS-style comments before parsing (Antigravity writes JSONC)
      const raw = fs.readFileSync(mcpPath, 'utf8').replace(/\/\/[^\n]*/g, '');
      config = JSON.parse(raw);
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      fs.copyFileSync(mcpPath, mcpPath + '.backup');
      console.log('  [warn] Existing mcp_config.json was invalid — backed up');
    }
  }

  const abDataDir = path.join(path.resolve(cwd), '.neohive').replace(/\\/g, '/');

  config.mcpServers['neohive'] = {
    command: 'npx',
    args: ['-y', 'neohive', 'mcp'],
    cwd: cwd,
    env: { NEOHIVE_DATA_DIR: abDataDir },
  };

  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  console.log('  [ok] Antigravity: ~/.gemini/antigravity/mcp_config.json updated');

  // Write skill
  const skillDir = path.join(cwd, '.agent', 'skills', 'neohive');
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    fs.writeFileSync(skillPath, neohiveAgentRules('Gemini'));
    console.log('  [ok] Antigravity: .agent/skills/neohive/SKILL.md created');
  }
}

function neohiveAgentRules(defaultName) {
  return `# Neohive Agent

You are a Neohive team agent. Follow these rules every session.

## On session start — always do this first

1. Call \`register\` with your assigned name (e.g. \`register(name="${defaultName}")\`)
2. Call \`get_briefing\` to load project context and active work
3. Call \`listen\` to wait for messages from the Coordinator

Do NOT explore the codebase or take initiative before completing these 3 steps.

## Core rules

- **After every action** — call \`listen()\`. This is how you receive your next task.
- **Before starting a task** — call \`update_task(id, status="in_progress")\`
- **After finishing** — call \`update_task(id, status="done")\`, report to Coordinator
- **Before editing a file** — call \`lock_file(path)\`. Call \`unlock_file(path)\` when done.
- **Check tasks first** — call \`list_tasks()\` before starting anything. Never take another agent's task.
- **Keep messages short** — 2–3 paragraphs max. Lead with what changed, then files, then decisions.

## Workflow loop

\`\`\`
register → get_briefing → listen → [receive task] → update_task(in_progress)
→ do work → update_task(done) → send_message(Coordinator, summary) → listen
\`\`\`

Never exit the listen loop.

## Available MCP tools (neohive server)

**Messaging:** \`register\`, \`send_message\`, \`broadcast\`, \`listen\`, \`check_messages\`, \`get_history\`
**Tasks:** \`create_task\`, \`update_task\`, \`list_tasks\`
**Workflows:** \`create_workflow\`, \`advance_workflow\`, \`workflow_status\`
**Workspaces:** \`workspace_write\`, \`workspace_read\`, \`workspace_list\`
`;
}

// Configure for Codex CLI (uses .codex/config.toml)
function setupCodex(serverPath, cwd) {
  const codexDir = path.join(cwd, '.codex');
  const configPath = path.join(codexDir, 'config.toml');

  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }

  // Read existing config or start fresh
  let config = '';
  if (fs.existsSync(configPath)) {
    config = fs.readFileSync(configPath, 'utf8');
  }

  // Backup existing config before modifying
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, configPath + '.backup');
  }

  const abDataDir = path.join(path.resolve(cwd), '.neohive').replace(/\\/g, '/');
  const envSection =
    `[mcp_servers.neohive.env]\nNEOHIVE_DATA_DIR = ${JSON.stringify(abDataDir)}\n`;
  const hadNeohive = config.includes('[mcp_servers.neohive]');
  config = upsertNeohiveMcpInToml(config, {
    command: mcpNodeCommand(),
    serverPath,
    timeout: 300,
    envSection: hadNeohive ? undefined : envSection,
  });
  fs.writeFileSync(configPath, config);

  console.log('  [ok] Codex CLI: .codex/config.toml updated');
}

// Configure for Cursor IDE — absolute NEOHIVE_DATA_DIR so Node never sees unexpanded ${workspaceFolder}.
// If the IDE omits env on spawn, server startup still resolves the hive via lib/resolve-server-data-dir.js
// (walks cwd ancestors for the same MCP files).
function setupCursor(serverPath, cwd) {
  const cursorDir = path.join(cwd, '.cursor');
  const mcpConfigPath = path.join(cursorDir, 'mcp.json');
  const abDataDir = path.join(path.resolve(cwd), '.neohive').replace(/\\/g, '/');

  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  let mcpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      const backup = mcpConfigPath + '.backup';
      fs.copyFileSync(mcpConfigPath, backup);
      console.log('  [warn] Existing .cursor/mcp.json was invalid — backed up to mcp.json.backup');
    }
  }

  mcpConfig.mcpServers['neohive'] = {
    command: mcpNodeCommand(),
    args: [serverPath],
    env: { NEOHIVE_DATA_DIR: abDataDir },
    timeout: 300,
  };

  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
  console.log('  [ok] Cursor IDE: .cursor/mcp.json updated');
}

// Setup Ollama agent bridge script
function setupOllama(serverPath, cwd) {
  const dir = dataDir(cwd);
  const scriptPath = path.join(cwd, '.neohive', 'ollama-agent.js');

  if (!fs.existsSync(path.join(cwd, '.neohive'))) {
    fs.mkdirSync(path.join(cwd, '.neohive'), { recursive: true });
  }

  const script = `#!/usr/bin/env node
// ollama-agent.js - bridges Ollama to Neohive
// Usage: node .neohive/ollama-agent.js [agent-name] [model]
const fs = require('fs'), path = require('path'), http = require('http');
const DATA_DIR = path.join(__dirname);
const name = process.argv[2] || 'Ollama';
if (!/^[a-zA-Z0-9_-]{1,20}$/.test(name)) throw new Error('Invalid agent name');
const model = process.argv[3] || 'llama3';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function readJsonl(f) { if (!fs.existsSync(f)) return []; return fs.readFileSync(f, 'utf8').split(/\\r?\\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }

// Register agent
function register() {
  const agentsFile = path.join(DATA_DIR, 'agents.json');
  const agents = readJson(agentsFile);
  agents[name] = { pid: process.pid, timestamp: new Date().toISOString(), last_activity: new Date().toISOString(), provider: 'Ollama (' + model + ')' };
  fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
  console.log('[' + name + '] Registered (PID ' + process.pid + ', model: ' + model + ')');
}

// Update heartbeat
function heartbeat() {
  const agentsFile = path.join(DATA_DIR, 'agents.json');
  const agents = readJson(agentsFile);
  if (agents[name]) {
    agents[name].last_activity = new Date().toISOString();
    agents[name].pid = process.pid;
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
  }
}

// Call Ollama API
function callOllama(prompt) {
  return new Promise(function(resolve, reject) {
    const url = new URL(OLLAMA_URL + '/api/chat');
    const body = JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], stream: false });
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { const j = JSON.parse(data); resolve(j.message ? j.message.content : data); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Send a message
function sendMessage(to, content) {
  const msgId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const msg = { id: msgId, from: name, to: to, content: content, timestamp: new Date().toISOString() };
  fs.appendFileSync(path.join(DATA_DIR, 'messages.jsonl'), JSON.stringify(msg) + '\\n');
  fs.appendFileSync(path.join(DATA_DIR, 'history.jsonl'), JSON.stringify(msg) + '\\n');
  console.log('[' + name + '] -> ' + to + ': ' + content.substring(0, 80) + (content.length > 80 ? '...' : ''));
}

// Listen for messages
let lastOffset = 0;
function checkMessages() {
  const consumedFile = path.join(DATA_DIR, 'consumed-' + name + '.json');
  const consumed = readJson(consumedFile);
  lastOffset = consumed.offset || 0;

  const messages = readJsonl(path.join(DATA_DIR, 'messages.jsonl'));
  const newMsgs = messages.slice(lastOffset).filter(function(m) {
    return m.to === name || (m.to === 'all' && m.from !== name);
  });

  if (newMsgs.length > 0) {
    consumed.offset = messages.length;
    fs.writeFileSync(consumedFile, JSON.stringify(consumed));
  }

  return newMsgs;
}

async function processMessages() {
  const msgs = checkMessages();
  for (const m of msgs) {
    console.log('[' + name + '] <- ' + m.from + ': ' + m.content.substring(0, 80));
    try {
      const response = await callOllama(m.content);
      sendMessage(m.from, response);
    } catch (e) {
      sendMessage(m.from, 'Error calling Ollama: ' + e.message);
    }
  }
}

// Main loop
register();
const hb = setInterval(heartbeat, 10000);
hb.unref();
console.log('[' + name + '] Listening for messages... (Ctrl+C to stop)');
setInterval(processMessages, 2000);

// Cleanup on exit
process.on('SIGINT', function() { console.log('\\n[' + name + '] Shutting down.'); process.exit(0); });
`;

  const tmpPath = scriptPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, script);
  fs.renameSync(tmpPath, scriptPath);
  console.log('  [ok] Ollama agent script created: .neohive/ollama-agent.js');
  console.log('');
  console.log('  Launch an Ollama agent with:');
  console.log('    node .neohive/ollama-agent.js <name> <model>');
  console.log('');
  console.log('  Examples:');
  console.log('    node .neohive/ollama-agent.js Ollama llama3');
  console.log('    node .neohive/ollama-agent.js Coder codellama');
  console.log('    node .neohive/ollama-agent.js Writer mistral');
}

function init() {
  const cwd = process.cwd();
  const serverPath = path.join(__dirname, 'server.js').replace(/\\/g, '/');
  const gitignorePath = path.join(cwd, '.gitignore');
  const flag = process.argv[3];

  console.log('');
  console.log('  Neohive — Initializing Neohive');
  console.log('  ==========================================');
  console.log('');

  let targets = [];

  if (flag === '--claude') {
    targets = ['claude'];
  } else if (flag === '--gemini') {
    targets = ['gemini'];
  } else if (flag === '--codex') {
    targets = ['codex'];
  } else if (flag === '--cursor') {
    targets = ['cursor'];
  } else if (flag === '--vscode') {
    targets = ['vscode'];
  } else if (flag === '--antigravity') {
    targets = ['antigravity'];
  } else if (flag === '--all') {
    targets = ['claude', 'gemini', 'codex', 'cursor', 'vscode', 'antigravity'];
  } else if (flag === '--ollama') {
    const ollama = detectOllama();
    if (!ollama.installed) {
      console.log('  Ollama not found. Install it from: https://ollama.com/download');
      console.log('  After installing, run: ollama pull llama3');
      console.log('');
    } else {
      console.log('  Ollama detected: ' + ollama.version);
      setupOllama(serverPath, cwd);
    }
    targets = detectCLIs();
    if (targets.length === 0) targets = ['claude'];
  } else {
    // Auto-detect
    targets = detectCLIs();
    if (targets.length === 0) {
      // Default to claude if nothing detected
      targets = ['claude'];
      console.log('  No CLI detected, defaulting to Claude Code config.');
    } else {
      console.log(`  Detected CLI(s): ${targets.join(', ')}`);
    }
  }

  console.log('');

  for (const target of targets) {
    switch (target) {
      case 'claude':      setupClaude(serverPath, cwd);   break;
      case 'gemini':      setupGemini(serverPath, cwd);   break;
      case 'codex':       setupCodex(serverPath, cwd);    break;
      case 'cursor':      setupCursor(serverPath, cwd);   break;
      case 'vscode':      setupVSCode(cwd);               break;
      case 'antigravity': setupAntigravity(cwd);          break;
    }
  }

  // Add .neohive/ and MCP config files to .gitignore
  const gitignoreEntries = ['.neohive/', '.mcp.json', '.cursor/mcp.json', '.codex/', '.gemini/'];
  if (fs.existsSync(gitignorePath)) {
    let content = fs.readFileSync(gitignorePath, 'utf8');
    const missing = gitignoreEntries.filter(e => !content.includes(e));
    if (missing.length) {
      content += '\n# Neohive (auto-added by neohive init)\n' + missing.join('\n') + '\n';
      fs.writeFileSync(gitignorePath, content);
      console.log('  [ok] Added to .gitignore: ' + missing.join(', '));
    } else {
      console.log('  [ok] .gitignore already configured');
    }
  } else {
    fs.writeFileSync(gitignorePath, '# Neohive (auto-added by neohive init)\n' + gitignoreEntries.join('\n') + '\n');
    console.log('  [ok] .gitignore created');
  }

  const configuredCursor = targets.includes('cursor');
  console.log('');
  console.log(
    configuredCursor
      ? '  Neohive is ready! Restart Cursor (or reload MCP tools) and restart any terminal CLIs you use.'
      : '  Neohive is ready! Restart your CLI to pick up the MCP tools.'
  );
  console.log('  MCP server command is your current Node binary (works when the IDE has no Volta/nvm in PATH):');
  console.log('    ' + mcpNodeCommand());
  console.log('  Re-run `npx neohive init` after switching machines or Node versions.');
  console.log('');

  // Show template if --template was provided
  var templateFlag = null;
  for (var i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === '--template' && process.argv[i + 1]) {
      templateFlag = process.argv[i + 1];
      break;
    }
  }

  if (templateFlag) {
    showTemplate(templateFlag);
  } else {
    if (configuredCursor) {
      console.log('  Cursor: use register + listen() from chat (neohive MCP). Terminal CLIs: one session per agent.');
    } else {
      console.log('  Open two terminals and start a conversation between agents.');
    }
    console.log('  Tip: Use "npx neohive init --template pair" for ready-made prompts.');
    console.log('');
    console.log('  \x1b[1m  Monitor:\x1b[0m');
    console.log('    npx neohive dashboard   → http://localhost:3000 (set NEOHIVE_PORT to change)');
    console.log('    npx neohive status');
    console.log('    npx neohive doctor');
    console.log('');
  }
}

function reset() {
  const targetDir = process.env.NEOHIVE_DATA_DIR || path.join(process.cwd(), '.neohive');

  if (!fs.existsSync(targetDir)) {
    console.log('  No .neohive/ directory found. Nothing to reset.');
    return;
  }

  // Safety: count messages to show user what they're about to delete
  const historyFile = path.join(targetDir, 'history.jsonl');
  let msgCount = 0;
  if (fs.existsSync(historyFile)) {
    msgCount = fs.readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(l => l.trim()).length;
  }

  // Require --force flag, otherwise warn and exit
  if (!process.argv.includes('--force')) {
    console.log('');
    console.log('  ⚠  This will permanently delete all conversation data in:');
    console.log('     ' + targetDir);
    if (msgCount > 0) console.log('     (' + msgCount + ' messages in history)');
    console.log('');
    console.log('  To confirm, run:  npx neohive reset --force');
    console.log('');
    return;
  }

  // Auto-archive before deleting
  const archiveDir = path.join(targetDir, '..', '.neohive-archive');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivePath = path.join(archiveDir, timestamp);
  try {
    fs.mkdirSync(archivePath, { recursive: true });
    const filesToArchive = ['history.jsonl', 'messages.jsonl', 'agents.json', 'decisions.json', 'tasks.json'];
    let archived = 0;
    for (const f of filesToArchive) {
      const src = path.join(targetDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(archivePath, f));
        archived++;
      }
    }
    if (archived > 0) {
      console.log('  [ok] Archived ' + archived + ' files to .neohive-archive/' + timestamp + '/');
    }
  } catch (e) {
    console.log('  [warn] Could not archive: ' + e.message + ' — proceeding with reset anyway.');
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  console.log('  Cleared all data from ' + targetDir);
}

function getTemplates() {
  const templatesDir = path.join(__dirname, 'templates');
  if (!fs.existsSync(templatesDir)) return [];
  return fs.readdirSync(templatesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(templatesDir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function listTemplates() {
  const templates = getTemplates();
  console.log('');
  console.log('  Available Agent Templates');
  console.log('  ========================');
  console.log('');
  for (const t of templates) {
    const agentNames = t.agents.map(a => a.name).join(', ');
    console.log('  ' + t.name.padEnd(12) + ' ' + t.description);
    console.log('  ' + ''.padEnd(12) + ' Agents: ' + agentNames);
    console.log('');
  }
  console.log('  Usage: npx neohive init --template <name>');
  console.log('');
}

function showTemplate(templateName) {
  const templates = getTemplates();
  const template = templates.find(t => t.name === templateName);
  if (!template) {
    console.error('  Unknown template: ' + templateName);
    console.error('  Available: ' + templates.map(t => t.name).join(', '));
    process.exit(1);
  }

  console.log('');
  console.log('  Template: ' + template.name);
  console.log('  ' + template.description);
  console.log('');
  console.log('  Copy these prompts into each terminal:');
  console.log('  ======================================');

  for (var i = 0; i < template.agents.length; i++) {
    var a = template.agents[i];
    console.log('');
    console.log('  --- Terminal ' + (i + 1) + ': ' + a.name + ' (' + a.role + ') ---');
    console.log('');
    console.log('  ' + a.prompt.replace(/\n/g, '\n  '));
    console.log('');
  }
}

function serve() {
  // Parse --port flag
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1 && process.argv[portIdx + 1]) {
    process.env.NEOHIVE_SERVER_PORT = process.argv[portIdx + 1];
  }
  // Signal server.js to use HTTP transport
  process.env.NEOHIVE_TRANSPORT = 'http';
  require('./server.js');
}

function dashboard() {
  if (process.argv.includes('--lan')) {
    process.env.NEOHIVE_LAN = 'true';
  }
  require('./dashboard.js');
}

function resolveDataDirCli() {
  return process.env.NEOHIVE_DATA_DIR || path.join(process.cwd(), '.neohive');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cliMsg() {
  const recipient = process.argv[3];
  const textParts = process.argv.slice(4);
  if (!recipient || !textParts.length) {
    console.error('  Usage: npx neohive msg <agent> <text>');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(recipient)) {
    console.error('  Agent name must be 1-20 alphanumeric characters (with _ or -).');
    process.exit(1);
  }
  const text = textParts.join(' ');
  const dir = resolveDataDirCli();
  if (!fs.existsSync(dir)) {
    console.error('  No .neohive/ directory found. Run "npx neohive init" first.');
    process.exit(1);
  }

  const msgId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const msg = {
    id: msgId,
    from: 'CLI',
    to: recipient,
    content: text,
    timestamp: new Date().toISOString(),
  };

  const messagesFile = path.join(dir, 'messages.jsonl');
  const historyFile = path.join(dir, 'history.jsonl');
  fs.appendFileSync(messagesFile, JSON.stringify(msg) + '\n');
  fs.appendFileSync(historyFile, JSON.stringify(msg) + '\n');

  console.log('  Message sent to ' + recipient + ': ' + text);
}

function cliStatus() {
  const dir = resolveDataDirCli();
  if (!fs.existsSync(dir)) {
    console.error('  No .neohive/ directory found. Run "npx neohive init" first.');
    process.exit(1);
  }

  const agents = readJson(path.join(dir, 'agents.json'));
  const history = readJsonl(path.join(dir, 'history.jsonl'));
  const profiles = readJson(path.join(dir, 'profiles.json'));
  const workflows = readJson(path.join(dir, 'workflows.json'));
  const tasks = readJson(path.join(dir, 'tasks.json'));

  // Merge heartbeat files for live activity data
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('heartbeat-') && f.endsWith('.json'));
    for (const f of files) {
      const name = f.slice(10, -5);
      if (agents[name]) {
        try {
          const hb = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (hb.last_activity) agents[name].last_activity = hb.last_activity;
          if (hb.pid) agents[name].pid = hb.pid;
        } catch {}
      }
    }
  } catch {}

  const onlineCount = Object.values(agents).filter(a => isPidAlive(a.pid)).length;

  console.log('');
  console.log('  Neohive — Status');
  console.log('  =======================');
  console.log('  Messages: ' + history.length + '  |  Agents: ' + onlineCount + '/' + Object.keys(agents).length + ' online');
  console.log('');

  // Agents with roles
  const names = Object.keys(agents);
  if (!names.length) {
    console.log('  No agents registered.');
  } else {
    console.log('  Agents:');
    for (const name of names) {
      const info = agents[name];
      const alive = isPidAlive(info.pid);
      const status = alive ? '\x1b[32monline\x1b[0m' : '\x1b[31moffline\x1b[0m';
      const lastActivity = info.last_activity || info.timestamp || '';
      const role = (profiles && profiles[name] && profiles[name].role) ? ' [' + profiles[name].role + ']' : '';
      const msgCount = history.filter(m => m.from === name).length;
      console.log('    ' + name.padEnd(16) + ' ' + status + role.padEnd(16) + '  msgs: ' + msgCount + '  last: ' + (lastActivity ? new Date(lastActivity).toLocaleTimeString() : '-'));
    }
  }

  // Active workflows
  const activeWfs = Array.isArray(workflows) ? workflows.filter(w => w.status === 'active') : [];
  if (activeWfs.length > 0) {
    console.log('');
    console.log('  Workflows:');
    for (const wf of activeWfs) {
      const done = wf.steps.filter(s => s.status === 'done').length;
      const total = wf.steps.length;
      const pct = Math.round((done / total) * 100);
      const mode = wf.autonomous ? ' (autonomous)' : '';
      console.log('    ' + wf.name.padEnd(24) + ' ' + done + '/' + total + ' (' + pct + '%)' + mode);
    }
  }

  // Active tasks
  const activeTasks = Array.isArray(tasks) ? tasks.filter(t => t.status === 'in_progress') : [];
  if (activeTasks.length > 0) {
    console.log('');
    console.log('  Tasks in progress:');
    for (const t of activeTasks.slice(0, 5)) {
      console.log('    ' + (t.title || 'Untitled').padEnd(30) + ' -> ' + (t.assignee || 'unassigned'));
    }
    if (activeTasks.length > 5) console.log('    ... and ' + (activeTasks.length - 5) + ' more');
  }

  console.log('');
}

// v6.0: Diagnostic health check
function cliDoctor() {
  console.log('');
  console.log('  \x1b[1mNeohive — Doctor\x1b[0m');
  console.log('  ======================');
  let issues = 0;

  // Check data directory
  const dir = path.join(process.cwd(), '.neohive');
  if (fs.existsSync(dir)) {
    console.log('  \x1b[32m✓\x1b[0m .neohive/ directory exists');
    try { fs.accessSync(dir, fs.constants.W_OK); console.log('  \x1b[32m✓\x1b[0m .neohive/ is writable'); }
    catch { console.log('  \x1b[31m✗\x1b[0m .neohive/ is NOT writable'); issues++; }
  } else {
    console.log('  \x1b[33m!\x1b[0m .neohive/ not found. Run "npx neohive init" first.');
    issues++;
  }

  // Check server.js
  const serverPath = path.join(__dirname, 'server.js');
  if (fs.existsSync(serverPath)) {
    console.log('  \x1b[32m✓\x1b[0m server.js found');
  } else {
    console.log('  \x1b[31m✗\x1b[0m server.js MISSING'); issues++;
  }

  // Check agents online
  if (fs.existsSync(dir)) {
    const agentsFile = path.join(dir, 'agents.json');
    if (fs.existsSync(agentsFile)) {
      const agents = readJson(agentsFile);
      const online = Object.entries(agents).filter(([, a]) => isPidAlive(a.pid)).length;
      const total = Object.keys(agents).length;
      if (online > 0) {
        console.log('  \x1b[32m✓\x1b[0m ' + online + '/' + total + ' agents online');
      } else if (total > 0) {
        console.log('  \x1b[33m!\x1b[0m ' + total + ' agents registered but none online');
      } else {
        console.log('  \x1b[33m!\x1b[0m No agents registered yet');
      }
    }

    // Check config
    const configFile = path.join(dir, 'config.json');
    if (fs.existsSync(configFile)) {
      const config = readJson(configFile);
      console.log('  \x1b[32m✓\x1b[0m Conversation mode: ' + (config.conversation_mode || 'direct'));
    }

    // Check guide file
    const guideFile = path.join(dir, 'guide.md');
    if (fs.existsSync(guideFile)) {
      console.log('  \x1b[32m✓\x1b[0m Custom guide.md found');
    }
  }

  // Check Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1));
  if (major >= 18) {
    console.log('  \x1b[32m✓\x1b[0m Node.js ' + nodeVersion + ' (OK)');
  } else {
    console.log('  \x1b[31m✗\x1b[0m Node.js ' + nodeVersion + ' — v18+ recommended'); issues++;
  }

  console.log('');
  if (issues === 0) {
    console.log('  \x1b[32mAll checks passed. System is healthy.\x1b[0m');
  } else {
    console.log('  \x1b[31m' + issues + ' issue(s) found. Fix them and run doctor again.\x1b[0m');
  }
  console.log('');
}

// Uninstall neohive from all CLI configs
function uninstall() {
  const cwd = process.cwd();
  const home = os.homedir();
  const removed = [];
  const notFound = [];

  console.log('');
  console.log('  Neohive — Uninstall');
  console.log('  =========================');
  console.log('');

  // 1. Remove from Claude Code project config (.mcp.json in cwd)
  const mcpLocalPath = path.join(cwd, '.mcp.json');
  if (fs.existsSync(mcpLocalPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpLocalPath, 'utf8'));
      if (mcpConfig.mcpServers && mcpConfig.mcpServers['neohive']) {
        delete mcpConfig.mcpServers['neohive'];
        fs.writeFileSync(mcpLocalPath, JSON.stringify(mcpConfig, null, 2) + '\n');
        removed.push('Claude Code (project): ' + mcpLocalPath);
      } else {
        notFound.push('Claude Code (project): no neohive entry in .mcp.json');
      }
    } catch (e) {
      console.log('  [warn] Could not parse ' + mcpLocalPath + ': ' + e.message);
    }
  } else {
    notFound.push('Claude Code (project): .mcp.json not found');
  }

  // 2. Remove from Claude Code global config (~/.claude/mcp.json)
  const mcpGlobalPath = path.join(home, '.claude', 'mcp.json');
  if (fs.existsSync(mcpGlobalPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpGlobalPath, 'utf8'));
      if (mcpConfig.mcpServers && mcpConfig.mcpServers['neohive']) {
        delete mcpConfig.mcpServers['neohive'];
        fs.writeFileSync(mcpGlobalPath, JSON.stringify(mcpConfig, null, 2) + '\n');
        removed.push('Claude Code (global): ' + mcpGlobalPath);
      } else {
        notFound.push('Claude Code (global): no neohive entry');
      }
    } catch (e) {
      console.log('  [warn] Could not parse ' + mcpGlobalPath + ': ' + e.message);
    }
  } else {
    notFound.push('Claude Code (global): ~/.claude/mcp.json not found');
  }

  // 3. Remove from Gemini CLI config (~/.gemini/settings.json)
  const geminiSettingsPath = path.join(home, '.gemini', 'settings.json');
  if (fs.existsSync(geminiSettingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(geminiSettingsPath, 'utf8'));
      if (settings.mcpServers && settings.mcpServers['neohive']) {
        delete settings.mcpServers['neohive'];
        fs.writeFileSync(geminiSettingsPath, JSON.stringify(settings, null, 2) + '\n');
        removed.push('Gemini CLI: ' + geminiSettingsPath);
      } else {
        notFound.push('Gemini CLI: no neohive entry');
      }
    } catch (e) {
      console.log('  [warn] Could not parse ' + geminiSettingsPath + ': ' + e.message);
    }
  } else {
    notFound.push('Gemini CLI: ~/.gemini/settings.json not found');
  }

  // 4. Remove from Gemini CLI project config (.gemini/settings.json in cwd)
  const geminiLocalPath = path.join(cwd, '.gemini', 'settings.json');
  if (fs.existsSync(geminiLocalPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(geminiLocalPath, 'utf8'));
      if (settings.mcpServers && settings.mcpServers['neohive']) {
        delete settings.mcpServers['neohive'];
        fs.writeFileSync(geminiLocalPath, JSON.stringify(settings, null, 2) + '\n');
        removed.push('Gemini CLI (project): ' + geminiLocalPath);
      } else {
        notFound.push('Gemini CLI (project): no neohive entry');
      }
    } catch (e) {
      console.log('  [warn] Could not parse ' + geminiLocalPath + ': ' + e.message);
    }
  }

  // 5. Remove from Codex CLI config (~/.codex/config.toml)
  const codexConfigPath = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(codexConfigPath)) {
    try {
      let config = fs.readFileSync(codexConfigPath, 'utf8');
      if (config.includes('[mcp_servers.neohive]')) {
        // Remove from [mcp_servers.neohive] to the next [section] or end of file
        // This covers both [mcp_servers.neohive] and [mcp_servers.neohive.env]
        config = config.replace(/\n?\[mcp_servers\.neohive[^\]]*\][^\[]*(?=\[|$)/g, '');
        // Clean up multiple blank lines left behind
        config = config.replace(/\n{3,}/g, '\n\n');
        fs.writeFileSync(codexConfigPath, config);
        removed.push('Codex CLI: ' + codexConfigPath);
      } else {
        notFound.push('Codex CLI: no neohive section in config.toml');
      }
    } catch (e) {
      console.log('  [warn] Could not process ' + codexConfigPath + ': ' + e.message);
    }
  } else {
    notFound.push('Codex CLI: ~/.codex/config.toml not found');
  }

  // 6. Remove from Codex CLI project config (.codex/config.toml in cwd)
  const codexLocalPath = path.join(cwd, '.codex', 'config.toml');
  if (fs.existsSync(codexLocalPath)) {
    try {
      let config = fs.readFileSync(codexLocalPath, 'utf8');
      if (config.includes('[mcp_servers.neohive]')) {
        config = config.replace(/\n?\[mcp_servers\.neohive[^\]]*\][^\[]*(?=\[|$)/g, '');
        config = config.replace(/\n{3,}/g, '\n\n');
        fs.writeFileSync(codexLocalPath, config);
        removed.push('Codex CLI (project): ' + codexLocalPath);
      }
    } catch (e) {
      console.log('  [warn] Could not process ' + codexLocalPath + ': ' + e.message);
    }
  }

  // 7. Remove from Cursor IDE project config (.cursor/mcp.json in cwd)
  const cursorMcpPath = path.join(cwd, '.cursor', 'mcp.json');
  if (fs.existsSync(cursorMcpPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
      if (mcpConfig.mcpServers && mcpConfig.mcpServers['neohive']) {
        delete mcpConfig.mcpServers['neohive'];
        fs.writeFileSync(cursorMcpPath, JSON.stringify(mcpConfig, null, 2) + '\n');
        removed.push('Cursor IDE (project): ' + cursorMcpPath);
      } else {
        notFound.push('Cursor IDE (project): no neohive entry in .cursor/mcp.json');
      }
    } catch (e) {
      console.log('  [warn] Could not parse ' + cursorMcpPath + ': ' + e.message);
    }
  } else {
    notFound.push('Cursor IDE (project): .cursor/mcp.json not found');
  }

  // 8. Remove from Cursor IDE user config (~/.cursor/mcp.json)
  const cursorGlobalPath = path.join(home, '.cursor', 'mcp.json');
  if (fs.existsSync(cursorGlobalPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(cursorGlobalPath, 'utf8'));
      if (mcpConfig.mcpServers && mcpConfig.mcpServers['neohive']) {
        delete mcpConfig.mcpServers['neohive'];
        fs.writeFileSync(cursorGlobalPath, JSON.stringify(mcpConfig, null, 2) + '\n');
        removed.push('Cursor IDE (global): ' + cursorGlobalPath);
      } else {
        notFound.push('Cursor IDE (global): no neohive entry');
      }
    } catch (e) {
      console.log('  [warn] Could not parse ' + cursorGlobalPath + ': ' + e.message);
    }
  } else {
    notFound.push('Cursor IDE (global): ~/.cursor/mcp.json not found');
  }

  // Print summary
  if (removed.length > 0) {
    console.log('  Removed neohive from:');
    for (const r of removed) {
      console.log('    [ok] ' + r);
    }
  } else {
    console.log('  No neohive configurations found to remove.');
  }

  if (notFound.length > 0) {
    console.log('');
    console.log('  Skipped (not found):');
    for (const n of notFound) {
      console.log('    [-] ' + n);
    }
  }

  // 9. Check for data directory
  const dataPath = path.join(cwd, '.neohive');
  if (fs.existsSync(dataPath)) {
    console.log('');
    console.log('  Found .neohive/ directory with conversation data.');
    console.log('  To remove it, manually delete: ' + dataPath);
  }

  console.log('');
  if (removed.length > 0) {
    console.log('  Restart your CLI terminals for changes to take effect.');
  }
  console.log('');
}

switch (command) {
  case 'init':
    init();
    break;
  case 'templates':
    listTemplates();
    break;
  case 'mcp':
    // Start stdio MCP server — used as the command in all MCP configs: npx neohive mcp
    require('./server.js');
    break;
  case 'serve':
    serve();
    break;
  case 'dashboard':
    dashboard();
    break;
  case 'reset':
    reset();
    break;
  case 'doctor':
    cliDoctor();
    break;
  case 'msg':
  case 'message':
  case 'send':
    cliMsg();
    break;
  case 'status':
    cliStatus();
    break;
  case 'uninstall':
  case 'remove':
    uninstall();
    break;
  case 'plugin':
  case 'plugins':
    console.log('  Plugins have been removed in v3.4.3. CLI terminals have their own extension systems.');
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printUsage();
    break;
  default:
    console.error(`  Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
