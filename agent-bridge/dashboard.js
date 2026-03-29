#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { upsertNeohiveMcpInToml } = require('./lib/codex-neohive-toml');
const { readIdeActivity, applyIdeActivityHint } = require('./lib/ide-activity');
const _audit = require('./lib/audit');

function findCursorProjectRootWithNeohive(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const mcpPath = path.join(dir, '.cursor', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        if (j.mcpServers && j.mcpServers.neohive) return dir;
      } catch {}
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

function normalizeNeohiveDataDirString(raw, workspaceRoot) {
  if (raw == null || typeof raw !== 'string') return null;
  let d = raw.trim();
  if (!d) return null;
  d = d.replace(/\$\{workspaceFolder\}/gi, workspaceRoot);
  return path.isAbsolute(d) ? path.resolve(d) : path.resolve(workspaceRoot, d);
}

// --- File-level mutex for serializing read-then-write operations ---
const lockMap = new Map();
function withFileLock(filePath, fn) {
  const prev = lockMap.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  lockMap.set(filePath, next.then(() => {}, () => {}));
  return next;
}

const PORT = parseInt(process.env.NEOHIVE_PORT || '3000', 10);
const SERVER_START_TIME = Date.now();
const LAN_STATE_FILE = path.join(__dirname, '.lan-mode');
let LAN_MODE = process.env.NEOHIVE_LAN === 'true' || (fs.existsSync(LAN_STATE_FILE) && fs.readFileSync(LAN_STATE_FILE, 'utf8').trim() === 'true');

const LAN_TOKEN_FILE = path.join(__dirname, '.lan-token');
let LAN_TOKEN = null;

function generateLanToken() {
  const crypto = require('crypto');
  LAN_TOKEN = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(LAN_TOKEN_FILE, LAN_TOKEN, { mode: 0o600 }); } catch {}
  return LAN_TOKEN;
}

function loadLanToken() {
  if (fs.existsSync(LAN_TOKEN_FILE)) {
    try { LAN_TOKEN = fs.readFileSync(LAN_TOKEN_FILE, 'utf8').trim(); } catch {}
  }
  if (!LAN_TOKEN) generateLanToken();
}

// Load or generate token on startup
loadLanToken();

function persistLanMode() {
  try { fs.writeFileSync(LAN_STATE_FILE, LAN_MODE ? 'true' : 'false'); } catch {}
}

function getLanIP() {
  const interfaces = os.networkInterfaces();
  let fallback = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Prefer real LAN IPs (192.168.x, 10.x, 172.16-31.x) over link-local (169.254.x)
        if (!iface.address.startsWith('169.254.')) return iface.address;
        if (!fallback) fallback = iface.address;
      }
    }
  }
  return fallback;
}

// Check if a directory has actual data files (not just an empty dir)
function hasDataFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    const files = fs.readdirSync(dir);
    return files.some(f => f.endsWith('.jsonl') || f === 'agents.json');
  } catch { return false; }
}

function countAgentsInNeohiveDir(nhDir) {
  if (!fs.existsSync(nhDir)) return 0;
  const ag = path.join(nhDir, 'agents.json');
  if (!fs.existsSync(ag)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(ag, 'utf8'));
    return j && typeof j === 'object' ? Object.keys(j).length : 0;
  } catch { return 0; }
}

function countNeohiveJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(j) ? j.length : 0;
  } catch { return 0; }
}

function neohiveHasTasksOrWorkflows(nhDir) {
  return countNeohiveJsonArray(path.join(nhDir, 'tasks.json')) > 0
    || countNeohiveJsonArray(path.join(nhDir, 'workflows.json')) > 0;
}

// Score each ancestor’s .neohive so we prefer the hive that has tasks/workflows (not the first with only agents).
function scoreNeohiveDataDir(nhDir) {
  if (!fs.existsSync(nhDir)) return -1;
  let s = countAgentsInNeohiveDir(nhDir) * 10;
  s += countNeohiveJsonArray(path.join(nhDir, 'tasks.json'));
  s += countNeohiveJsonArray(path.join(nhDir, 'workflows.json')) * 3;
  if (hasDataFiles(nhDir)) s += 5;
  return s;
}

function bestNeohiveAmongAncestors(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  let best = null;
  let bestScore = -1;
  for (let d = 0; d < 24 && dir !== root; d++) {
    const nh = path.join(dir, '.neohive');
    const sc = scoreNeohiveDataDir(nh);
    if (sc > bestScore) {
      bestScore = sc;
      best = nh;
    }
    dir = path.dirname(dir);
  }
  if (bestScore <= 0) return null;
  return best;
}

// Read NEOHIVE_DATA_DIR from project-local MCP configs (same files init writes).
// Cursor uses ${workspaceFolder} in .cursor/mcp.json — expand using projectRoot when parsing files.
function readNeohiveDataDirFromMcpConfigs(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.cursor', 'mcp.json'),
    path.join(projectRoot, '.mcp.json'),
    path.join(projectRoot, '.gemini', 'settings.json'),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const nh = j.mcpServers && j.mcpServers.neohive;
      const raw = nh && nh.env && nh.env.NEOHIVE_DATA_DIR;
      const out = normalizeNeohiveDataDirString(raw, projectRoot);
      if (out) return out;
    } catch {}
  }
  return null;
}

function resolveDashboardDefaultDataDir() {
  let envData = process.env.NEOHIVE_DATA_DIR || process.env.NEOHIVE_DATA;
  if (envData && String(envData).trim()) {
    let s = String(envData).trim();
    if (/\$\{workspaceFolder\}/i.test(s)) {
      const root = findCursorProjectRootWithNeohive(process.cwd());
      if (root) s = s.replace(/\$\{workspaceFolder\}/gi, root);
    }
    return { path: path.resolve(s), source: 'environment' };
  }
  const fromWalk = bestNeohiveAmongAncestors(process.cwd());
  if (fromWalk) {
    return { path: fromWalk, source: 'walk-up' };
  }
  let dir = path.resolve(process.cwd());
  const root = path.parse(dir).root;
  while (true) {
    const fromMcp = readNeohiveDataDirFromMcpConfigs(dir);
    if (fromMcp) {
      return { path: fromMcp, source: 'mcp-config', configAt: dir };
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return { path: path.join(process.cwd(), '.neohive'), source: 'cwd' };
}

const _defaultDataResolved = resolveDashboardDefaultDataDir();
const DEFAULT_DATA_DIR = _defaultDataResolved.path;

// Auto-migrate from .agent-bridge/ to .neohive/ (v5 → v6 rename)
const _legacyDir = path.join(path.dirname(DEFAULT_DATA_DIR), '.agent-bridge');
if (!fs.existsSync(DEFAULT_DATA_DIR) && fs.existsSync(_legacyDir)) {
  try { fs.renameSync(_legacyDir, DEFAULT_DATA_DIR); } catch {}
}

const HTML_FILE = path.join(__dirname, 'dashboard.html');
const DESIGN_SYSTEM_CSS = path.join(__dirname, 'design-system.css');
const DESIGN_SYSTEM_HTML = path.join(__dirname, 'design-system.html');
const LOGO_FILE = path.join(__dirname, 'logo.png');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');

// --- Multi-project support ---

function getProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch { return []; }
}

function saveProjects(projects) {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  } catch (e) {
    console.error('[saveProjects] Failed to write projects file:', e.message);
    throw new Error('Failed to save projects: ' + e.message);
  }
}

// Multi-project paths must be the repo root, not .../project/.neohive (otherwise we join .neohive twice).
function normalizeMonitoredProjectRoot(projectPath) {
  if (!projectPath) return projectPath;
  const p = path.resolve(projectPath);
  if (path.basename(p) === '.neohive') {
    return path.dirname(p);
  }
  return p;
}

// Resolve data dir: explicit project path > env var > cwd > legacy fallback
// Prefers directories with actual data files over empty ones
function resolveDataDir(projectPath) {
  if (projectPath) {
    projectPath = normalizeMonitoredProjectRoot(projectPath);
    let dir = path.join(projectPath, '.neohive');
    const dataDir = path.join(projectPath, 'data');
    // Prefer whichever has data (local hive only — do not redirect agents/messages to parent)
    if (hasDataFiles(dir)) return dir;
    if (hasDataFiles(dataDir)) return dataDir;
    if (fs.existsSync(dir)) return dir;
    if (fs.existsSync(dataDir)) return dataDir;
    return dir;
  }
  const legacyDir = path.join(__dirname, 'data');
  // Prefer dir with actual data files
  if (hasDataFiles(DEFAULT_DATA_DIR)) return DEFAULT_DATA_DIR;
  if (hasDataFiles(legacyDir)) return legacyDir;
  if (fs.existsSync(DEFAULT_DATA_DIR)) return DEFAULT_DATA_DIR;
  if (fs.existsSync(legacyDir)) return legacyDir;
  return DEFAULT_DATA_DIR;
}

// Monorepo: tasks/workflows may live in parent .neohive while agents.json stays in the subfolder.
// Using parent for *all* files hid agents (empty parent agents.json). Only tasks + workflows use this.
function resolveTasksWorkflowsDataDir(projectPath) {
  if (!projectPath) return resolveDataDir(null);
  projectPath = normalizeMonitoredProjectRoot(projectPath);
  const localHive = path.join(projectPath, '.neohive');
  const parentHive = path.join(path.dirname(projectPath), '.neohive');
  if (!neohiveHasTasksOrWorkflows(localHive) && neohiveHasTasksOrWorkflows(parentHive)) {
    return parentHive;
  }
  return resolveDataDir(projectPath);
}

function filePath(name, projectPath) {
  const dir = (name === 'tasks.json' || name === 'workflows.json')
    ? resolveTasksWorkflowsDataDir(projectPath)
    : resolveDataDir(projectPath);
  return path.join(dir, name);
}

// Validate project path is registered or is the default
function validateProjectPath(projectPath) {
  if (!projectPath) return true;
  const absPath = normalizeMonitoredProjectRoot(path.resolve(projectPath));
  const projects = getProjects();
  const cwd = path.resolve(process.cwd());
  const scriptDir = path.resolve(__dirname);
  if (absPath === cwd || absPath === scriptDir) return true;
  return projects.some(p => normalizeMonitoredProjectRoot(path.resolve(p.path)) === absPath);
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Shared helpers ---

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8').trim();
  if (!content) return [];
  return content.split(/\r?\n/).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function isPidAlive(pid, lastActivity) {
  const STALE_THRESHOLD = 30000; // 30s — 3x heartbeat interval, catches dead agents faster

  // PRIORITY 1: Trust heartbeat freshness over PID status
  // Heartbeats are written by the actual running process — if fresh, agent is alive
  // regardless of whether process.kill can see the PID
  if (lastActivity) {
    const stale = Date.now() - new Date(lastActivity).getTime();
    if (stale < STALE_THRESHOLD) return true;
  }

  // PRIORITY 2: If heartbeat is stale, check PID as fallback
  try {
    process.kill(pid, 0);
    return true; // PID exists — alive even with stale heartbeat
  } catch {
    return false; // PID dead AND heartbeat stale — truly dead
  }
}

// --- Default avatar helpers ---
const BUILT_IN_AVATARS = [
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23f59e0b'/%3E%3Ccircle cx='22' cy='26' r='4' fill='%23fff'/%3E%3Ccircle cx='42' cy='26' r='4' fill='%23fff'/%3E%3Crect x='20' y='38' width='24' height='4' rx='2' fill='%23fff'/%3E%3Crect x='14' y='12' width='6' height='10' rx='3' fill='%23f59e0b' stroke='%23fff' stroke-width='1.5'/%3E%3Crect x='44' y='12' width='6' height='10' rx='3' fill='%23f59e0b' stroke='%23fff' stroke-width='1.5'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%233fb950'/%3E%3Ccircle cx='22' cy='26' r='5' fill='%23fff'/%3E%3Ccircle cx='42' cy='26' r='5' fill='%23fff'/%3E%3Ccircle cx='22' cy='26' r='2' fill='%23333'/%3E%3Ccircle cx='42' cy='26' r='2' fill='%23333'/%3E%3Cpath d='M20 38 Q32 46 44 38' stroke='%23fff' fill='none' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23d29922'/%3E%3Crect x='16' y='22' width='12' height='8' rx='2' fill='%23fff'/%3E%3Crect x='36' y='22' width='12' height='8' rx='2' fill='%23fff'/%3E%3Ccircle cx='22' cy='26' r='2' fill='%23333'/%3E%3Ccircle cx='42' cy='26' r='2' fill='%23333'/%3E%3Cpath d='M24 40 H40' stroke='%23fff' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23f85149'/%3E%3Ccircle cx='22' cy='26' r='4' fill='%23fff'/%3E%3Ccircle cx='42' cy='26' r='4' fill='%23fff'/%3E%3Ccircle cx='22' cy='26' r='2' fill='%23333'/%3E%3Ccircle cx='42' cy='26' r='2' fill='%23333'/%3E%3Cpath d='M22 40 Q32 34 42 40' stroke='%23fff' fill='none' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23fb923c'/%3E%3Ccircle cx='22' cy='28' r='4' fill='%23fff'/%3E%3Ccircle cx='42' cy='28' r='4' fill='%23fff'/%3E%3Cpath d='M16 18 L22 24' stroke='%23fff' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M48 18 L42 24' stroke='%23fff' stroke-width='2' stroke-linecap='round'/%3E%3Cellipse cx='32' cy='42' rx='8' ry='4' fill='%23fff'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23f778ba'/%3E%3Ccircle cx='24' cy='26' r='6' fill='%23fff'/%3E%3Ccircle cx='40' cy='26' r='6' fill='%23fff'/%3E%3Ccircle cx='24' cy='26' r='3' fill='%23333'/%3E%3Ccircle cx='40' cy='26' r='3' fill='%23333'/%3E%3Cpath d='M26 40 Q32 46 38 40' stroke='%23fff' fill='none' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23fbbf24'/%3E%3Crect x='17' y='23' width='10' height='6' rx='3' fill='%23fff'/%3E%3Crect x='37' y='23' width='10' height='6' rx='3' fill='%23fff'/%3E%3Cpath d='M22 38 L32 44 L42 38' stroke='%23fff' fill='none' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%237ee787'/%3E%3Ccircle cx='22' cy='26' r='4' fill='%23fff'/%3E%3Ccircle cx='42' cy='26' r='4' fill='%23fff'/%3E%3Ccircle cx='23' cy='25' r='2' fill='%23333'/%3E%3Ccircle cx='43' cy='25' r='2' fill='%23333'/%3E%3Cpath d='M20 38 Q32 48 44 38' stroke='%23fff' fill='none' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23e3b341'/%3E%3Cpath d='M18 22 L26 30 L18 30Z' fill='%23fff'/%3E%3Cpath d='M46 22 L38 30 L46 30Z' fill='%23fff'/%3E%3Crect x='24' y='38' width='16' height='6' rx='3' fill='%23fff'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23ffa198'/%3E%3Ccircle cx='22' cy='26' r='5' fill='%23fff'/%3E%3Ccircle cx='42' cy='26' r='5' fill='%23fff'/%3E%3Ccircle cx='22' cy='27' r='2.5' fill='%23333'/%3E%3Ccircle cx='42' cy='27' r='2.5' fill='%23333'/%3E%3Cellipse cx='32' cy='42' rx='6' ry='3' fill='%23fff'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23d97706'/%3E%3Crect x='16' y='20' width='14' height='10' rx='2' fill='%23fff'/%3E%3Crect x='34' y='20' width='14' height='10' rx='2' fill='%23fff'/%3E%3Ccircle cx='23' cy='25' r='2' fill='%23d97706'/%3E%3Ccircle cx='41' cy='25' r='2' fill='%23d97706'/%3E%3Crect x='26' y='38' width='12' height='4' rx='2' fill='%23fff'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='32' fill='%23b45309'/%3E%3Ccircle cx='24' cy='24' r='5' fill='%23fff'/%3E%3Ccircle cx='40' cy='24' r='5' fill='%23fff'/%3E%3Ccircle cx='24' cy='24' r='2' fill='%23b45309'/%3E%3Ccircle cx='40' cy='24' r='2' fill='%23b45309'/%3E%3Cpath d='M20 38 Q32 50 44 38' stroke='%23fff' fill='none' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='32' cy='10' r='4' fill='%23fff'/%3E%3C/svg%3E",
];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getDefaultAvatar(name) {
  return BUILT_IN_AVATARS[hashName(name) % BUILT_IN_AVATARS.length];
}

// --- API handlers ---

function apiHistory(query) {
  const projectPath = query.get('project') || null;
  const branch = query.get('branch') || null;
  if (branch && !/^[a-zA-Z0-9_-]{1,64}$/.test(branch)) {
    return { error: 'Invalid branch name' };
  }
  const histFile = branch && branch !== 'main'
    ? filePath(`branch-${branch}-history.jsonl`, projectPath)
    : filePath('history.jsonl', projectPath);
  let history = readJsonl(histFile);

  // Merge channel-specific history files
  const dataDir = resolveDataDir(projectPath);
  try {
    const files = fs.readdirSync(dataDir);
    for (const f of files) {
      if (f.startsWith('channel-') && f.endsWith('-history.jsonl') && f !== 'channel-general-history.jsonl') {
        const channelHistory = readJsonl(path.join(dataDir, f));
        history = history.concat(channelHistory);
      }
    }
  } catch {}
  // Sort merged messages by timestamp
  history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const acks = readJson(filePath('acks.json', projectPath));
  const limit = Math.min(parseInt(query.get('limit') || '500', 10), 1000);
  const page = parseInt(query.get('page') || '0', 10);
  const threadId = query.get('thread_id');

  let messages = history;
  if (threadId) {
    messages = messages.filter(m => m.thread_id === threadId || m.id === threadId);
  }

  // Scale fix: pagination support for large histories
  const total = messages.length;
  if (page > 0) {
    // Page-based: page 1 = most recent, page 2 = older, etc.
    const start = Math.max(0, total - (page * limit));
    const end = Math.max(0, total - ((page - 1) * limit));
    messages = messages.slice(start, end);
  } else {
    // Default: last N messages (backward compatible)
    messages = messages.slice(-limit);
  }

  messages.forEach(m => { m.acked = !!acks[m.id]; });
  // Include pagination metadata when page is requested
  if (page > 0) {
    return { messages, total, page, limit, pages: Math.ceil(total / limit) };
  }
  return messages;
}

function apiChannels(query) {
  const projectPath = query.get('project') || null;
  const channelsFile = filePath('channels.json', projectPath);
  const channels = readJson(channelsFile);
  if (!channels) return { general: { description: 'General channel', members: ['*'], message_count: 0 } };
  const dataDir = resolveDataDir(projectPath);
  const result = {};
  for (const [name, ch] of Object.entries(channels)) {
    let msgCount = 0;
    const msgFile = name === 'general'
      ? filePath('history.jsonl', projectPath)
      : path.join(dataDir, 'channel-' + name + '-history.jsonl');
    try {
      if (fs.existsSync(msgFile)) {
        const content = fs.readFileSync(msgFile, 'utf8').trim();
        if (content) msgCount = content.split(/\r?\n/).filter(l => l.trim()).length;
      }
    } catch {}
    result[name] = { description: ch.description || '', members: ch.members, message_count: msgCount };
  }
  return result;
}

function apiAgents(query) {
  const projectPath = query.get('project') || null;
  const agents = readJson(filePath('agents.json', projectPath));
  const profiles = readJson(filePath('profiles.json', projectPath));
  const cards = readJson(filePath('agent-cards.json', projectPath));
  const history = readJsonl(filePath('history.jsonl', projectPath));

  const dataDir = resolveDataDir(projectPath);
  try {
    const hbFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('heartbeat-') && f.endsWith('.json'));
    for (const f of hbFiles) {
      const name = f.slice(10, -5);
      if (agents[name]) {
        try {
          const hb = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
          if (hb.last_activity) agents[name].last_activity = hb.last_activity;
          if (hb.pid) agents[name].pid = hb.pid;
          if (hb.ppid) agents[name].ppid = hb.ppid;
        } catch {}
      }
    }
  } catch {}

  const result = {};

  // Build last message timestamp per agent from history
  const lastMessageTime = {};
  for (const m of history) {
    lastMessageTime[m.from] = m.timestamp;
  }

  for (const [name, info] of Object.entries(agents)) {
    const alive = isPidAlive(info.pid, info.last_activity);
    const lastActivity = info.last_activity || info.timestamp;
    const idleSeconds = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 1000);
    const hasHeartbeat = fs.existsSync(path.join(resolveDataDir(projectPath), `heartbeat-${name}.json`));
    const profile = profiles[name] || {};
    const isLocal = (() => { try { process.kill(info.pid, 0); return true; } catch { return false; } })();

    let status;
    if (alive) {
      if (info.listening_since) {
        status = 'listening';
      } else {
        // Detect stuck/unresponsive: agent is alive but hasn't called listen() recently
        const lastListened = info.last_listened_at;
        const sinceLastListen = lastListened ? Math.floor((Date.now() - new Date(lastListened).getTime()) / 1000) : Infinity;
        if (sinceLastListen > 600) {
          status = 'stuck'; // > 10 minutes without listen() call
        } else if (sinceLastListen > 120) {
          status = 'unresponsive'; // > 2 minutes without listen() call
        } else if (idleSeconds > 30) {
          status = 'idle';
        } else {
          status = 'working';
        }
      }
    } else if (!hasHeartbeat) {
      status = 'unknown';
    } else if (idleSeconds <= 120) {
      status = 'stale';
    } else {
      status = 'offline';
    }

    result[name] = {
      pid: info.pid,
      ppid: info.ppid || null,
      alive,
      registered_at: info.timestamp,
      last_activity: lastActivity,
      last_message: lastMessageTime[name] || null,
      idle_seconds: alive ? idleSeconds : null,
      last_listened_at: info.last_listened_at || null,
      status,
      listening_since: info.listening_since || null,
      is_listening: !!(info.listening_since && alive),
      provider: info.provider || 'unknown',
      branch: info.branch || 'main',
      display_name: profile.display_name || name,
      avatar: profile.avatar || getDefaultAvatar(name),
      role: profile.role || '',
      bio: profile.bio || '',
      appearance: profile.appearance || {},
      hostname: info.hostname || null,
      is_remote: !isLocal && alive,
      platform_skills: (cards && cards[name] && cards[name].platform_skills) || [],
      skills: (cards && cards[name] && cards[name].skills) || [],
    };
    // Include workspace status for agent intent board
    try {
      const wsPath = path.join(resolveDataDir(projectPath), 'workspaces', name + '.json');
      if (fs.existsSync(wsPath)) {
        const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
        if (ws._status) result[name].current_status = ws._status;
      }
    } catch {}

    const dataDir = resolveDataDir(projectPath);
    const ide = readIdeActivity(dataDir, name);
    if (ide) applyIdeActivityHint(result[name], ide, { dataDir, agentName: name });
  }
  return result;
}

function apiStatus(query) {
  const projectPath = query.get('project') || null;
  const history = readJsonl(filePath('history.jsonl', projectPath));
  const agents = readJson(filePath('agents.json', projectPath));
  const threads = new Set();
  history.forEach(m => { if (m.thread_id) threads.add(m.thread_id); });

  const agentEntries = Object.entries(agents);
  const aliveCount = agentEntries.filter(([, a]) => isPidAlive(a.pid, a.last_activity)).length;
  const sleepingCount = agentEntries.filter(([, a]) => {
    if (!isPidAlive(a.pid, a.last_activity)) return false;
    const lastActivity = a.last_activity || a.timestamp;
    const idleSeconds = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 1000);
    return idleSeconds > 30;
  }).length;

  // Include managed mode status if active
  const config = readJson(filePath('config.json', projectPath));
  const result = {
    messageCount: history.length,
    agentCount: agentEntries.length,
    aliveCount,
    sleepingCount,
    threadCount: threads.size,
    conversation_mode: config.conversation_mode || 'direct',
    coordinator_mode: config.coordinator_mode || 'responsive',
  };

  if (config.conversation_mode === 'managed' && config.managed) {
    result.managed = {
      manager: config.managed.manager,
      phase: config.managed.phase,
      floor: config.managed.floor,
      turn_current: config.managed.turn_current,
    };
  }

  return result;
}

function apiStats(query) {
  const projectPath = query.get('project') || null;
  const history = readJsonl(filePath('history.jsonl', projectPath));
  const agents = readJson(filePath('agents.json', projectPath));

  // Per-agent stats — only count messages from agents still in agents.json
  const perAgent = {};
  const knownAgentNames = new Set(Object.keys(agents));
  knownAgentNames.add('__system__');
  knownAgentNames.add('Dashboard');
  let totalMessages = 0;
  const hourBuckets = new Array(24).fill(0);

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const from = m.from || 'unknown';
    if (!knownAgentNames.has(from)) continue; // skip removed agents
    if (!perAgent[from]) {
      perAgent[from] = { messages: 0, responseTimes: [], hours: new Array(24).fill(0) };
    }
    totalMessages++;
    perAgent[from].messages++;
    const ts = new Date(m.timestamp);
    const hour = ts.getHours();
    perAgent[from].hours[hour]++;
    hourBuckets[hour]++;

    // Compute response time if this is a reply
    if (m.reply_to) {
      for (let j = i - 1; j >= Math.max(0, i - 50); j--) {
        if (history[j].id === m.reply_to) {
          const delta = ts.getTime() - new Date(history[j].timestamp).getTime();
          if (delta > 0 && delta < 3600000) perAgent[from].responseTimes.push(delta);
          break;
        }
      }
    }
  }

  // Build per-agent summary — only include agents currently in agents.json
  const agentStats = {};
  let busiestAgent = null;
  let busiestCount = 0;
  for (const [name, data] of Object.entries(perAgent)) {
    const avgResponseMs = data.responseTimes.length
      ? Math.round(data.responseTimes.reduce((a, b) => a + b, 0) / data.responseTimes.length)
      : null;
    const peakHour = data.hours.indexOf(Math.max(...data.hours));
    agentStats[name] = {
      messages: data.messages,
      avg_response_ms: avgResponseMs,
      peak_hour: peakHour,
    };
    if (data.messages > busiestCount) {
      busiestCount = data.messages;
      busiestAgent = name;
    }
  }

  // Conversation velocity (messages per minute over last 10 minutes)
  const tenMinAgo = Date.now() - 600000;
  const recentCount = history.filter(m => new Date(m.timestamp).getTime() > tenMinAgo).length;
  const velocity = Math.round((recentCount / 10) * 10) / 10;

  return {
    total_messages: totalMessages,
    busiest_agent: busiestAgent,
    velocity_per_min: velocity,
    hour_distribution: hourBuckets,
    agents: agentStats,
  };
}

// --- v3.4: Notification Tracking ---
let notificationHistory = [];
let prevAgentState = {};

function generateNotifications(currentAgents) {
  const crypto = require('crypto');
  const now = new Date().toISOString();

  for (const [name, agent] of Object.entries(currentAgents)) {
    const prev = prevAgentState[name];
    const isAlive = agent.pid ? isPidAlive(agent.pid, agent.last_activity) : false;
    const isListening = !!agent.listening;

    if (prev) {
      if (!prev.alive && isAlive) {
        notificationHistory.push({ id: crypto.randomBytes(8).toString('hex'), type: 'agent_online', agent: name, message: `${name} came online`, timestamp: now });
      }
      if (prev.alive && !isAlive) {
        notificationHistory.push({ id: crypto.randomBytes(8).toString('hex'), type: 'agent_offline', agent: name, message: `${name} went offline`, timestamp: now });
      }
      if (!prev.listening && isListening) {
        notificationHistory.push({ id: crypto.randomBytes(8).toString('hex'), type: 'agent_listening', agent: name, message: `${name} started listening`, timestamp: now });
      }
      if (prev.listening && !isListening) {
        notificationHistory.push({ id: crypto.randomBytes(8).toString('hex'), type: 'agent_busy', agent: name, message: `${name} stopped listening`, timestamp: now });
      }
    } else if (isAlive) {
      notificationHistory.push({ id: crypto.randomBytes(8).toString('hex'), type: 'agent_online', agent: name, message: `${name} came online`, timestamp: now });
    }

    prevAgentState[name] = { alive: isAlive, listening: isListening };
  }

  // Trim to max 50
  if (notificationHistory.length > 50) {
    notificationHistory = notificationHistory.slice(-50);
  }
}

// --- Token Usage Tracking ---

// Walk the process tree upward from startPid, returning the first PID
// that has a session file in sessionsDir. At each level also checks
// sibling processes (children of the same parent) to handle the VS Code
// MCP topology where the claude binary and MCP server share a parent.
function findSessionPidInTree(startPid, sessionsDir, maxDepth = 5) {
  const { execSync } = require('child_process');
  const getParent = (pid) => {
    try {
      const s = execSync(`ps -o ppid= -p ${pid} 2>/dev/null`, { timeout: 1000 }).toString().trim();
      const n = parseInt(s, 10);
      return (n && n !== pid) ? n : null;
    } catch { return null; }
  };
  const getSiblings = (parentPid) => {
    try {
      return execSync(`pgrep -P ${parentPid} 2>/dev/null`, { timeout: 1000 })
        .toString().trim().split('\n').map(s => parseInt(s, 10)).filter(Boolean);
    } catch { return []; }
  };

  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    if (!pid || pid <= 1) break;
    // Check this pid directly
    if (fs.existsSync(path.join(sessionsDir, pid + '.json'))) return pid;
    const parent = getParent(pid);
    if (!parent) break;
    // Check siblings (handles VS Code: MCP server and claude binary share same parent)
    for (const sibling of getSiblings(parent)) {
      if (sibling === pid) continue;
      if (fs.existsSync(path.join(sessionsDir, sibling + '.json'))) return sibling;
    }
    pid = parent;
  }
  return null;
}

// Pricing per 1M tokens (USD)
const TOKEN_PRICING = {
  'claude-opus-4-6': { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cache_write: 3.75, cache_read: 0.30 },
  'claude-haiku-4-5': { input: 0.80, output: 4.00, cache_write: 1.00, cache_read: 0.08 },
};

function parseSessionUsage(sessionFile, maxBytes) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, messages: 0, model: null };
  try {
    const stat = fs.statSync(sessionFile);
    // For huge files, only read the last portion to avoid memory issues
    const readSize = Math.min(stat.size, maxBytes || 5 * 1024 * 1024); // 5MB max
    const fd = fs.openSync(sessionFile, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const content = buf.toString('utf8');
    // Find complete lines (skip partial first line if we started mid-file)
    const lines = content.split('\n');
    if (stat.size > readSize) lines.shift(); // skip potentially partial first line
    for (const line of lines) {
      if (!line.trim() || !line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && entry.message && entry.message.usage) {
          const u = entry.message.usage;
          usage.input_tokens += u.input_tokens || 0;
          usage.output_tokens += u.output_tokens || 0;
          usage.cache_creation_tokens += u.cache_creation_input_tokens || 0;
          usage.cache_read_tokens += u.cache_read_input_tokens || 0;
          usage.messages++;
          if (entry.message.model) usage.model = entry.message.model;
        }
      } catch { /* skip unparseable lines */ }
    }
  } catch (e) { /* session file unreadable */ }
  return usage;
}

/**
 * Score all .jsonl session files in the project dir by birthtime proximity to
 * an agent's started_at. Returns sorted array of { file, delta } (ascending).
 */
function scoreSessionsByProximity(projectSessionDir, agentStartedAt) {
  if (!agentStartedAt || !fs.existsSync(projectSessionDir)) return [];
  const agentTs = new Date(agentStartedAt).getTime();
  if (isNaN(agentTs)) return [];

  const scored = [];
  try {
    const files = fs.readdirSync(projectSessionDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const fp = path.join(projectSessionDir, f);
      try {
        const stat = fs.statSync(fp);
        scored.push({ file: fp, delta: Math.abs(stat.birthtimeMs - agentTs) });
      } catch { /* skip unreadable */ }
    }
  } catch { return []; }
  scored.sort((a, b) => a.delta - b.delta);
  return scored;
}

function apiTokenUsage(query) {
  const projectPath = query.get('project') || null;
  const dataDir = resolveDataDir(projectPath);
  const agents = readJson(filePath('agents.json', projectPath));
  const home = os.homedir();
  const sessionsDir = path.join(home, '.claude', 'sessions');
  const projectAbsPath = projectPath ? path.resolve(projectPath) : path.resolve(process.cwd());
  const projectSlug = projectAbsPath.replace(/\//g, '-');
  const projectSessionDir = path.join(home, '.claude', 'projects', projectSlug);

  const result = { agents: {}, total_cost_usd: 0, total_tokens: 0 };

  const agentSessions = {};
  const claimedFiles = new Set();

  for (const [name, info] of Object.entries(agents)) {
    if (!info.pid) continue;
    try {
      // Priority 0: direct session ID from env var (written to agents.json + heartbeat)
      const sessionId = info.claude_session_id || (() => {
        try {
          const hb = JSON.parse(fs.readFileSync(path.join(dataDir, `heartbeat-${name}.json`), 'utf8'));
          return hb.claude_session_id || null;
        } catch { return null; }
      })();
      if (sessionId) {
        const candidate = path.join(projectSessionDir, sessionId + '.jsonl');
        if (fs.existsSync(candidate)) {
          agentSessions[name] = candidate;
          claimedFiles.add(candidate);
          continue;
        }
      }

      // Priority 1: process-tree lookup
      const cliPid = findSessionPidInTree(info.pid, sessionsDir) ||
                     (info.ppid ? findSessionPidInTree(info.ppid, sessionsDir) : null);
      if (cliPid) {
        const pidFile = path.join(sessionsDir, cliPid + '.json');
        const session = readJson(pidFile);
        if (session && session.sessionId) {
          const candidate = path.join(projectSessionDir, session.sessionId + '.jsonl');
          if (fs.existsSync(candidate)) {
            agentSessions[name] = candidate;
            claimedFiles.add(candidate);
          }
        }
      }
    } catch { /* skip */ }
  }

  // Phase 2: fallback — greedy assignment by birthtime proximity (closest-first wins)
  const needFallback = Object.entries(agents)
    .filter(([name, info]) => info.pid && !agentSessions[name])
    .map(([name, info]) => {
      const scored = scoreSessionsByProximity(projectSessionDir, info.started_at || info.timestamp);
      return { name, scored };
    })
    .sort((a, b) => {
      const aMin = a.scored.length ? a.scored[0].delta : Infinity;
      const bMin = b.scored.length ? b.scored[0].delta : Infinity;
      return aMin - bMin;
    });

  for (const { name, scored } of needFallback) {
    for (const { file } of scored) {
      if (!claimedFiles.has(file)) {
        agentSessions[name] = file;
        claimedFiles.add(file);
        break;
      }
    }
  }

  // Phase 3: compute usage + cost
  for (const [name, sessionFile] of Object.entries(agentSessions)) {
    try {
      const info = agents[name];
      const usage = parseSessionUsage(sessionFile);
      const pricing = TOKEN_PRICING[usage.model] || TOKEN_PRICING['claude-opus-4-6'];
      const cost = (usage.input_tokens * pricing.input + usage.output_tokens * pricing.output + usage.cache_creation_tokens * pricing.cache_write + usage.cache_read_tokens * pricing.cache_read) / 1000000;

      result.agents[name] = {
        model: usage.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_tokens: usage.cache_creation_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens + usage.cache_creation_tokens + usage.cache_read_tokens,
        estimated_cost_usd: Math.round(cost * 100) / 100,
        messages: usage.messages,
        pid: info.pid,
      };
      result.total_cost_usd += cost;
      result.total_tokens += result.agents[name].total_tokens;
    } catch { /* skip */ }
  }
  result.total_cost_usd = Math.round(result.total_cost_usd * 100) / 100;
  return result;
}

function apiNotifications() {
  return notificationHistory;
}

// --- v3.4: Performance Scoring ---
function apiScores(query) {
  const projectPath = query.get('project') || null;
  const history = readJsonl(filePath('history.jsonl', projectPath));
  const agents = readJson(filePath('agents.json', projectPath));

  const perAgent = {};
  const totalMessages = history.length;
  const allAgentNames = new Set();

  // Gather per-agent data
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const from = m.from || 'unknown';
    allAgentNames.add(from);
    if (m.to) allAgentNames.add(m.to);
    if (!perAgent[from]) perAgent[from] = { messages: 0, responseTimes: [], peers: new Set() };
    perAgent[from].messages++;
    if (m.to) perAgent[from].peers.add(m.to);

    if (m.reply_to) {
      for (let j = i - 1; j >= Math.max(0, i - 50); j--) {
        if (history[j].id === m.reply_to) {
          const delta = new Date(m.timestamp).getTime() - new Date(history[j].timestamp).getTime();
          if (delta > 0 && delta < 3600000) perAgent[from].responseTimes.push(delta / 1000);
          break;
        }
      }
    }
  }

  const totalAgents = allAgentNames.size;
  const maxMessages = Math.max(1, ...Object.values(perAgent).map(d => d.messages));

  const result = {};
  const scores = [];

  for (const [name, data] of Object.entries(perAgent)) {
    const avgResponseSec = data.responseTimes.length
      ? data.responseTimes.reduce((a, b) => a + b, 0) / data.responseTimes.length
      : Infinity;

    // Responsiveness (30 pts)
    let responsiveness;
    if (avgResponseSec < 10) responsiveness = 30;
    else if (avgResponseSec < 30) responsiveness = 25;
    else if (avgResponseSec < 60) responsiveness = 20;
    else if (avgResponseSec < 120) responsiveness = 15;
    else responsiveness = 10;

    // Activity (30 pts) — linear scale relative to top agent
    const activity = Math.round((data.messages / maxMessages) * 30);

    // Reliability (20 pts) — uptime based on agent registration
    let reliability = 10;
    const agentInfo = agents[name];
    if (agentInfo) {
      const isAlive = agentInfo.pid ? isPidAlive(agentInfo.pid, agentInfo.last_activity) : false;
      const registered = new Date(agentInfo.registered_at || agentInfo.last_activity).getTime();
      const totalTime = Date.now() - registered;
      if (totalTime > 0 && isAlive) {
        const lastAct = new Date(agentInfo.last_activity).getTime();
        const activeTime = lastAct - registered;
        const uptime = Math.min(1, activeTime / totalTime);
        if (uptime > 0.95) reliability = 20;
        else if (uptime > 0.80) reliability = 15;
        else if (uptime > 0.50) reliability = 10;
        else reliability = 5;
      } else if (!isAlive) {
        reliability = 5;
      }
    }

    // Collaboration (20 pts)
    const collaboration = totalAgents > 1
      ? Math.round((data.peers.size / (totalAgents - 1)) * 20)
      : 20;

    const score = responsiveness + activity + reliability + collaboration;
    result[name] = { score, responsiveness, activity, reliability, collaboration };
    scores.push({ name, score });
  }

  // Add ranks
  scores.sort((a, b) => b.score - a.score);
  scores.forEach((s, i) => { result[s.name].rank = i + 1; });

  return { agents: result };
}

// --- v3.4: Cross-Project Search ---
function apiSearchAll(query) {
  const q = (query.get('q') || '').toLowerCase();
  const limit = Math.min(parseInt(query.get('limit') || '50', 10), 200);
  if (!q) return { error: 'Missing "q" parameter' };

  const projects = getProjects();
  // Add default project
  const allProjects = [{ name: path.basename(process.cwd()), path: null }];
  for (const p of projects) allProjects.push(p);

  const results = [];
  let total = 0;

  for (const proj of allProjects) {
    if (proj.path && !validateProjectPath(proj.path)) continue;
    const history = readJsonl(filePath('history.jsonl', proj.path));
    const matches = [];
    for (const m of history) {
      if (matches.length >= limit) break;
      const content = (m.content || '').toLowerCase();
      const from = (m.from || '').toLowerCase();
      const to = (m.to || '').toLowerCase();
      if (content.includes(q) || from.includes(q) || to.includes(q)) {
        matches.push({ id: m.id, from: m.from, to: m.to, content: m.content, timestamp: m.timestamp });
      }
    }
    if (matches.length > 0) {
      results.push({ project: proj.name, path: proj.path || process.cwd(), messages: matches });
      total += matches.length;
    }
  }

  return { results, total };
}

// --- v3.4: Replay Export ---
function apiExportReplay(query) {
  const projectPath = query.get('project') || null;
  const history = readJsonl(filePath('history.jsonl', projectPath));
  const profiles = readJson(filePath('profiles.json', projectPath));

  const colors = ['#f59e0b','#f97316','#3fb950','#d29922','#f778ba','#7ee787','#e3b341','#14b8a6'];
  const agentColors = {};
  let colorIdx = 0;
  for (const m of history) {
    if (!agentColors[m.from]) agentColors[m.from] = colors[colorIdx++ % colors.length];
  }

  const messagesJson = JSON.stringify(history.map(m => ({
    from: m.from, to: m.to, content: m.content, timestamp: m.timestamp, color: agentColors[m.from] || '#f59e0b'
  })));

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Neohive — Replay</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--surface-2:#21262d;--border:#30363d;--text:#e6edf3;--dim:#8b949e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;justify-content:space-between}
.title{font-size:16px;font-weight:700;color:var(--text)}
.controls{display:flex;gap:8px;align-items:center}
.controls button{background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px}
.controls button:hover{background:var(--border)}
.controls select{background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:13px}
.messages{max-width:800px;margin:20px auto;padding:0 16px}
.msg{opacity:0;transform:translateY(8px);transition:opacity 0.3s,transform 0.3s;margin-bottom:12px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px}
.msg.visible{opacity:1;transform:translateY(0)}
.msg-header{display:flex;gap:8px;align-items:baseline;margin-bottom:4px;font-size:13px}
.msg-from{font-weight:700}
.msg-to{color:var(--dim)}
.msg-time{color:var(--dim);margin-left:auto;font-size:11px}
.msg-content{font-size:14px;white-space:pre-wrap;word-break:break-word}
.msg-content code{background:var(--surface-2);padding:1px 5px;border-radius:3px;font-size:0.9em}
.msg-content strong{font-weight:700}
.progress{font-size:12px;color:var(--dim)}
</style></head><body>
<div class="header">
<span class="title">Neohive — Replay</span>
<div class="controls">
<button id="btn" onclick="toggle()">Pause</button>
<label><span style="color:var(--dim);font-size:12px">Speed:</span>
<select id="speed" onchange="setSpeed(this.value)">
<option value="2000">Slow</option><option value="1000" selected>Normal</option><option value="500">Fast</option><option value="200">Very Fast</option>
</select></label>
<span class="progress" id="progress">0 / 0</span>
</div></div>
<div class="messages" id="messages"></div>
<script>
var msgs=${messagesJson.replace(/<\//g, '<\\/')};
var idx=0,playing=true,timer=null,speed=1000;
function md(s){return s.replace(/\`\`\`[\\s\\S]*?\`\`\`/g,function(m){return '<pre><code>'+m.slice(3,-3).replace(/^\\w*\\n/,'')+'</code></pre>'}).replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/^### (.+)$/gm,'<h4 style="margin:8px 0 4px;font-size:14px">$1</h4>').replace(/^## (.+)$/gm,'<h3 style="margin:8px 0 4px;font-size:15px">$1</h3>').replace(/^# (.+)$/gm,'<h2 style="margin:8px 0 4px;font-size:16px">$1</h2>')}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function showNext(){if(idx>=msgs.length){playing=false;document.getElementById('btn').textContent='Done';return}
var m=msgs[idx],el=document.createElement('div');el.className='msg';
var t=new Date(m.timestamp);var time=t.toLocaleTimeString();
el.innerHTML='<div class="msg-header"><span class="msg-from" style="color:'+m.color+'">'+esc(m.from)+'</span><span class="msg-to">→ '+esc(m.to||'all')+'</span><span class="msg-time">'+time+'</span></div><div class="msg-content">'+md(esc(m.content))+'</div>';
document.getElementById('messages').appendChild(el);
requestAnimationFrame(function(){el.classList.add('visible')});
el.scrollIntoView({behavior:'smooth',block:'end'});
idx++;document.getElementById('progress').textContent=idx+' / '+msgs.length;
if(playing)timer=setTimeout(showNext,speed)}
function toggle(){if(idx>=msgs.length){idx=0;document.getElementById('messages').innerHTML='';playing=true;document.getElementById('btn').textContent='Pause';showNext();return}
playing=!playing;document.getElementById('btn').textContent=playing?'Pause':'Play';if(playing)showNext();else clearTimeout(timer)}
function setSpeed(v){speed=parseInt(v)}
showNext();
</script></body></html>`;
}

function apiReset(query) {
  const projectPath = query.get('project') || null;
  const dataDir = resolveDataDir(projectPath);
  const fixedFiles = ['messages.jsonl', 'history.jsonl', 'agents.json', 'acks.json', 'tasks.json', 'profiles.json', 'workflows.json', 'branches.json', 'read_receipts.json', 'permissions.json', 'config.json'];
  for (const f of fixedFiles) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith('consumed-') && f.endsWith('.json')) {
        fs.unlinkSync(path.join(dataDir, f));
      }
      if (f.startsWith('branch-') && (f.endsWith('-messages.jsonl') || f.endsWith('-history.jsonl'))) {
        fs.unlinkSync(path.join(dataDir, f));
      }
    }
  }
  // Remove workspaces dir
  const wsDir = path.join(dataDir, 'workspaces');
  if (fs.existsSync(wsDir)) {
    for (const f of fs.readdirSync(wsDir)) fs.unlinkSync(path.join(wsDir, f));
    try { fs.rmdirSync(wsDir); } catch {}
  }
  return { success: true };
}

function apiClearMessages(query) {
  const projectPath = query.get('project') || null;
  const dataDir = resolveDataDir(projectPath);
  for (const f of ['messages.jsonl', 'history.jsonl']) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith('consumed-') && f.endsWith('.json')) {
        fs.unlinkSync(path.join(dataDir, f));
      }
    }
  }
  return { success: true };
}

function apiNewConversation(query) {
  const projectPath = query.get('project') || null;
  const dataDir = resolveDataDir(projectPath);
  const convDir = path.join(dataDir, 'conversations');
  if (!fs.existsSync(convDir)) fs.mkdirSync(convDir, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '') + '-' + Math.random().toString(36).slice(2, 6);
  const baseName = 'conversation-' + stamp;
  const msgSrc = path.join(dataDir, 'messages.jsonl');
  const histSrc = path.join(dataDir, 'history.jsonl');
  if (fs.existsSync(msgSrc)) fs.copyFileSync(msgSrc, path.join(convDir, baseName + '.jsonl'));
  if (fs.existsSync(histSrc)) fs.copyFileSync(histSrc, path.join(convDir, baseName + '-history.jsonl'));
  // Clean up current files
  if (fs.existsSync(msgSrc)) fs.unlinkSync(msgSrc);
  if (fs.existsSync(histSrc)) fs.unlinkSync(histSrc);
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith('consumed-') && f.endsWith('.json')) {
        fs.unlinkSync(path.join(dataDir, f));
      }
    }
  }
  return { success: true, archived: baseName };
}

function apiListConversations(query) {
  const projectPath = query.get('project') || null;
  const dataDir = resolveDataDir(projectPath);
  const convDir = path.join(dataDir, 'conversations');
  if (!fs.existsSync(convDir)) return { conversations: [] };
  const files = fs.readdirSync(convDir).filter(f => f.startsWith('conversation-') && f.endsWith('.jsonl') && !f.endsWith('-history.jsonl'));
  const conversations = files.map(f => {
    const name = f.replace('.jsonl', '');
    const dateStr = name.replace('conversation-', '').replace(/-/g, function(m, i) {
      // First 2 dashes are date separators, 3rd is T separator, rest are time separators
      return m;
    });
    // Parse date from stamp: YYYY-MM-DDTHH-MM-SS
    const parts = name.replace('conversation-', '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
    let date = '';
    if (parts) {
      date = parts[1] + '-' + parts[2] + '-' + parts[3] + 'T' + parts[4] + ':' + parts[5] + ':' + parts[6];
    }
    let messageCount = 0;
    try {
      const content = fs.readFileSync(path.join(convDir, f), 'utf8').trim();
      if (content) messageCount = content.split(/\r?\n/).filter(l => l.trim()).length;
    } catch {}
    return { name, date, messageCount };
  });
  conversations.sort((a, b) => b.date.localeCompare(a.date));
  return { conversations };
}

function apiLoadConversation(query) {
  const projectPath = query.get('project') || null;
  const name = query.get('name');
  if (!name || /[^a-zA-Z0-9_-]/.test(name) || name.length > 100) {
    return { error: 'Invalid conversation name' };
  }
  const dataDir = resolveDataDir(projectPath);
  const convDir = path.join(dataDir, 'conversations');
  const msgFile = path.join(convDir, name + '.jsonl');
  const histFile = path.join(convDir, name + '-history.jsonl');
  if (!fs.existsSync(msgFile)) return { error: 'Conversation not found' };
  // Use file lock to prevent corruption during concurrent writes
  const lockPath = path.join(dataDir, 'messages.jsonl.lock');
  try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); } catch {
    return { error: 'Messages file is locked by another operation. Try again.' };
  }
  try {
    fs.copyFileSync(msgFile, path.join(dataDir, 'messages.jsonl'));
    if (fs.existsSync(histFile)) {
      fs.copyFileSync(histFile, path.join(dataDir, 'history.jsonl'));
    } else {
      const hp = path.join(dataDir, 'history.jsonl');
      if (fs.existsSync(hp)) fs.unlinkSync(hp);
    }
    // Clear stale consumed offsets
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (f.startsWith('consumed-') && f.endsWith('.json')) {
          fs.unlinkSync(path.join(dataDir, f));
        }
      }
    }
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
  return { success: true };
}

// Sender names API callers must not use for /api/inject (prevents forged system/group traffic)
const INJECT_FROM_BLOCKLIST = new Set(['__system__', '__all__', '__open__', '__close__', '__group__']);

// Inject a message from the dashboard (system message or nudge to an agent)
function apiInjectMessage(body, query) {
  const projectPath = query.get('project') || null;
  const dataDir = resolveDataDir(projectPath);
  const messagesFile = path.join(dataDir, 'messages.jsonl');
  const historyFile = path.join(dataDir, 'history.jsonl');

  if (!body.to || !body.content) {
    return { error: 'Missing "to" and/or "content" fields' };
  }
  if (typeof body.content !== 'string' || body.content.length > 100000) {
    return { error: 'Message content too long (max 100KB)' };
  }
  // Strip control characters to prevent injection
  body.content = body.content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  if (body.to !== '__all__' && !/^[a-zA-Z0-9_-]{1,20}$/.test(body.to)) {
    return { error: 'Invalid agent name' };
  }

  let fromName = '__user__';
  if (body.from !== undefined && body.from !== null && String(body.from).trim() !== '') {
    if (typeof body.from !== 'string' || !/^[a-zA-Z0-9_-]{1,20}$/.test(body.from.trim())) {
      return { error: 'Invalid "from" — must be 1–20 alphanumeric, underscore, or hyphen' };
    }
    fromName = body.from.trim();
    if (INJECT_FROM_BLOCKLIST.has(fromName)) {
      return { error: 'Invalid "from" — reserved name' };
    }
  }

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();

  // Touch sender's heartbeat so inject activity keeps the agent alive in the dashboard
  if (fromName !== '__user__') {
    try {
      const hbFile = path.join(dataDir, `heartbeat-${fromName}.json`);
      const agentsFile = path.join(dataDir, 'agents.json');
      const payload = { last_activity: now, pid: process.pid };
      const tmp = hbFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, hbFile);
      if (fs.existsSync(agentsFile)) {
        const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
        if (agents[fromName]) {
          agents[fromName].last_activity = now;
          fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
        }
      }
    } catch {}
  }

  // Broadcast to all agents — single __group__ message instead of per-agent
  if (body.to === '__all__') {
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      from: fromName,
      to: '__group__',
      content: body.content,
      timestamp: now,
    };
    fs.appendFileSync(messagesFile, JSON.stringify(msg) + '\n');
    fs.appendFileSync(historyFile, JSON.stringify(msg) + '\n');
    return { success: true, messageId: msg.id, broadcast: true };
  }

  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    from: fromName,
    to: body.to,
    content: body.content,
    timestamp: now,
  };

  fs.appendFileSync(messagesFile, JSON.stringify(msg) + '\n');
  fs.appendFileSync(historyFile, JSON.stringify(msg) + '\n');

  return { success: true, messageId: msg.id };
}

// Multi-project management
function apiProjects() {
  const raw = getProjects();
  const normalized = raw.map(p => {
    const np = normalizeMonitoredProjectRoot(p.path);
    let name = p.name;
    if (path.resolve(np) !== path.resolve(p.path)) {
      name = path.basename(np) || p.name;
    }
    if (!name || name === '.neohive') {
      name = path.basename(np) || 'project';
    }
    return { ...p, path: np, name };
  });

  const seen = new Set();
  const deduped = [];
  for (const p of normalized) {
    const key = path.resolve(p.path);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  // Drop projects whose hive is the same as “Default (local)” — avoids duplicate rows and agents flickering between two identical paths.
  const defaultHive = path.resolve(resolveDataDir(null));
  const nonRedundant = deduped.filter(p => path.resolve(resolveDataDir(p.path)) !== defaultHive);

  const pack = (arr) =>
    JSON.stringify(
      [...arr].sort((a, b) => path.resolve(a.path).localeCompare(path.resolve(b.path)))
        .map(p => ({ p: path.resolve(p.path), n: p.name, a: p.added_at || '' }))
    );
  // Compare to on-disk `raw`, not `normalized`: normalized always includes dupes / default-hive
  // rows that nonRedundant drops, so pack(normalized) !== pack(nonRedundant) would rewrite every
  // read even when projects.json already matches nonRedundant.
  if (pack(nonRedundant) !== pack(raw)) {
    saveProjects(nonRedundant);
  }
  return nonRedundant;
}

function apiAddProject(body) {
  if (!body.path) return { error: 'Missing "path" field' };
  const rawResolved = path.resolve(String(body.path).trim());
  if (path.basename(rawResolved) === '.neohive') {
    return {
      error:
        'Add the repository folder (same as your Cursor workspace root), not .neohive. Data is stored in <repo>/.neohive automatically.',
    };
  }
  const absPath = normalizeMonitoredProjectRoot(rawResolved);

  // Reject root directories and system paths
  const normalized = absPath.replace(/\\/g, '/');
  if (normalized === '/' || normalized === 'C:/' || /^[A-Z]:\/$/i.test(normalized) || /^[A-Z]:\/Windows/i.test(normalized) || normalized.startsWith('/etc') || normalized.startsWith('/usr') || normalized.startsWith('/sys')) {
    return { error: 'Cannot monitor system directories' };
  }

  if (!fs.existsSync(absPath)) return { error: `Path does not exist: ${absPath}` };

  const targetHive = path.resolve(resolveDataDir(absPath));
  const defaultHive = path.resolve(resolveDataDir(null));
  if (targetHive === defaultHive) {
    return {
      error:
        'That folder uses the same Neohive data directory as “Default (local)”. No separate project is needed.',
      same_as_default: true,
    };
  }

  const projects = getProjects();
  const name = body.name || path.basename(absPath);
  if (projects.find(p => normalizeMonitoredProjectRoot(path.resolve(p.path)) === absPath)) {
    return { error: 'Project already added' };
  }

  // Create .neohive directory if it doesn't exist
  const abDir = path.join(absPath, '.neohive');
  if (!fs.existsSync(abDir)) fs.mkdirSync(abDir, { recursive: true });

  // Set up MCP config so agents can use it
  const serverPath = path.join(__dirname, 'server.js').replace(/\\/g, '/');
  ensureMCPConfig('claude', serverPath, absPath);
  ensureMCPConfig('cursor', serverPath, absPath);

  projects.push({ name, path: absPath, added_at: new Date().toISOString() });
  try {
    saveProjects(projects);
  } catch (e) {
    return { error: 'Failed to save project: ' + e.message };
  }
  return { success: true, project: { name, path: absPath } };
}

function apiRemoveProject(body) {
  if (!body.path) return { error: 'Missing "path" field' };
  const absPath = normalizeMonitoredProjectRoot(path.resolve(body.path));
  let projects = getProjects();
  const before = projects.length;
  projects = projects.filter(p => normalizeMonitoredProjectRoot(path.resolve(p.path)) !== absPath);
  if (projects.length === before) return { error: 'Project not found' };
  try {
    saveProjects(projects);
  } catch (e) {
    return { error: 'Failed to save project changes: ' + e.message };
  }
  return { success: true };
}

// Export conversation as self-contained HTML
function apiExportHtml(query) {
  const projectPath = query.get('project') || null;
  const history = readJsonl(filePath('history.jsonl', projectPath));
  const acks = readJson(filePath('acks.json', projectPath));
  const agents = readJson(filePath('agents.json', projectPath));
  history.forEach(m => { m.acked = !!acks[m.id]; });

  const agentNames = [...new Set(history.map(m => m.from))];
  const exportDate = new Date().toLocaleString();

  const startTime = history.length > 0 ? new Date(history[0].timestamp).toLocaleString() : '';
  const endTime = history.length > 0 ? new Date(history[history.length - 1].timestamp).toLocaleString() : '';
  const duration = history.length > 1 ? Math.round((new Date(history[history.length-1].timestamp) - new Date(history[0].timestamp)) / 60000) : 0;
  const durationStr = duration > 60 ? Math.floor(duration/60) + 'h ' + (duration%60) + 'm' : duration + ' minutes';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Neohive — Conversation Export</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect rx='20' width='100' height='100' fill='%230d1117'/><path d='M20 30 Q20 20 30 20 H70 Q80 20 80 30 V55 Q80 65 70 65 H55 L40 80 V65 H30 Q20 65 20 55Z' fill='%23f59e0b'/><circle cx='38' cy='42' r='5' fill='%230d1117'/><circle cx='55' cy='42' r='5' fill='%230d1117'/></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e6edf3;min-height:100vh}
.export-header{background:linear-gradient(180deg,#0f0f18 0%,#0a0a0f 100%);padding:40px 24px 32px;text-align:center;border-bottom:1px solid #1e1e2e}
.logo{font-size:28px;font-weight:800;background:linear-gradient(135deg,#f59e0b,#f97316);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-1px}
.export-meta{margin-top:12px;display:flex;justify-content:center;gap:20px;flex-wrap:wrap}
.meta-item{font-size:12px;color:#8888a0}
.meta-val{color:#f59e0b;font-weight:600}
.agent-chips{display:flex;gap:8px;justify-content:center;margin-top:16px;flex-wrap:wrap}
.agent-chip{display:flex;align-items:center;gap:6px;background:#161622;border:1px solid #1e1e2e;border-radius:20px;padding:4px 12px 4px 4px;font-size:12px}
.agent-chip .dot{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff}
.messages{max-width:860px;margin:0 auto;padding:20px 24px}
.msg{display:flex;gap:10px;padding:10px 14px;border-radius:8px;margin-bottom:2px}
.msg:hover{background:#161622}
.avatar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff;flex-shrink:0}
.msg-body{flex:1;min-width:0}
.msg-header{display:flex;gap:6px;align-items:baseline;margin-bottom:3px;flex-wrap:wrap}
.msg-from{font-weight:600;font-size:13px}
.msg-arrow{color:#555568;font-size:11px}
.msg-to{font-size:12px;color:#8888a0}
.msg-time{font-size:10px;color:#555568}
.msg-content{font-size:13px;line-height:1.6;word-break:break-word}
.msg-content strong{font-weight:700}
.msg-content em{font-style:italic;color:#8888a0}
.msg-content code{background:#1e1e2e;padding:1px 5px;border-radius:4px;font-size:12px;font-family:Consolas,monospace;color:#d29922}
.msg-content pre{background:#0f0f18;border:1px solid #1e1e2e;border-radius:6px;padding:12px;margin:6px 0;overflow-x:auto;font-size:12px;font-family:Consolas,monospace}
.msg-content pre code{background:none;color:#e6edf3;padding:0}
.msg-content h1,.msg-content h2,.msg-content h3{margin:8px 0 4px;font-weight:700}
.msg-content h1{font-size:18px;border-bottom:1px solid #1e1e2e;padding-bottom:4px}
.msg-content h2{font-size:16px}
.msg-content h3{font-size:14px}
.msg-content ul,.msg-content ol{padding-left:20px;margin:4px 0}
.msg-content table{border-collapse:collapse;margin:6px 0;font-size:12px}
.msg-content th,.msg-content td{border:1px solid #1e1e2e;padding:4px 8px;text-align:left}
.msg-content th{background:#161622}
.badge{font-size:9px;padding:1px 5px;border-radius:8px;font-weight:600}
.badge-ack{background:rgba(63,185,80,0.15);color:#3fb950}
.date-sep{display:flex;align-items:center;gap:12px;padding:12px 14px 6px;color:#555568;font-size:11px;font-weight:600}
.date-sep::before,.date-sep::after{content:'';flex:1;height:1px;background:#1e1e2e}
.footer{border-top:1px solid #1e1e2e;padding:24px;text-align:center;font-size:11px;color:#555568}
.footer a{color:#8888a0;text-decoration:none}
.footer a:hover{color:#f59e0b}
</style></head><body>
<div class="export-header">
<div class="logo">Neohive</div>
<div class="export-meta">
<span class="meta-item"><span class="meta-val">${history.length}</span> messages</span>
<span class="meta-item"><span class="meta-val">${agentNames.length}</span> agents</span>
<span class="meta-item"><span class="meta-val">${durationStr}</span> duration</span>
<span class="meta-item">Exported ${htmlEscape(exportDate)}</span>
</div>
<div class="agent-chips" id="agent-chips"></div>
</div>
<div class="messages" id="messages"></div>
<div class="footer">Generated by <a href="https://github.com/fakiho/neohive" target="_blank">Neohive</a> &middot; BSL 1.1</div>
<script>
var COLORS=['#f59e0b','#f97316','#3fb950','#d29922','#f85149','#f778ba','#7ee787','#e3b341','#ffa198','#14b8a6'];
var colorMap={},ci=0;
var data=${JSON.stringify(history).replace(/<\//g, '<\\/')};
function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML}
function fmt(t){
var h=esc(t);
h=h.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,function(_,l,c){return '<pre><code>'+c+'</code></pre>'});
h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
h=h.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>');
h=h.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
h=h.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
h=h.replace(/^### (.+)/gm,'<h3>$1</h3>');
h=h.replace(/^## (.+)/gm,'<h2>$1</h2>');
h=h.replace(/^# (.+)/gm,'<h1>$1</h1>');
h=h.replace(/^[\\-\\*] (.+)/gm,'<li>$1</li>');
return h}
function color(n){if(!colorMap[n]){colorMap[n]=COLORS[ci%COLORS.length];ci++}return colorMap[n]}
var chips='';
var seen={};
for(var a=0;a<data.length;a++){var f=data[a].from;if(!seen[f]){seen[f]=true;var c=color(f);chips+='<div class="agent-chip"><div class="dot" style="background:'+c+'">'+f.charAt(0).toUpperCase()+'</div>'+esc(f)+'</div>'}}
document.getElementById('agent-chips').innerHTML=chips;
var html='';var lastDate='';
for(var i=0;i<data.length;i++){var m=data[i];var c=color(m.from);
var msgDate=new Date(m.timestamp).toLocaleDateString();
if(msgDate!==lastDate){var today=new Date().toLocaleDateString();var label=msgDate===today?'Today':msgDate;html+='<div class="date-sep">'+label+'</div>';lastDate=msgDate}
var badges='';if(m.acked)badges+='<span class="badge badge-ack">ACK</span>';
html+='<div class="msg"><div class="avatar" style="background:'+c+'">'+m.from.charAt(0).toUpperCase()+'</div><div class="msg-body"><div class="msg-header"><span class="msg-from" style="color:'+c+'">'+esc(m.from)+'</span><span class="msg-arrow">&rarr;</span><span class="msg-to">'+esc(m.to)+'</span><span class="msg-time">'+new Date(m.timestamp).toLocaleTimeString()+'</span>'+badges+'</div><div class="msg-content">'+fmt(m.content)+'</div></div></div>'}
document.getElementById('messages').innerHTML=html;
</script></body></html>`;
}

// Timeline API — agent activity over time for heatmap visualization
function apiTimeline(query) {
  const projectPath = query.get('project') || null;
  const history = readJsonl(filePath('history.jsonl', projectPath));
  if (history.length === 0) return { agents: {}, duration_seconds: 0 };

  const agents = {};
  const startTime = new Date(history[0].timestamp).getTime();
  const endTime = new Date(history[history.length - 1].timestamp).getTime();
  const durationSeconds = Math.floor((endTime - startTime) / 1000);

  // Build activity windows per agent — each message marks a 30s "active" window
  for (const m of history) {
    if (!agents[m.from]) {
      agents[m.from] = { message_count: 0, active_seconds: 0, gaps: [], timestamps: [] };
    }
    agents[m.from].message_count++;
    agents[m.from].timestamps.push(m.timestamp);
  }

  // Calculate activity percentage and response gaps
  for (const [name, data] of Object.entries(agents)) {
    const ts = data.timestamps.map(t => new Date(t).getTime());
    let activeSeconds = 0;
    for (let i = 0; i < ts.length; i++) {
      activeSeconds += 30; // each message = ~30s of activity
      if (i > 0) {
        const gap = Math.floor((ts[i] - ts[i - 1]) / 1000);
        if (gap > 60) {
          data.gaps.push({ after_message: i, gap_seconds: gap });
        }
      }
    }
    data.active_seconds = Math.min(activeSeconds, durationSeconds || 1);
    data.activity_pct = durationSeconds > 0 ? Math.round((data.active_seconds / durationSeconds) * 100) : 100;
    delete data.timestamps; // don't send raw timestamps
  }

  return {
    agents,
    duration_seconds: durationSeconds,
    start_time: history[0].timestamp,
    end_time: history[history.length - 1].timestamp,
    total_messages: history.length,
  };
}

// Tasks API
function apiTasks(query) {
  const projectPath = query.get('project') || null;
  const tasksFile = filePath('tasks.json', projectPath);
  if (!fs.existsSync(tasksFile)) return [];
  try { return JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch { return []; }
}

function apiUpdateTask(body, query) {
  const projectPath = query.get('project') || null;
  const tasksFile = filePath('tasks.json', projectPath);
  if (!body.task_id || !body.status) return { error: 'Missing task_id or status' };

  let tasks = [];
  if (fs.existsSync(tasksFile)) {
    try { tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch {}
  }

  const task = tasks.find(t => t.id === body.task_id);
  if (!task) return { error: 'Task not found' };

  const validStatuses = ['pending', 'in_progress', 'done', 'blocked'];
  if (!validStatuses.includes(body.status)) return { error: 'Invalid status. Must be: ' + validStatuses.join(', ') };
  task.status = body.status;
  task.updated_at = new Date().toISOString();
  if (body.notes) {
    if (!Array.isArray(task.notes)) task.notes = [];
    task.notes.push({ by: 'Dashboard', text: body.notes, at: new Date().toISOString() });
  }

  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
  return { success: true, task_id: task.id, status: task.status };
}

// Rules API
function apiRules(query) {
  const projectPath = query.get('project') || null;
  const rulesFile = filePath('rules.json', projectPath);
  if (!fs.existsSync(rulesFile)) return [];
  try { return JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch { return []; }
}

function parseScope(scope) {
  const result = { role: undefined, provider: undefined, agent: undefined };
  if (!scope) return result;
  if (typeof scope === 'object') {
    if (scope.role) result.role = String(scope.role).toLowerCase();
    if (scope.provider) result.provider = String(scope.provider).toLowerCase();
    if (scope.agent) result.agent = String(scope.agent);
  } else if (typeof scope === 'string' && scope !== 'global') {
    const parts = scope.split(':');
    if (parts.length === 2) {
      const type = parts[0].toLowerCase();
      const val = parts[1];
      if (type === 'role') result.role = val.toLowerCase();
      else if (type === 'platform' || type === 'provider') result.provider = val.toLowerCase();
      else if (type === 'agent') result.agent = val;
    }
  }
  return result;
}

function apiAddRule(body, query) {
  const projectPath = query.get('project') || null;
  const rulesFile = filePath('rules.json', projectPath);
  if (!body.text || !body.text.trim()) return { error: 'Rule text is required' };

  const crypto = require('crypto');
  let rules = [];
  if (fs.existsSync(rulesFile)) {
    try { rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch {}
  }

  const parsedScope = parseScope(body.scope);
  const rule = {
    id: 'rule_' + crypto.randomBytes(6).toString('hex'),
    text: body.text.trim(),
    category: body.category || 'general',
    priority: body.priority || 'normal',
    scope_role: parsedScope.role,
    scope_provider: parsedScope.provider,
    scope_agent: parsedScope.agent,
    created_by: body.created_by || 'Dashboard',
    created_at: new Date().toISOString(),
    active: true
  };
  rules.push(rule);
  fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
  return { success: true, rule };
}

function apiUpdateRule(body, query) {
  const projectPath = query.get('project') || null;
  const rulesFile = filePath('rules.json', projectPath);
  if (!body.rule_id) return { error: 'Missing rule_id' };

  let rules = [];
  if (fs.existsSync(rulesFile)) {
    try { rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch {}
  }

  const rule = rules.find(r => r.id === body.rule_id);
  if (!rule) return { error: 'Rule not found' };

  if (body.text !== undefined) rule.text = body.text.trim();
  if (body.category !== undefined) rule.category = body.category;
  if (body.priority !== undefined) rule.priority = body.priority;
  if (body.scope !== undefined) {
    const parsedScope = parseScope(body.scope);
    rule.scope_role = parsedScope.role;
    rule.scope_provider = parsedScope.provider;
    rule.scope_agent = parsedScope.agent;
  }
  if (body.active !== undefined) rule.active = body.active;
  rule.updated_at = new Date().toISOString();

  fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
  return { success: true, rule };
}

function apiDeleteRule(body, query) {
  const projectPath = query.get('project') || null;
  const rulesFile = filePath('rules.json', projectPath);
  if (!body.rule_id) return { error: 'Missing rule_id' };

  let rules = [];
  if (fs.existsSync(rulesFile)) {
    try { rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch {}
  }

  const idx = rules.findIndex(r => r.id === body.rule_id);
  if (idx === -1) return { error: 'Rule not found' };
  rules.splice(idx, 1);

  fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
  return { success: true };
}

// Audit Log API
function apiAuditLog(query) {
  const projectPath = query.get('project') || null;
  
  // For backward compatibility, if no enhanced filters are used, use old method
  const hasFilters = query.get('agent') || query.get('tool') || query.get('category') || 
                    query.get('since') || query.get('until') || query.get('limit');
  
  if (!hasFilters) {
    // Legacy behavior: Read entries, take last 100, newest first
    return readJsonl(filePath('audit_log.jsonl', projectPath)).slice(-100).reverse();
  }
  
  // Enhanced audit log with filters using audit module
  const filters = {
    agent: query.get('agent') || undefined,
    tool: query.get('tool') || undefined,
    category: query.get('category') || undefined,
    since: query.get('since') || undefined,
    until: query.get('until') || undefined,
    limit: query.get('limit') || undefined
  };
  
  // Initialize audit module with project path if needed
  if (projectPath) {
    const auditDataDir = path.join(projectPath, '.neohive');
    if (fs.existsSync(auditDataDir)) {
      _audit.init(auditDataDir);
    }
  }
  
  return _audit.readAuditLog(filters);
}

// Audit Stats API
function apiAuditStats(query) {
  const projectPath = query.get('project') || null;
  
  const filters = {
    agent: query.get('agent') || undefined,
    tool: query.get('tool') || undefined,
    category: query.get('category') || undefined,
    since: query.get('since') || undefined,
    until: query.get('until') || undefined
  };
  
  // Initialize audit module with project path if needed
  if (projectPath) {
    const auditDataDir = path.join(projectPath, '.neohive');
    if (fs.existsSync(auditDataDir)) {
      _audit.init(auditDataDir);
    }
  }
  
  return _audit.getAuditStats(filters);
}

// Auto-discover .neohive directories nearby
function apiDiscover() {
  const found = [];
  const checked = new Set();
  const existing = new Set(getProjects().map(p => normalizeMonitoredProjectRoot(path.resolve(p.path))));

  function scanDir(dir, depth, maxDepth) {
    maxDepth = maxDepth || 3;
    if (depth > maxDepth || checked.has(dir)) return;
    checked.add(dir);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') && entry.name !== '.neohive') continue;
        if (entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.name === '.neohive' && hasDataFiles(fullPath)) {
          const projectPath = dir;
          if (!existing.has(projectPath)) {
            found.push({ name: path.basename(projectPath), path: projectPath, dataDir: fullPath });
          }
        } else if (depth < maxDepth) {
          scanDir(fullPath, depth + 1, maxDepth);
        }
      }
    } catch {}
  }

  // Scan from cwd, parent, home, Desktop, and common project locations
  const cwd = process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE || '';
  scanDir(cwd, 0);
  scanDir(path.dirname(cwd), 1);
  if (home) {
    scanDir(home, 0);
    scanDir(path.join(home, 'Desktop'), 0);
    scanDir(path.join(home, 'Documents'), 0);
    scanDir(path.join(home, 'Projects'), 0);
    scanDir(path.join(home, 'Desktop', 'Claude Projects'), 0);
    scanDir(path.join(home, 'Desktop', 'Projects'), 0);
  }

  return found;
}

// --- Agent Launcher ---

/** Same as cli.js: absolute Node path so MCP spawns work when PATH omits Volta/nvm. */
function mcpNodeCommand() {
  return process.execPath;
}

function ensureMCPConfig(cli, serverPath, projectDir) {
  const abDir = path.join(projectDir, '.neohive').replace(/\\/g, '/');
  if (cli === 'claude') {
    const mcpConfigPath = path.join(projectDir, '.mcp.json');
    let mcpConfig = { mcpServers: {} };
    if (fs.existsSync(mcpConfigPath)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')); if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}; } catch {}
    }
    if (!mcpConfig.mcpServers['neohive']) {
      mcpConfig.mcpServers['neohive'] = { command: mcpNodeCommand(), args: [serverPath], env: { NEOHIVE_DATA_DIR: abDir } };
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
    }
  } else if (cli === 'gemini') {
    const geminiDir = path.join(projectDir, '.gemini');
    const settingsPath = path.join(geminiDir, 'settings.json');
    if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });
    let settings = { mcpServers: {} };
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); if (!settings.mcpServers) settings.mcpServers = {}; } catch {}
    }
    if (!settings.mcpServers['neohive']) {
      settings.mcpServers['neohive'] = { command: mcpNodeCommand(), args: [serverPath], env: { NEOHIVE_DATA_DIR: abDir } };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } else if (cli === 'codex') {
    const codexDir = path.join(projectDir, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });
    let config = '';
    if (fs.existsSync(configPath)) config = fs.readFileSync(configPath, 'utf8');
    const envSection =
      `[mcp_servers.neohive.env]\nNEOHIVE_DATA_DIR = ${JSON.stringify(abDir)}\n`;
    const hadNeohive = config.includes('[mcp_servers.neohive]');
    config = upsertNeohiveMcpInToml(config, {
      command: mcpNodeCommand(),
      serverPath,
      timeout: 300,
      envSection: hadNeohive ? undefined : envSection,
    });
    fs.writeFileSync(configPath, config);
  } else if (cli === 'cursor') {
    const cursorDir = path.join(projectDir, '.cursor');
    const mcpConfigPath = path.join(cursorDir, 'mcp.json');
    if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true });
    let mcpConfig = { mcpServers: {} };
    if (fs.existsSync(mcpConfigPath)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')); if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}; } catch {}
    }
    if (!mcpConfig.mcpServers['neohive']) {
      mcpConfig.mcpServers['neohive'] = {
        command: mcpNodeCommand(),
        args: [serverPath],
        env: { NEOHIVE_DATA_DIR: abDir },
        timeout: 300,
      };
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
    }
  }
}

function apiLaunchAgent(body) {
  const { cli, project_dir, agent_name, prompt } = body;
  if (!cli || !['claude', 'gemini', 'codex', 'cursor'].includes(cli)) {
    return { error: 'Invalid cli type. Must be: claude, gemini, codex, or cursor' };
  }
  if (project_dir && !validateProjectPath(project_dir)) {
    return { error: 'Project directory not registered. Add it via the dashboard first.' };
  }
  const projectDir = project_dir || process.cwd();
  if (!fs.existsSync(projectDir)) {
    return { error: 'Project directory does not exist: ' + projectDir };
  }

  const safeName = (agent_name || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
  const launchPrompt = prompt || (safeName ? `You are agent "${safeName}". Use the register tool to register as "${safeName}", then use listen to wait for messages.` : `Register with the neohive MCP tools and use listen to wait for messages.`);

  const serverPath = path.join(__dirname, 'server.js').replace(/\\/g, '/');
  ensureMCPConfig(cli, serverPath, projectDir);

  if (cli === 'cursor') {
    return {
      success: true,
      launched: false,
      cli: 'cursor',
      project_dir: projectDir,
      prompt: launchPrompt,
      message: 'Open this folder in Cursor IDE. .cursor/mcp.json sets NEOHIVE_DATA_DIR to this project’s .neohive (absolute path). Restart Cursor or reload MCP tools, then paste the prompt.',
    };
  }

  const cliCommands = { claude: 'claude', gemini: 'gemini', codex: 'codex' };
  const cliCmd = cliCommands[cli];

  // Try to launch terminal — user pastes prompt from clipboard after CLI loads
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', cliCmd], { cwd: projectDir, shell: false, detached: true, stdio: 'ignore' });
    return { success: true, launched: true, cli, project_dir: projectDir, prompt: launchPrompt };
  }

  // Non-Windows: return command for manual execution
  return {
    success: true, launched: false, cli, project_dir: projectDir,
    command: `cd "${projectDir}" && ${cliCmd}`,
    prompt: launchPrompt,
    message: 'Run the command in a terminal, then paste the prompt.'
  };
}

// --- v3.4: Message Edit ---
async function apiEditMessage(body, query) {
  const projectPath = query.get('project') || null;
  const { id, content } = body;
  if (!id || !content) return { error: 'Missing "id" and/or "content" fields' };
  if (content.length > 50000) return { error: 'Content too long (max 50000 chars)' };

  const dataDir = resolveDataDir(projectPath);
  const historyFile = path.join(dataDir, 'history.jsonl');
  const messagesFile = path.join(dataDir, 'messages.jsonl');

  let found = false;
  const now = new Date().toISOString();

  // Update in history.jsonl (locked)
  await withFileLock(historyFile, () => {
    if (fs.existsSync(historyFile)) {
      const lines = fs.readFileSync(historyFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const updated = lines.map(line => {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            found = true;
            if (!msg.edit_history) msg.edit_history = [];
            msg.edit_history.push({ content: msg.content, edited_at: now });
            if (msg.edit_history.length > 10) msg.edit_history = msg.edit_history.slice(-10);
            msg.content = content;
            msg.edited = true;
            msg.edited_at = now;
            return JSON.stringify(msg);
          }
          return line;
        } catch { return line; }
      });
      if (found) fs.writeFileSync(historyFile, updated.join('\n') + '\n');
    }
  });

  // Also update in messages.jsonl (locked independently)
  if (found) {
    await withFileLock(messagesFile, () => {
      if (fs.existsSync(messagesFile)) {
        const raw = fs.readFileSync(messagesFile, 'utf8').trim();
        if (raw) {
          const lines = raw.split(/\r?\n/);
          const updated = lines.map(line => {
            try {
              const msg = JSON.parse(line);
              if (msg.id === id) {
                msg.content = content;
                msg.edited = true;
                msg.edited_at = now;
                return JSON.stringify(msg);
              }
              return line;
            } catch { return line; }
          });
          fs.writeFileSync(messagesFile, updated.join('\n') + '\n');
        }
      }
    });
  }

  if (!found) return { error: 'Message not found' };
  return { success: true, id, edited_at: now };
}

// --- v3.4: Message Delete ---
async function apiDeleteMessage(body, query) {
  const projectPath = query.get('project') || null;
  const { id } = body;
  if (!id) return { error: 'Missing "id" field' };

  const dataDir = resolveDataDir(projectPath);
  const historyFile = path.join(dataDir, 'history.jsonl');
  const messagesFile = path.join(dataDir, 'messages.jsonl');

  let found = false;
  let msgFrom = null;

  // Find the message and remove from history.jsonl (locked)
  await withFileLock(historyFile, () => {
    if (fs.existsSync(historyFile)) {
      const lines = fs.readFileSync(historyFile, 'utf8').trim().split(/\r?\n/);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) { found = true; msgFrom = msg.from; break; }
        } catch {}
      }

      if (found) {
        const allowed = ['Dashboard', 'dashboard', 'system', '__system__'];
        if (allowed.includes(msgFrom)) {
          const filtered = lines.filter(line => {
            try { return JSON.parse(line).id !== id; } catch { return true; }
          });
          fs.writeFileSync(historyFile, filtered.join('\n') + (filtered.length ? '\n' : ''));
        }
      }
    }
  });

  if (!found) return { error: 'Message not found' };

  // Only allow deleting dashboard-injected or system messages
  const allowed = ['Dashboard', 'dashboard', 'system', '__system__'];
  if (!allowed.includes(msgFrom)) {
    return { error: 'Can only delete messages sent from Dashboard or system' };
  }

  // Remove from messages.jsonl (locked independently)
  await withFileLock(messagesFile, () => {
    if (fs.existsSync(messagesFile)) {
      const lines = fs.readFileSync(messagesFile, 'utf8').trim().split(/\r?\n/);
      const filtered = lines.filter(line => {
        try { return JSON.parse(line).id !== id; } catch { return true; }
      });
      fs.writeFileSync(messagesFile, filtered.join('\n') + (filtered.length ? '\n' : ''));
    }
  });

  return { success: true, id };
}

// --- v3.4: Conversation Templates ---
function apiGetConversationTemplates() {
  const templatesDir = path.join(__dirname, 'conversation-templates');
  if (!fs.existsSync(templatesDir)) {
    // Return built-in templates
    return getBuiltInConversationTemplates();
  }
  const custom = fs.readdirSync(templatesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(templatesDir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
  return [...getBuiltInConversationTemplates(), ...custom];
}

function getBuiltInConversationTemplates() {
  return [
    {
      id: 'code-review',
      name: 'Code Review Pipeline',
      description: 'Developer writes code, Reviewer checks it, Tester validates',
      agents: [
        { name: 'Developer', role: 'Developer', prompt: 'You are a developer. Write code as instructed. After completing, send your code to Reviewer for review.' },
        { name: 'Reviewer', role: 'Code Reviewer', prompt: 'You are a code reviewer. Wait for code from Developer. Review it for bugs, style, and best practices. Send feedback back to Developer or approve and forward to Tester.' },
        { name: 'Tester', role: 'QA Tester', prompt: 'You are a QA tester. Wait for approved code from Reviewer. Write and run tests. Report results back to the team.' }
      ],
      workflow: { name: 'Code Review', steps: ['Write Code', 'Review', 'Test', 'Approve'] }
    },
    {
      id: 'debug-squad',
      name: 'Debug Squad',
      description: 'Investigator finds the bug, Fixer patches it, Verifier confirms the fix',
      agents: [
        { name: 'Investigator', role: 'Bug Investigator', prompt: 'You investigate bugs. Analyze error logs, trace code paths, and identify root causes. Send findings to Fixer.' },
        { name: 'Fixer', role: 'Bug Fixer', prompt: 'You fix bugs. Wait for findings from Investigator. Implement fixes and send to Verifier for confirmation.' },
        { name: 'Verifier', role: 'Fix Verifier', prompt: 'You verify bug fixes. Wait for patches from Fixer. Test the fix and confirm resolution or send back for more work.' }
      ],
      workflow: { name: 'Bug Fix', steps: ['Investigate', 'Fix', 'Verify', 'Close'] }
    },
    {
      id: 'feature-build',
      name: 'Feature Development',
      description: 'Architect designs, Builder implements, Reviewer approves',
      agents: [
        { name: 'Architect', role: 'Software Architect', prompt: 'You are a software architect. Design the feature architecture, define interfaces, and create the implementation plan. Send the plan to Builder.' },
        { name: 'Builder', role: 'Developer', prompt: 'You are a developer. Wait for architecture plans from Architect. Implement the feature following the design. Send completed code to Reviewer.' },
        { name: 'Reviewer', role: 'Senior Reviewer', prompt: 'You are a senior reviewer. Review implementations from Builder against the architecture from Architect. Approve or request changes.' }
      ],
      workflow: { name: 'Feature Dev', steps: ['Design', 'Implement', 'Review', 'Ship'] }
    },
    {
      id: 'research-write',
      name: 'Research & Write',
      description: 'Researcher gathers info, Writer creates content, Editor polishes',
      agents: [
        { name: 'Researcher', role: 'Researcher', prompt: 'You are a researcher. Gather information on the given topic. Organize findings and send a research brief to Writer.' },
        { name: 'Writer', role: 'Writer', prompt: 'You are a writer. Wait for research from Researcher. Write clear, well-structured content based on the findings. Send to Editor.' },
        { name: 'Editor', role: 'Editor', prompt: 'You are an editor. Review and polish content from Writer. Check for clarity, accuracy, and style. Send back final version or request revisions.' }
      ],
      workflow: { name: 'Content Pipeline', steps: ['Research', 'Draft', 'Edit', 'Publish'] }
    }
  ];
}

function apiLaunchConversationTemplate(body, query) {
  const projectPath = query.get('project') || null;
  const { template_id } = body;
  if (!template_id) return { error: 'Missing template_id' };

  const templates = apiGetConversationTemplates();
  const template = templates.find(t => t.id === template_id);
  if (!template) return { error: 'Template not found: ' + template_id };

  // Return the template config for the frontend to display launch instructions
  return {
    success: true,
    template,
    instructions: template.agents.map(a => ({
      agent_name: a.name,
      role: a.role,
      prompt: `You are "${a.name}" with role "${a.role}". ${a.prompt}\n\nFirst register yourself with: register(name="${a.name}"), then update_profile(role="${a.role}"). Then enter listen mode.`
    }))
  };
}

// --- v3.4: Agent Permissions ---
function apiUpdatePermissions(body, query) {
  const projectPath = query.get('project') || null;
  const dataDir = resolveDataDir(projectPath);
  const permFile = path.join(dataDir, 'permissions.json');

  const { agent, permissions } = body;
  if (!agent || !permissions) return { error: 'Missing "agent" and/or "permissions" fields' };

  let perms = {};
  if (fs.existsSync(permFile)) {
    try { perms = JSON.parse(fs.readFileSync(permFile, 'utf8')); } catch {}
  }

  // permissions: { can_read: [agents...] or "*", can_write_to: [agents...] or "*", is_admin: bool }
  const allowed = {};
  if (permissions.can_read !== undefined) allowed.can_read = permissions.can_read;
  if (permissions.can_write_to !== undefined) allowed.can_write_to = permissions.can_write_to;
  if (permissions.is_admin !== undefined) allowed.is_admin = !!permissions.is_admin;
  perms[agent] = {
    ...perms[agent],
    ...allowed,
    updated_at: new Date().toISOString()
  };

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(permFile, JSON.stringify(perms, null, 2));
  return { success: true, agent, permissions: perms[agent] };
}

// --- HTTP Server ---

// Load HTML at startup (re-read on each request in dev for hot-reload)
let htmlContent = fs.readFileSync(HTML_FILE, 'utf8');

const MAX_BODY = 1 * 1024 * 1024; // 1 MB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// --- Rate limiting ---
const apiRateLimits = new Map();
function checkRateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const key = ip;
  if (!apiRateLimits.has(key)) apiRateLimits.set(key, []);
  const timestamps = apiRateLimits.get(key).filter(t => now - t < windowMs);
  apiRateLimits.set(key, timestamps);
  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  return true;
}
// Periodic cleanup to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of apiRateLimits) {
    const filtered = timestamps.filter(t => now - t < 60000);
    if (filtered.length === 0) apiRateLimits.delete(key);
    else apiRateLimits.set(key, filtered);
  }
}, 300000).unref(); // Clean every 5 minutes, .unref() prevents zombie process

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE DISPATCH TABLE
// Simple GET/POST routes are registered here as { method, handler } entries.
// Complex routes (body parsing, SSE, multi-step logic) remain inline below.
// Key format: 'METHOD /path'  e.g. 'GET /api/agents'
// ─────────────────────────────────────────────────────────────────────────────
function routeKey(method, pathname) { return method + ' ' + pathname; }

/** @type {Map<string, (req: any, res: any, url: URL) => void | Promise<void>>} */
const ROUTE_TABLE = new Map([
  // Simple GET routes — each maps to a standalone API function
  [routeKey('GET', '/api/history'),         (req, res, url) => jsonOk(res, apiHistory(url.searchParams))],
  [routeKey('GET', '/api/agents'),          (req, res, url) => jsonOk(res, apiAgents(url.searchParams))],
  [routeKey('GET', '/api/channels'),        (req, res, url) => jsonOk(res, apiChannels(url.searchParams))],
  [routeKey('GET', '/api/decisions'),       (req, res, url) => jsonOk(res, readJson(filePath('decisions.json', url.searchParams.get('project') || null)) || [])],
  [routeKey('GET', '/api/status'),          (req, res, url) => jsonOk(res, apiStatus(url.searchParams))],
  [routeKey('GET', '/api/stats'),           (req, res, url) => jsonOk(res, apiStats(url.searchParams))],
  [routeKey('GET', '/api/token-usage'),     (req, res, url) => jsonOk(res, apiTokenUsage(url.searchParams))],
  [routeKey('GET', '/api/coordinator-mode'),(req, res, url) => {
    const config = readJson(filePath('config.json', url.searchParams.get('project') || null));
    jsonOk(res, { mode: config.coordinator_mode || 'autonomous', config });
  }],
  [routeKey('GET', '/api/projects'),        (req, res, url) => jsonOk(res, apiProjects())],
  [routeKey('GET', '/api/timeline'),        (req, res, url) => jsonOk(res, apiTimeline(url.searchParams))],
  [routeKey('GET', '/api/tasks'),           (req, res, url) => jsonOk(res, apiTasks(url.searchParams))],
  [routeKey('GET', '/api/rules'),           (req, res, url) => jsonOk(res, apiRules(url.searchParams))],
  [routeKey('GET', '/api/audit-log'),       (req, res, url) => jsonOk(res, apiAuditLog(url.searchParams))],
  [routeKey('GET', '/api/audit-stats'),     (req, res, url) => jsonOk(res, apiAuditStats(url.searchParams))],
  [routeKey('GET', '/api/notifications'),   (req, res, url) => jsonOk(res, apiNotifications())],
  [routeKey('GET', '/api/scores'),          (req, res, url) => jsonOk(res, apiScores(url.searchParams))],
  [routeKey('GET', '/api/search-all'),      (req, res, url) => jsonOk(res, apiSearchAll(url.searchParams))],
  [routeKey('GET', '/api/hooks'),           (req, res, url) => {
    try { const hooksLib = require('./lib/hooks'); jsonOk(res, hooksLib.listHooks(null)); }
    catch (e) { jsonOk(res, { count: 0, hooks: [], error: e.message }); }
  }],
  [routeKey('GET', '/api/export-replay'),   (req, res, url) => jsonOk(res, apiExportReplay(url.searchParams))],
  // Routes below have complex inline logic and remain in the else-if chain for safety.
  // TODO: extract to standalone functions in a future refactor:
  //   /api/search, /api/export-json, /api/conversations, /api/profiles, /api/workspaces,
  //   /api/workflows, /api/plan/*, /api/monitor/health, /api/reputation, /api/branches,
  //   /api/conversation-templates, /api/permissions, /api/read-receipts, /api/server-info,
  //   /api/templates
]);

/** Send a 200 JSON response — shared helper for route table handlers */
function jsonOk(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  const allowedOrigin = `http://localhost:${PORT}`;
  const reqOrigin = req.headers.origin;
  const lanIP = getLanIP();
  const lanOrigin = lanIP ? `http://${lanIP}:${PORT}` : null;
  const trustedOrigins = [allowedOrigin, `http://127.0.0.1:${PORT}`];
  if (LAN_MODE && lanOrigin) trustedOrigins.push(lanOrigin);
  if (reqOrigin && trustedOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LTT-Request, X-LTT-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // LAN auth token — required for non-localhost requests when LAN mode is active
  if (LAN_MODE) {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';
    if (!isLocalhost) {
      const tokenFromQuery = url.searchParams.get('token');
      const tokenFromHeader = req.headers['x-ltt-token'];
      const providedToken = tokenFromHeader || tokenFromQuery;
      const crypto = require('crypto');
      if (!providedToken || providedToken.length !== LAN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(providedToken), Buffer.from(LAN_TOKEN))) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing LAN token' }));
        return;
      }
    }
  }

  // CSRF + DNS rebinding protection: validate Host, Origin, and custom header on mutating requests
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    // Check Host header to block DNS rebinding attacks
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const validHosts = ['localhost', '127.0.0.1'];
    if (LAN_MODE && getLanIP()) validHosts.push(getLanIP());
    if (!validHosts.includes(host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid host' }));
      return;
    }
    // Require custom header — browsers block cross-origin custom headers without preflight,
    // which our CORS policy won't approve for foreign origins. This closes the no-Origin gap.
    if (!req.headers['x-ltt-request']) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: missing X-LTT-Request header' }));
      return;
    }
    // Check Origin header to block cross-site requests
    // Empty origin is NOT trusted — requires at least the custom header (checked above)
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const source = origin || referer;
    if (!source) {
      // No origin/referer — non-browser client (curl, scripts, etc.)
      // Allow local CLI tools but block non-local requests without origin
      const reqHost = (req.headers.host || '').replace(/:\d+$/, '');
      if (reqHost !== 'localhost' && reqHost !== '127.0.0.1' && !reqHost.startsWith('192.168.') && !reqHost.startsWith('10.')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: non-local request without origin' }));
        return;
      }
    }
    const allowedSources = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    if (LAN_MODE && getLanIP()) allowedSources.push(`http://${getLanIP()}:${PORT}`);
    let sourceOrigin = '';
    try { sourceOrigin = source ? new URL(source).origin : ''; } catch { sourceOrigin = ''; }
    const isLocal = allowedSources.includes(sourceOrigin);
    const isLan = isLocal;
    if (source && !isLocal && !isLan) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid origin' }));
      return;
    }
  }

  // Rate limit API endpoints (only for non-localhost in LAN mode)
  const clientIP = req.socket.remoteAddress || 'unknown';
  const isLocalhost = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';
  if (url.pathname.startsWith('/api/') && !isLocalhost && !checkRateLimit(clientIP, 300, 60000)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }));
    return;
  }

  try {
    // Validate project parameter on all API endpoints
    const projectParam = url.searchParams.get('project');
    if (projectParam && url.pathname.startsWith('/api/') && !validateProjectPath(projectParam)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project path not registered. Add it via /api/projects first.' }));
      return;
    }

    // Health check — lightweight, no auth required
    if (url.pathname === '/health' && req.method === 'GET') {
      const pkg = readJson(path.join(__dirname, 'package.json')) || {};
      const defaultDataDir = resolveDataDir(null);
      const agents = readJson(filePath('agents.json', null));
      const agentEntries = Object.entries(agents);
      const aliveCount = agentEntries.filter(([, a]) => isPidAlive(a.pid, a.last_activity)).length;
      let messageCount = 0;
      const histFile = filePath('history.jsonl', null);
      if (fs.existsSync(histFile)) {
        try { messageCount = Math.round(fs.statSync(histFile).size / 300); } catch {}
      }
      let activeWorkflows = 0;
      const wfFile = filePath('workflows.json', null);
      if (fs.existsSync(wfFile)) {
        try { activeWorkflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')).filter(w => w.status === 'active').length; } catch {}
      }
      const uptimeMs = Date.now() - SERVER_START_TIME;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: pkg.version || 'unknown',
        uptime_seconds: Math.floor(uptimeMs / 1000),
        agents: { alive: aliveCount, total: agentEntries.length },
        messages: messageCount,
        active_workflows: activeWorkflows,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Serve logo image
    if (url.pathname === '/logo.png') {
      if (fs.existsSync(LOGO_FILE)) {
        const logo = fs.readFileSync(LOGO_FILE);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(logo);
      } else {
        res.writeHead(404);
        res.end('Logo not found');
      }
      return;
    }

    if (url.pathname === '/design-system.css' && req.method === 'GET') {
      if (fs.existsSync(DESIGN_SYSTEM_CSS)) {
        const css = fs.readFileSync(DESIGN_SYSTEM_CSS, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(css);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    if (url.pathname === '/design-system.html' && req.method === 'GET') {
      if (fs.existsSync(DESIGN_SYSTEM_HTML)) {
        const html = fs.readFileSync(DESIGN_SYSTEM_HTML, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    // Serve dashboard HTML (always re-read for hot reload)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(html);
    }
    // ── Route table dispatch (simple GET routes) ──────────────────────────────
    else if (ROUTE_TABLE.has(routeKey(req.method, url.pathname))) {
      await ROUTE_TABLE.get(routeKey(req.method, url.pathname))(req, res, url);
    }
    // ── Complex routes (body parsing, SSE, multi-step logic) ──────────────────
    else if (url.pathname === '/api/agents' && req.method === 'DELETE') {
      const body = await parseBody(req);
      if (!body.name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing agent name' }));
        return;
      }
      const agentName = body.name;
      const dataDir = resolveDataDir(url.searchParams.get('project'));
      const agentsFile = path.join(dataDir, 'agents.json');
      const profilesFile = path.join(dataDir, 'profiles.json');
      await withFileLock(agentsFile, () => {
        // Remove from agents.json
        if (fs.existsSync(agentsFile)) {
          const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
          if (!agents[agentName]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not found: ' + agentName }));
            return;
          }
          delete agents[agentName];
          fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
        }
        // Remove from profiles.json
        if (fs.existsSync(profilesFile)) {
          const profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
          delete profiles[agentName];
          fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2));
        }
        // Remove consumed file
        const consumedFile = path.join(dataDir, 'consumed-' + agentName + '.json');
        if (fs.existsSync(consumedFile)) fs.unlinkSync(consumedFile);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, removed: agentName }));
      });
    }
    // Respawn prompt generator — creates copy-paste prompt to revive a dead agent
    else if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/respawn-prompt') && req.method === 'GET') {
      const agentName = decodeURIComponent(url.pathname.split('/')[3]);
      // Validate agent name (prevent path traversal)
      if (!agentName || /[^a-zA-Z0-9_-]/.test(agentName) || agentName.length > 20) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid agent name' }));
        return;
      }
      const projectPath = url.searchParams.get('project') || null;
      const dataDir = resolveDataDir(projectPath);
      const agents = readJson(filePath('agents.json', projectPath));
      const profiles = readJson(filePath('profiles.json', projectPath));
      const tasks = readJson(filePath('tasks.json', projectPath));
      const config = readJson(filePath('config.json', projectPath));

      if (!agents[agentName]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found: ' + agentName }));
        return;
      }

      // Gather recovery snapshot if exists
      const recoveryFile = path.join(dataDir, 'recovery-' + agentName + '.json');
      const recovery = fs.existsSync(recoveryFile) ? readJson(recoveryFile) : null;

      // Gather profile
      const profile = profiles[agentName] || {};

      // Gather active tasks assigned to this agent
      const taskList = Array.isArray(tasks) ? tasks : [];
      const activeTasks = taskList.filter(t => t.assignee === agentName && (t.status === 'in_progress' || t.status === 'pending'));
      const completedTasks = taskList.filter(t => t.assignee === agentName && t.status === 'done').slice(-5);

      // Gather recent history context (last 15 messages)
      const history = readJsonl(filePath('history.jsonl', projectPath));
      const recentHistory = history.slice(-15).map(m => `[${m.from}→${m.to}]: ${(m.content || '').substring(0, 150)}`).join('\n');

      // Gather who's online
      const onlineAgents = Object.entries(agents)
        .filter(([n, a]) => isPidAlive(a.pid, a.last_activity) && n !== agentName)
        .map(([n]) => n);

      // Gather workspace status
      let workspaceStatus = '';
      try {
        const wsPath = path.join(dataDir, 'workspaces', agentName + '.json');
        if (fs.existsSync(wsPath)) {
          const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
          if (ws._status) workspaceStatus = ws._status;
        }
      } catch {}

      // Build the respawn prompt
      const mode = config.conversation_mode || 'group';
      let prompt = `You are resuming as agent "${agentName}" in a multi-agent team using Neohive (MCP agent bridge).\n\n`;

      if (profile.role) prompt += `**Your role:** ${profile.role}\n`;
      if (profile.bio) prompt += `**Your bio:** ${profile.bio}\n`;
      prompt += '\n';

      prompt += `**Conversation mode:** ${mode}\n`;
      prompt += `**Agents currently online:** ${onlineAgents.length > 0 ? onlineAgents.join(', ') : 'none'}\n\n`;

      if (activeTasks.length > 0) {
        prompt += `**Your active tasks:**\n`;
        for (const t of activeTasks) {
          prompt += `- [${t.status}] ${t.title}${t.description ? ' — ' + t.description.substring(0, 200) : ''}\n`;
        }
        prompt += '\n';
      }

      if (completedTasks.length > 0) {
        prompt += `**Tasks you completed before disconnect:**\n`;
        for (const t of completedTasks) {
          prompt += `- ${t.title}\n`;
        }
        prompt += '\n';
      }

      if (recovery) {
        if (recovery.locked_files && recovery.locked_files.length > 0) {
          prompt += `**Files you had locked:** ${recovery.locked_files.join(', ')} — unlock these or continue editing them.\n\n`;
        }
        if (recovery.channels && recovery.channels.length > 0) {
          prompt += `**Channels you were in:** ${recovery.channels.join(', ')}\n\n`;
        }
        if (recovery.decisions_made && recovery.decisions_made.length > 0) {
          prompt += `**Decisions you made:**\n`;
          for (const d of recovery.decisions_made) {
            prompt += `- ${d.decision}${d.reasoning ? ' (reason: ' + d.reasoning + ')' : ''}\n`;
          }
          prompt += '\n';
        }
        if (recovery.last_messages_sent && recovery.last_messages_sent.length > 0) {
          prompt += `**Your last messages before disconnect:**\n`;
          for (const m of recovery.last_messages_sent) {
            prompt += `- [→${m.to}]: ${m.content}\n`;
          }
          prompt += '\n';
        }
      }

      if (workspaceStatus) {
        prompt += `**Your last status:** ${workspaceStatus}\n\n`;
      }

      prompt += `**Recent team conversation:**\n${recentHistory}\n\n`;

      prompt += `**Instructions:**\n`;
      prompt += `1. Register as "${agentName}" using the register tool\n`;
      prompt += `2. Call get_briefing() for full project context\n`;
      prompt += `3. Call listen_group() to rejoin the conversation\n`;
      prompt += `4. Announce you're back and pick up your active tasks\n`;
      prompt += `5. Stay in listen_group() loop — never stop listening\n`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agent: agentName,
        status: isPidAlive(agents[agentName].pid, agents[agentName].last_activity) ? 'alive' : 'dead',
        prompt,
        prompt_length: prompt.length,
        has_recovery: !!recovery,
        active_tasks: activeTasks.length,
        online_agents: onlineAgents,
      }));
    }
    else if (url.pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiStatus(url.searchParams)));
    }
    else if (url.pathname === '/api/stats' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiStats(url.searchParams)));
    }
    else if (url.pathname === '/api/token-usage' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiTokenUsage(url.searchParams)));
    }
    else if (url.pathname === '/api/coordinator-mode' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const config = readJson(filePath('config.json', projectPath));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode: config.coordinator_mode || 'responsive' }));
    }
    else if (url.pathname === '/api/coordinator-mode' && req.method === 'POST') {
      try {
        const body = await parseBody(req).catch(() => ({}));
        const newMode = body.mode;
        if (!newMode || !['responsive', 'autonomous'].includes(newMode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mode must be "responsive" or "autonomous"' }));
          return;
        }
        const projectPath = url.searchParams.get('project') || null;
        const dataDir = resolveDataDir(projectPath);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        const configFile = filePath('config.json', projectPath);
        await withFileLock(configFile, () => {
          const config = readJson(configFile);
          config.coordinator_mode = newMode;
          fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        });
        // Broadcast mode change to all agents + direct message to lead agents
        try {
          const messagesFile = filePath('messages.jsonl', projectPath);
          const historyFile = filePath('history.jsonl', projectPath);
          const modeText = newMode === 'responsive' ? 'Coordinator stays with human, uses consume_messages().' : 'Coordinator runs autonomously in listen() loop.';
          const sysMsg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), from: '__system__', to: '__group__', content: `[MODE] Coordinator mode changed to "${newMode}". ${modeText} Coordinator: call get_guide() to update your instructions.`, timestamp: new Date().toISOString(), system: true };
          fs.appendFileSync(messagesFile, JSON.stringify(sysMsg) + '\n');
          fs.appendFileSync(historyFile, JSON.stringify(sysMsg) + '\n');
          // Also send direct message to lead/coordinator agents so listen() in direct mode picks it up
          const profiles = readJson(filePath('profiles.json', projectPath));
          for (const [agentName, prof] of Object.entries(profiles)) {
            const role = (prof.role || '').toLowerCase();
            if (role === 'lead' || role === 'manager' || role === 'coordinator') {
              const directMsg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), from: '__system__', to: agentName, content: `[MODE CHANGE] Coordinator mode switched to "${newMode}". ${modeText} Call get_guide() now to update your instructions.`, timestamp: new Date().toISOString(), system: true };
              fs.appendFileSync(messagesFile, JSON.stringify(directMsg) + '\n');
              fs.appendFileSync(historyFile, JSON.stringify(directMsg) + '\n');
            }
          }
        } catch (e) { /* broadcast is best-effort */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mode: newMode }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to set coordinator mode: ' + e.message }));
      }
    }
    else if (url.pathname === '/api/reset' && req.method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      if (!body.confirm) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Destructive action requires { "confirm": true } in request body' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiReset(url.searchParams)));
    }
    else if (url.pathname === '/api/clear-messages' && req.method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      if (!body.confirm) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Destructive action requires { "confirm": true } in request body' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiClearMessages(url.searchParams)));
    }
    else if (url.pathname === '/api/new-conversation' && req.method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      if (!body.confirm) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Destructive action requires { "confirm": true } in request body' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiNewConversation(url.searchParams)));
    }
    else if (url.pathname === '/api/conversations' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiListConversations(url.searchParams)));
    }
    else if (url.pathname === '/api/load-conversation' && req.method === 'POST') {
      const result = apiLoadConversation(url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // Message injection
    else if (url.pathname === '/api/inject' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = apiInjectMessage(body, url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // Multi-project management
    else if (url.pathname === '/api/projects' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiProjects()));
    }
    else if (url.pathname === '/api/projects' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = apiAddProject(body);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    else if (url.pathname === '/api/timeline' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiTimeline(url.searchParams)));
    }
    else if (url.pathname === '/api/tasks' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiTasks(url.searchParams)));
    }
    else if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = apiUpdateTask(body, url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    else if (url.pathname === '/api/tasks' && req.method === 'PUT') {
      const body = await parseBody(req);
      if (!body.task_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing task_id' }));
        return;
      }
      const projectPath = url.searchParams.get('project') || null;
      const tasksDir = resolveTasksWorkflowsDataDir(projectPath);
      const tasksFile = path.join(tasksDir, 'tasks.json');
      const msgDir = resolveDataDir(projectPath);
      let tasks = [];
      if (fs.existsSync(tasksFile)) try { tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch {}
      const task = tasks.find(t => t.id === body.task_id);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      const oldAssignee = task.assignee;
      const msgFile = path.join(msgDir, 'messages.jsonl');
      const histFile = path.join(msgDir, 'history.jsonl');
      // Apply edits
      if (body.title !== undefined) task.title = body.title;
      if (body.description !== undefined) task.description = body.description;
      if (body.assignee !== undefined) task.assignee = body.assignee;
      task.updated_at = new Date().toISOString();
      fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
      // Notify agents on changes
      const writeMsg = (to, content) => {
        const msg = JSON.stringify({ id: 'sys_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5), from: '__system__', to, content, timestamp: new Date().toISOString(), system: true }) + '\n';
        try { fs.appendFileSync(msgFile, msg); fs.appendFileSync(histFile, msg); } catch {}
      };
      if (body.assignee !== undefined && body.assignee !== oldAssignee) {
        if (body.assignee) writeMsg(body.assignee, '[TASK ASSIGNED] Task "' + task.title + '" assigned to you');
        if (oldAssignee) writeMsg(oldAssignee, '[TASK REASSIGNED] Task "' + task.title + '" reassigned to ' + (body.assignee || 'unassigned'));
      } else if (body.description !== undefined && task.assignee) {
        writeMsg(task.assignee, '[TASK UPDATED] Task "' + task.title + '" description updated');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, task_id: task.id }));
    }
    else if (url.pathname === '/api/tasks' && req.method === 'DELETE') {
      const body = await parseBody(req);
      if (!body.task_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing task_id' }));
        return;
      }
      const projectPath = url.searchParams.get('project') || null;
      const tasksDir = resolveTasksWorkflowsDataDir(projectPath);
      const tasksFile = path.join(tasksDir, 'tasks.json');
      const msgDir = resolveDataDir(projectPath);
      let tasks = [];
      if (fs.existsSync(tasksFile)) try { tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch {}
      const idx = tasks.findIndex(t => t.id === body.task_id);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      const removed = tasks.splice(idx, 1)[0];
      fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
      // Write system message about deletion
      const msgFile = path.join(msgDir, 'messages.jsonl');
      const histFile = path.join(msgDir, 'history.jsonl');
      const sysMsg = JSON.stringify({ id: 'sys_' + Date.now().toString(36), from: '__system__', to: '__all__', content: '[TASK DELETED] Task "' + (removed.title || '') + '" was removed', timestamp: new Date().toISOString(), system: true }) + '\n';
      try { fs.appendFileSync(msgFile, sysMsg); fs.appendFileSync(histFile, sysMsg); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, removed: removed.title }));
    }
    else if (url.pathname === '/api/rules' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiRules(url.searchParams)));
    }
    else if (url.pathname === '/api/rules' && req.method === 'POST') {
      const body = await parseBody(req);
      const action = body.action || 'add';
      let result;
      if (action === 'add') result = apiAddRule(body, url.searchParams);
      else if (action === 'update') result = apiUpdateRule(body, url.searchParams);
      else if (action === 'delete') result = apiDeleteRule(body, url.searchParams);
      else result = { error: 'Unknown action. Use: add, update, delete' };
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    else if (url.pathname === '/api/audit-log' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiAuditLog(url.searchParams)));
    }
    else if (url.pathname === '/api/search' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const query = (url.searchParams.get('q') || '').trim();
      const from = url.searchParams.get('from') || null;
      const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)), 100);
      if (query.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query must be at least 2 characters' }));
        return;
      }
      // Search general history + all channel histories
      let allHistory = readJsonl(filePath('history.jsonl', projectPath));
      const dataDir = resolveDataDir(projectPath);
      try {
        const files = fs.readdirSync(dataDir);
        for (const f of files) {
          if (f.startsWith('channel-') && f.endsWith('-history.jsonl')) {
            allHistory = allHistory.concat(readJsonl(path.join(dataDir, f)));
          }
        }
      } catch {}
      const queryLower = query.toLowerCase();
      const results = [];
      for (let i = allHistory.length - 1; i >= 0 && results.length < limit; i--) {
        const m = allHistory[i];
        if (from && m.from !== from) continue;
        if (m.content && m.content.toLowerCase().includes(queryLower)) {
          results.push({
            id: m.id, from: m.from, to: m.to,
            preview: m.content.substring(0, 200),
            timestamp: m.timestamp,
            ...(m.channel && { channel: m.channel }),
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query, results_count: results.length, results }));
    }
    else if (url.pathname === '/api/export-json' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const history = apiHistory(url.searchParams);
      const agents = apiAgents(url.searchParams);
      const decisions = readJson(filePath('decisions.json', projectPath)) || [];
      const tasksRaw = readJson(filePath('tasks.json', projectPath));
      const tasks = Array.isArray(tasksRaw) ? tasksRaw : (tasksRaw && tasksRaw.tasks ? tasksRaw.tasks : []);
      const channels = apiChannels(url.searchParams);
      const pkg = readJson(path.join(__dirname, 'package.json')) || {};
      const result = {
        export_version: 1,
        exported_at: new Date().toISOString(),
        project: projectPath || process.cwd(),
        version: pkg.version || 'unknown',
        summary: {
          message_count: history.length,
          agent_count: Object.keys(agents).length,
          decision_count: decisions.length,
          task_count: tasks.length,
          channel_count: Object.keys(channels).length,
          time_range: history.length > 0 ? {
            start: history[0].timestamp,
            end: history[history.length - 1].timestamp,
          } : null,
        },
        agents,
        channels,
        decisions,
        tasks,
        messages: history,
      };
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="conversation-' + new Date().toISOString().slice(0, 10) + '-full.json"',
      });
      res.end(JSON.stringify(result, null, 2));
    }
    else if (url.pathname === '/api/export' && req.method === 'GET') {
      const html = apiExportHtml(url.searchParams);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="conversation-' + new Date().toISOString().slice(0, 10) + '.html"',
      });
      res.end(html);
    }
    else if (url.pathname === '/api/discover' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiDiscover()));
    }
    // --- GitHub Projects sync ---
    else if (url.pathname === '/api/github-sync' && req.method === 'GET') {
      try {
        const ghSync = require('./lib/github-sync');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ghSync.getSyncStatus()));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    }
    else if (url.pathname === '/api/github-sync' && req.method === 'POST') {
      try {
        const ghSync = require('./lib/github-sync');
        const body = await parseBody(req);
        if (body.action === 'discover') {
          const result = await ghSync.discoverFields();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          const result = await ghSync.syncAllTasks();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    }
    // --- v3.0 API endpoints ---
    else if (url.pathname === '/api/profiles' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readJson(filePath('profiles.json', projectPath))));
    }
    else if (url.pathname === '/api/profiles' && req.method === 'POST') {
      const body = await parseBody(req);
      const projectPath = url.searchParams.get('project') || null;
      const profilesFile = filePath('profiles.json', projectPath);
      const profiles = readJson(profilesFile);
      if (!body.agent || !/^[a-zA-Z0-9_-]{1,20}$/.test(body.agent)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid agent name' })); return; }
      if (!profiles[body.agent]) profiles[body.agent] = {};
      if (body.display_name) profiles[body.agent].display_name = body.display_name.substring(0, 30);
      if (body.avatar) {
        if (body.avatar.length > 65536) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Avatar too large (max 64KB)' })); return; }
        profiles[body.agent].avatar = body.avatar;
      }
      if (body.bio !== undefined) profiles[body.agent].bio = (body.bio || '').substring(0, 200);
      if (body.role !== undefined) profiles[body.agent].role = (body.role || '').substring(0, 30);
      profiles[body.agent].updated_at = new Date().toISOString();
      fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }
    else if (url.pathname === '/api/agent-cards' && req.method === 'POST') {
      const body = await parseBody(req);
      const projectPath = url.searchParams.get('project') || null;
      const cardsFile = filePath('agent-cards.json', projectPath);
      const cards = readJson(cardsFile);
      if (!body.name || !/^[a-zA-Z0-9_-]{1,20}$/.test(body.name)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid agent name' }));
        return;
      }
      if (body.skills !== undefined && !Array.isArray(body.skills)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'skills must be an array' }));
        return;
      }
      if (!cards[body.name]) cards[body.name] = {};
      if (body.skills !== undefined) {
        cards[body.name].skills = body.skills.map(s => String(s).toLowerCase().substring(0, 50));
      }
      fs.writeFileSync(cardsFile, JSON.stringify(cards, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }
    else if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const agentParam = url.searchParams.get('agent');
      if (agentParam && !/^[a-zA-Z0-9_-]{1,20}$/.test(agentParam)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid agent name' }));
        return;
      }
      const dataDir = resolveDataDir(projectPath);
      const wsDir = path.join(dataDir, 'workspaces');
      const result = {};
      if (agentParam) {
        const wsFile = path.join(wsDir, agentParam + '.json');
        result[agentParam] = fs.existsSync(wsFile) ? readJson(wsFile) : {};
      } else if (fs.existsSync(wsDir)) {
        for (const f of fs.readdirSync(wsDir).filter(x => x.endsWith('.json'))) {
          const name = f.replace('.json', '');
          result[name] = readJson(path.join(wsDir, f));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    else if (url.pathname === '/api/notifications' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const notifFile = filePath('notifications.json', projectPath);
      const notifs = fs.existsSync(notifFile) ? JSON.parse(fs.readFileSync(notifFile, 'utf8')) : [];
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(notifs.slice(-limit)));
    }
    else if (url.pathname === '/api/workflows' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fs.existsSync(wfFile) ? JSON.parse(fs.readFileSync(wfFile, 'utf8')) : []));
    }
    else if (url.pathname === '/api/workflows' && req.method === 'DELETE') {
      const body = await parseBody(req);
      if (!body.workflow_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing workflow_id' }));
        return;
      }
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      const idx = workflows.findIndex(w => w.id === body.workflow_id);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Workflow not found' }));
        return;
      }
      const removed = workflows.splice(idx, 1)[0];
      fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, removed: removed.name }));
    }
    else if (url.pathname === '/api/workflows' && req.method === 'POST') {
      const body = await parseBody(req);
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      if (body.action === 'advance' && body.workflow_id) {
        const wf = workflows.find(w => w.id === body.workflow_id);
        if (!wf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Workflow not found' })); return; }
        const curr = wf.steps.find(s => s.status === 'in_progress');
        if (curr) { curr.status = 'done'; curr.completed_at = new Date().toISOString(); if (body.notes) curr.notes = body.notes; }
        const next = wf.steps.find(s => s.status === 'pending');
        if (next) { next.status = 'in_progress'; next.started_at = new Date().toISOString(); } else { wf.status = 'completed'; }
        wf.updated_at = new Date().toISOString();
        fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      } else if (body.action === 'skip' && body.workflow_id && body.step_id) {
        const wf = workflows.find(w => w.id === body.workflow_id);
        if (!wf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Workflow not found' })); return; }
        const step = wf.steps.find(s => s.id === body.step_id);
        if (step) { step.status = 'done'; step.notes = 'Skipped from dashboard'; step.completed_at = new Date().toISOString(); }
        const next = wf.steps.find(s => s.status === 'pending');
        if (next && !wf.steps.find(s => s.status === 'in_progress')) { next.status = 'in_progress'; next.started_at = new Date().toISOString(); }
        if (!wf.steps.find(s => s.status === 'pending' || s.status === 'in_progress')) wf.status = 'completed';
        wf.updated_at = new Date().toISOString();
        fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      } else if (body.action === 'approve' && body.workflow_id && body.step_id !== undefined) {
        const wf = workflows.find(w => w.id === body.workflow_id);
        if (!wf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Workflow not found' })); return; }
        const step = wf.steps.find(s => s.id === body.step_id);
        if (!step || step.status !== 'awaiting_approval') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Step not awaiting approval' })); return; }
        if (body.approved) {
          step.status = 'in_progress';
          step.started_at = new Date().toISOString();
          step.approved_at = new Date().toISOString();
          step.approved_by = '__user__';
          // Notify assignee via message
          const messagesFile = filePath('messages.jsonl', projectPath);
          const historyFile = filePath('history.jsonl', projectPath);
          const notif = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), from: '__user__', to: step.assignee || '__group__', content: `[APPROVED] Step "${step.description}" in workflow "${wf.name}" has been approved. You may proceed.`, timestamp: new Date().toISOString() };
          fs.appendFileSync(messagesFile, JSON.stringify(notif) + '\n');
          fs.appendFileSync(historyFile, JSON.stringify(notif) + '\n');
        } else {
          step.status = 'pending';
          step.rejected_at = new Date().toISOString();
          step.rejection_feedback = body.feedback || '';
          const messagesFile = filePath('messages.jsonl', projectPath);
          const historyFile = filePath('history.jsonl', projectPath);
          const notif = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), from: '__user__', to: step.assignee || '__group__', content: `[REJECTED] Step "${step.description}" rejected: ${body.feedback || 'No feedback'}`, timestamp: new Date().toISOString() };
          fs.appendFileSync(messagesFile, JSON.stringify(notif) + '\n');
          fs.appendFileSync(historyFile, JSON.stringify(notif) + '\n');
        }
        wf.updated_at = new Date().toISOString();
        fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid action' })); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }
    // ========== Plan Control API (v6.0 Autonomy Engine) ==========

    else if (url.pathname === '/api/plan/status' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      const agentsFile = filePath('agents.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      const agents = fs.existsSync(agentsFile) ? readJson(agentsFile) : {};

      // Find the active autonomous workflow (most recent)
      const activeWf = workflows.filter(w => w.status === 'active' && w.autonomous).pop()
                    || workflows.filter(w => w.status === 'active').pop();

      if (!activeWf) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false, message: 'No active plan' }));
        return;
      }

      const doneSteps = activeWf.steps.filter(s => s.status === 'done').length;
      const totalSteps = activeWf.steps.length;
      const elapsed = Date.now() - new Date(activeWf.created_at).getTime();
      const activeAgents = Object.entries(agents).filter(([, a]) => {
        const idle = Date.now() - new Date(a.last_activity || 0).getTime();
        return idle < 120000;
      }).length;

      const retryCount = activeWf.steps.filter(s => s.flagged).length;
      const avgConfidence = activeWf.steps.filter(s => s.verification && s.verification.confidence)
        .reduce((sum, s, _, arr) => sum + s.verification.confidence / arr.length, 0);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        active: true,
        workflow_id: activeWf.id,
        name: activeWf.name,
        status: activeWf.status,
        autonomous: !!activeWf.autonomous,
        parallel: !!activeWf.parallel,
        paused: !!activeWf.paused,
        progress: { done: doneSteps, total: totalSteps, percent: Math.round((doneSteps / totalSteps) * 100) },
        elapsed_ms: elapsed,
        elapsed_human: Math.round(elapsed / 60000) + 'm',
        agents_active: activeAgents,
        steps: activeWf.steps.map(s => ({
          id: s.id, description: s.description, assignee: s.assignee,
          status: s.status, depends_on: s.depends_on || [],
          started_at: s.started_at, completed_at: s.completed_at,
          flagged: !!s.flagged, flag_reason: s.flag_reason || null,
          confidence: s.verification ? s.verification.confidence : null,
          verification: s.verification || null,
        })),
        retries: retryCount,
        avg_confidence: Math.round(avgConfidence) || null,
        created_at: activeWf.created_at,
      }));
    }

    else if (url.pathname === '/api/plan/pause' && req.method === 'POST') {
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      const activeWf = workflows.find(w => w.status === 'active' && w.autonomous);
      if (!activeWf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No active autonomous plan' })); return; }
      activeWf.paused = true;
      activeWf.paused_at = new Date().toISOString();
      activeWf.updated_at = new Date().toISOString();
      fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      // Notify agents
      apiInjectMessage({ to: '__all__', content: `[PLAN PAUSED] "${activeWf.name}" has been paused by the dashboard. Finish your current step, then wait for resume.` }, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Plan paused', workflow_id: activeWf.id }));
    }

    else if (url.pathname === '/api/plan/resume' && req.method === 'POST') {
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      const pausedWf = workflows.find(w => w.status === 'active' && w.paused);
      if (!pausedWf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No paused plan' })); return; }
      pausedWf.paused = false;
      delete pausedWf.paused_at;
      pausedWf.updated_at = new Date().toISOString();
      fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      apiInjectMessage({ to: '__all__', content: `[PLAN RESUMED] "${pausedWf.name}" has been resumed. Call get_work() to continue.` }, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Plan resumed', workflow_id: pausedWf.id }));
    }

    else if (url.pathname === '/api/plan/stop' && req.method === 'POST') {
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      const activeWf = workflows.find(w => w.status === 'active');
      if (!activeWf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No active plan' })); return; }
      activeWf.status = 'stopped';
      activeWf.stopped_at = new Date().toISOString();
      activeWf.updated_at = new Date().toISOString();
      fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      apiInjectMessage({ to: '__all__', content: `[PLAN STOPPED] "${activeWf.name}" has been stopped by the dashboard. All work on this plan should cease.` }, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Plan stopped', workflow_id: activeWf.id }));
    }

    else if (url.pathname.startsWith('/api/plan/skip/') && req.method === 'POST') {
      const stepId = parseInt(url.pathname.split('/').pop(), 10);
      const body = await parseBody(req);
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      const wfId = body.workflow_id;
      const wf = wfId ? workflows.find(w => w.id === wfId) : workflows.find(w => w.status === 'active');
      if (!wf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Workflow not found' })); return; }
      const step = wf.steps.find(s => s.id === stepId);
      if (!step) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Step not found: ' + stepId })); return; }
      step.status = 'done';
      step.notes = (step.notes || '') + ' [Skipped from dashboard]';
      step.completed_at = new Date().toISOString();
      step.skipped = true;
      // Start any newly ready steps
      const readySteps = wf.steps.filter(s => {
        if (s.status !== 'pending') return false;
        if (!s.depends_on || s.depends_on.length === 0) return true;
        return s.depends_on.every(depId => { const d = wf.steps.find(x => x.id === depId); return d && d.status === 'done'; });
      });
      for (const rs of readySteps) { rs.status = 'in_progress'; rs.started_at = new Date().toISOString(); }
      if (!wf.steps.find(s => s.status === 'pending' || s.status === 'in_progress')) wf.status = 'completed';
      wf.updated_at = new Date().toISOString();
      fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, skipped_step: stepId, ready_steps: readySteps.map(s => s.id) }));
    }

    else if (url.pathname.startsWith('/api/plan/reassign/') && req.method === 'POST') {
      const stepId = parseInt(url.pathname.split('/').pop(), 10);
      const body = await parseBody(req);
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      if (!body.new_assignee) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'new_assignee required' })); return; }
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      const wfId = body.workflow_id;
      const wf = wfId ? workflows.find(w => w.id === wfId) : workflows.find(w => w.status === 'active');
      if (!wf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Workflow not found' })); return; }
      const step = wf.steps.find(s => s.id === stepId);
      if (!step) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Step not found: ' + stepId })); return; }
      const oldAssignee = step.assignee;
      step.assignee = body.new_assignee;
      wf.updated_at = new Date().toISOString();
      fs.writeFileSync(wfFile, JSON.stringify(workflows, null, 2));
      apiInjectMessage({ to: body.new_assignee, content: `[REASSIGNED] Step ${stepId} "${step.description}" has been reassigned from ${oldAssignee || 'unassigned'} to you. ${step.status === 'in_progress' ? 'This step is IN PROGRESS — pick it up now.' : 'This step is ' + step.status + '.'}` }, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, step_id: stepId, old_assignee: oldAssignee, new_assignee: body.new_assignee }));
    }

    else if (url.pathname === '/api/plan/inject' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.content) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'content required' })); return; }
      const result = apiInjectMessage({ to: body.to || '__all__', content: body.content }, url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }

    else if (url.pathname === '/api/plan/report' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const wfFile = filePath('workflows.json', projectPath);
      const kbFile = filePath('kb.json', projectPath);
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      // Get most recent completed or active workflow
      const wf = workflows.filter(w => w.status === 'completed').pop() || workflows.filter(w => w.status === 'active').pop();
      if (!wf) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No plan found' })); return; }

      const doneSteps = wf.steps.filter(s => s.status === 'done');
      const flaggedSteps = wf.steps.filter(s => s.flagged);
      const duration = wf.completed_at ? new Date(wf.completed_at) - new Date(wf.created_at) : Date.now() - new Date(wf.created_at).getTime();
      const avgConf = doneSteps.filter(s => s.verification && s.verification.confidence)
        .reduce((sum, s, _, arr) => sum + s.verification.confidence / arr.length, 0);

      // Count skills learned during this plan
      let skillCount = 0;
      if (fs.existsSync(kbFile)) {
        try {
          const kb = JSON.parse(fs.readFileSync(kbFile, 'utf8'));
          skillCount = Object.keys(kb).filter(k => k.startsWith('skill_') || k.startsWith('lesson_')).length;
        } catch {}
      }

      // Agent-level performance analytics
      const agentStats = {};
      for (const s of wf.steps) {
        if (!s.assignee) continue;
        if (!agentStats[s.assignee]) agentStats[s.assignee] = { steps: 0, completed: 0, flagged: 0, total_ms: 0, confidences: [] };
        agentStats[s.assignee].steps++;
        if (s.status === 'done') {
          agentStats[s.assignee].completed++;
          if (s.completed_at && s.started_at) agentStats[s.assignee].total_ms += new Date(s.completed_at) - new Date(s.started_at);
          if (s.verification && s.verification.confidence) agentStats[s.assignee].confidences.push(s.verification.confidence);
        }
        if (s.flagged) agentStats[s.assignee].flagged++;
      }
      const agentPerformance = Object.entries(agentStats).map(([name, stats]) => ({
        agent: name, steps_assigned: stats.steps, steps_completed: stats.completed, steps_flagged: stats.flagged,
        avg_duration_ms: stats.completed > 0 ? Math.round(stats.total_ms / stats.completed) : null,
        avg_confidence: stats.confidences.length > 0 ? Math.round(stats.confidences.reduce((a, b) => a + b, 0) / stats.confidences.length) : null,
      }));

      // Slowest/fastest steps
      const stepsWithDuration = wf.steps.filter(s => s.completed_at && s.started_at)
        .map(s => ({ id: s.id, description: s.description, assignee: s.assignee, duration_ms: new Date(s.completed_at) - new Date(s.started_at) }))
        .sort((a, b) => b.duration_ms - a.duration_ms);

      // Retry count from workspace data
      let retryCount = 0;
      const wsDir = path.join(resolveDataDir(projectPath), 'workspaces');
      if (fs.existsSync(wsDir)) {
        for (const file of fs.readdirSync(wsDir)) {
          try {
            const ws = JSON.parse(fs.readFileSync(path.join(wsDir, file), 'utf8'));
            if (ws.retry_history) {
              const history = typeof ws.retry_history === 'string' ? JSON.parse(ws.retry_history) : ws.retry_history;
              if (Array.isArray(history)) retryCount += history.length;
            }
          } catch {}
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: wf.name,
        status: wf.status,
        steps_done: doneSteps.length,
        steps_total: wf.steps.length,
        duration_ms: duration,
        duration_human: Math.round(duration / 60000) + 'm',
        avg_confidence: Math.round(avgConf) || null,
        flagged_steps: flaggedSteps.map(s => ({ id: s.id, description: s.description, reason: s.flag_reason })),
        skills_learned: skillCount,
        retries: retryCount,
        agent_performance: agentPerformance,
        slowest_step: stepsWithDuration[0] || null,
        fastest_step: stepsWithDuration[stepsWithDuration.length - 1] || null,
        steps: wf.steps.map(s => ({
          id: s.id, description: s.description, assignee: s.assignee,
          status: s.status, confidence: s.verification ? s.verification.confidence : null,
          duration_ms: s.completed_at && s.started_at ? new Date(s.completed_at) - new Date(s.started_at) : null,
          flagged: !!s.flagged, skipped: !!s.skipped,
        })),
        created_at: wf.created_at,
        completed_at: wf.completed_at || null,
      }));
    }

    else if (url.pathname === '/api/plan/skills' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const kbFile = filePath('kb.json', projectPath);
      let skills = [];
      if (fs.existsSync(kbFile)) {
        try {
          const kb = JSON.parse(fs.readFileSync(kbFile, 'utf8'));
          for (const [key, val] of Object.entries(kb)) {
            if (key.startsWith('skill_') || key.startsWith('lesson_')) {
              skills.push({ key, content: val.content, learned_by: val.updated_by, learned_at: val.updated_at });
            }
          }
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: skills.length, skills }));
    }

    else if (url.pathname === '/api/plan/retries' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const dataDir = resolveDataDir(projectPath);
      const wsDir = path.join(dataDir, 'workspaces');
      let retries = [];
      if (fs.existsSync(wsDir)) {
        for (const file of fs.readdirSync(wsDir)) {
          try {
            const ws = JSON.parse(fs.readFileSync(path.join(wsDir, file), 'utf8'));
            if (ws.retry_history) {
              const agent = file.replace('.json', '');
              const history = typeof ws.retry_history === 'string' ? JSON.parse(ws.retry_history) : ws.retry_history;
              if (Array.isArray(history)) {
                for (const entry of history) { retries.push({ agent, ...entry }); }
              }
            }
          } catch {}
        }
      }
      retries.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: retries.length, retries }));
    }

    // ========== Monitor Agent API ==========

    else if (url.pathname === '/api/monitor/health' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const dataDir = resolveDataDir(projectPath);
      const agentsFile = filePath('agents.json', projectPath);
      const wfFile = filePath('workflows.json', projectPath);
      const profilesFile = filePath('profiles.json', projectPath);
      const tasksFile = filePath('tasks.json', projectPath);

      const agents = fs.existsSync(agentsFile) ? readJson(agentsFile) : {};
      const profiles = fs.existsSync(profilesFile) ? readJson(profilesFile) : {};
      let workflows = [];
      if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      let tasks = [];
      if (fs.existsSync(tasksFile)) try { tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch {}

      // Find monitor agent
      const monitorName = Object.entries(profiles).find(([, p]) => p.role === 'monitor');
      const now = Date.now();

      // Agent health summary
      const agentHealth = Object.entries(agents).map(([name, a]) => {
        const idle = now - new Date(a.last_activity || 0).getTime();
        return { name, idle_ms: idle, idle_human: Math.round(idle / 1000) + 's', status: idle > 120000 ? 'idle' : idle > 600000 ? 'stuck' : 'active', role: profiles[name] ? profiles[name].role : null };
      });

      const idleAgents = agentHealth.filter(a => a.status === 'idle').length;
      const stuckAgents = agentHealth.filter(a => a.status === 'stuck').length;
      const activeWorkflows = workflows.filter(w => w.status === 'active').length;
      const pendingTasks = tasks.filter(t => t.status === 'pending').length;
      const blockedTasks = tasks.filter(t => t.status === 'blocked' || t.status === 'blocked_permanent').length;

      // Monitor intervention log from workspace
      let interventions = [];
      const wsDir = path.join(dataDir, 'workspaces');
      if (monitorName && fs.existsSync(wsDir)) {
        const monFile = path.join(wsDir, monitorName[0] + '.json');
        if (fs.existsSync(monFile)) {
          try {
            const ws = JSON.parse(fs.readFileSync(monFile, 'utf8'));
            if (ws._monitor_log) interventions = typeof ws._monitor_log === 'string' ? JSON.parse(ws._monitor_log) : ws._monitor_log;
          } catch {}
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        monitor: monitorName ? { name: monitorName[0], active: true } : { active: false },
        health: {
          total_agents: Object.keys(agents).length,
          active: agentHealth.filter(a => a.status === 'active').length,
          idle: idleAgents,
          stuck: stuckAgents,
          active_workflows: activeWorkflows,
          pending_tasks: pendingTasks,
          blocked_tasks: blockedTasks,
        },
        agents: agentHealth,
        interventions: interventions.slice(-20),
        timestamp: new Date().toISOString(),
      }));
    }

    // ========== Reputation API ==========

    else if (url.pathname === '/api/reputation' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const repFile = filePath('reputation.json', projectPath);
      const rep = fs.existsSync(repFile) ? readJson(repFile) : {};

      // Calculate scores and build leaderboard
      const leaderboard = Object.entries(rep).map(([name, r]) => {
        const score = (r.tasks_completed || 0) * 2
          + (r.reviews_done || 0) * 1
          + (r.help_given || 0) * 3
          + (r.kb_contributions || 0) * 1
          - (r.retries || 0) * 1
          - (r.watchdog_nudges || 0) * 2;
        return {
          name, score,
          tasks_completed: r.tasks_completed || 0,
          reviews_done: r.reviews_done || 0,
          retries: r.retries || 0,
          watchdog_nudges: r.watchdog_nudges || 0,
          help_given: r.help_given || 0,
          strengths: r.strengths || [],
        };
      }).sort((a, b) => b.score - a.score);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ leaderboard, timestamp: new Date().toISOString() }));
    }

    // ========== System Stats API ==========

    else if (url.pathname === '/api/stats' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const dataDir = resolveDataDir(projectPath);
      const agentsFile = filePath('agents.json', projectPath);
      const wfFile = filePath('workflows.json', projectPath);
      const tasksFile = filePath('tasks.json', projectPath);
      const histFile = path.join(dataDir, 'history.jsonl');
      const kbFile = filePath('kb.json', projectPath);

      const agents = fs.existsSync(agentsFile) ? readJson(agentsFile) : {};
      let workflows = []; if (fs.existsSync(wfFile)) try { workflows = JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch {}
      let tasks = []; if (fs.existsSync(tasksFile)) try { tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch {}
      let msgCount = 0; if (fs.existsSync(histFile)) { try { const c = fs.readFileSync(histFile, 'utf8').trim(); if (c) msgCount = c.split(/\r?\n/).filter(l => l.trim()).length; } catch {} }
      let kbKeys = 0; if (fs.existsSync(kbFile)) try { kbKeys = Object.keys(JSON.parse(fs.readFileSync(kbFile, 'utf8'))).length; } catch {}

      const aliveCount = Object.values(agents).filter(a => { const idle = Date.now() - new Date(a.last_activity || 0).getTime(); return idle < 120000; }).length;
      const activeWf = workflows.filter(w => w.status === 'active');
      const completedWf = workflows.filter(w => w.status === 'completed');
      const tasksDone = tasks.filter(t => t.status === 'done').length;
      const tasksActive = tasks.filter(t => t.status === 'in_progress').length;

      // Heartbeat files count
      let hbCount = 0;
      try { hbCount = fs.readdirSync(dataDir).filter(f => f.startsWith('heartbeat-')).length; } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agents: { total: Math.max(Object.keys(agents).length, hbCount), alive: aliveCount },
        messages: { total: msgCount },
        tasks: { total: tasks.length, done: tasksDone, active: tasksActive, pending: tasks.length - tasksDone - tasksActive },
        workflows: { total: workflows.length, active: activeWf.length, completed: completedWf.length },
        active_plan: activeWf.length > 0 ? { name: activeWf[0].name, progress: activeWf[0].steps.filter(s => s.status === 'done').length + '/' + activeWf[0].steps.length } : null,
        knowledge_base: { entries: kbKeys },
        timestamp: new Date().toISOString(),
      }));
    }

    // ========== End Rules API ==========

    else if (url.pathname === '/api/branches' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const branchesFile = filePath('branches.json', projectPath);
      const dataDir = resolveDataDir(projectPath);
      let branches = fs.existsSync(branchesFile) ? readJson(branchesFile) : {};
      // Add message counts
      for (const [name, info] of Object.entries(branches)) {
        const histFile = name === 'main' ? path.join(dataDir, 'history.jsonl') : path.join(dataDir, `branch-${name}-history.jsonl`);
        let msgCount = 0;
        if (fs.existsSync(histFile)) {
          const content = fs.readFileSync(histFile, 'utf8').trim();
          if (content) msgCount = content.split(/\r?\n/).filter(l => l.trim()).length;
        }
        branches[name].message_count = msgCount;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(branches));
    }
    else if (url.pathname === '/api/projects' && req.method === 'DELETE') {
      const body = await parseBody(req);
      const result = apiRemoveProject(body);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // --- v3.4: Message Edit ---
    else if (url.pathname === '/api/message' && req.method === 'PUT') {
      const body = await parseBody(req);
      const result = await apiEditMessage(body, url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // --- v3.4: Message Delete ---
    else if (url.pathname === '/api/message' && req.method === 'DELETE') {
      const body = await parseBody(req);
      const result = await apiDeleteMessage(body, url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // --- v3.4: Conversation Templates ---
    else if (url.pathname === '/api/conversation-templates' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiGetConversationTemplates()));
    }
    else if (url.pathname === '/api/conversation-templates/launch' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = apiLaunchConversationTemplate(body, url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // --- Custom Templates CRUD ---
    else if (url.pathname === '/api/custom-templates' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      const templates = readJson(filePath('custom-templates.json', projectPath));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(templates) ? templates : []));
    }
    else if (url.pathname === '/api/custom-templates' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const projectPath = url.searchParams.get('project') || null;
        const ctFile = filePath('custom-templates.json', projectPath);
        const dataDir = resolveDataDir(projectPath);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        await withFileLock(ctFile, () => {
          const templates = readJson(ctFile);
          const list = Array.isArray(templates) ? templates : [];
          const id = body.id || ('custom-' + (body.name || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30) + '-' + Date.now().toString(36).slice(-4));
          if (list.find(t => t.id === id)) {
            throw new Error('Template with this ID already exists. Use PUT to update.');
          }
          const template = {
            id,
            name: (body.name || 'Custom Template').substring(0, 100),
            description: (body.description || '').substring(0, 500),
            category: body.category || 'custom',
            conversation_mode: body.conversation_mode || 'direct',
            source: 'custom',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            agents: Array.isArray(body.agents) ? body.agents.slice(0, 10) : [],
            ...(body.workflow && { workflow: body.workflow }),
          };
          list.push(template);
          fs.writeFileSync(ctFile, JSON.stringify(list, null, 2));
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    else if (url.pathname === '/api/custom-templates' && req.method === 'PUT') {
      try {
        const body = await parseBody(req);
        if (!body.id) throw new Error('id required');
        const projectPath = url.searchParams.get('project') || null;
        const ctFile = filePath('custom-templates.json', projectPath);
        await withFileLock(ctFile, () => {
          const list = readJson(ctFile);
          if (!Array.isArray(list)) throw new Error('No custom templates found');
          const idx = list.findIndex(t => t.id === body.id);
          if (idx === -1) throw new Error('Template not found: ' + body.id);
          list[idx] = { ...list[idx], ...body, updated_at: new Date().toISOString(), source: 'custom' };
          fs.writeFileSync(ctFile, JSON.stringify(list, null, 2));
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    else if (url.pathname === '/api/custom-templates' && req.method === 'DELETE') {
      try {
        const body = await parseBody(req);
        if (!body.id) throw new Error('id required');
        const projectPath = url.searchParams.get('project') || null;
        const ctFile = filePath('custom-templates.json', projectPath);
        await withFileLock(ctFile, () => {
          const list = readJson(ctFile);
          if (!Array.isArray(list)) throw new Error('No custom templates found');
          const idx = list.findIndex(t => t.id === body.id);
          if (idx === -1) throw new Error('Template not found: ' + body.id);
          list.splice(idx, 1);
          fs.writeFileSync(ctFile, JSON.stringify(list, null, 2));
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    // --- v3.4: Agent Permissions ---
    else if (url.pathname === '/api/permissions' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readJson(filePath('permissions.json', projectPath))));
    }
    else if (url.pathname === '/api/permissions' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = apiUpdatePermissions(body, url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // --- v3.4: Read Receipts ---
    else if (url.pathname === '/api/read-receipts' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project') || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readJson(filePath('read_receipts.json', projectPath))));
    }
    // Server info (LAN mode detection for frontend)
    else if (url.pathname === '/api/server-info' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lan_mode: LAN_MODE, lan_ip: getLanIP(), port: PORT }));
    }
    // Toggle LAN mode (re-bind server live)
    else if (url.pathname === '/api/toggle-lan' && req.method === 'POST') {
      const newMode = !LAN_MODE;
      const lanIP = getLanIP();
      LAN_MODE = newMode;
      persistLanMode();
      // Regenerate token when enabling LAN mode
      if (newMode) generateLanToken();
      // Send response first
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lan_mode: newMode, lan_ip: lanIP, port: PORT }));
      // Re-bind by stopping the listener and immediately re-listening
      // Use setImmediate to let the response flush first
      setImmediate(() => {
        // Drop SSE clients
        for (const client of sseClients) { try { client.end(); } catch {} }
        sseClients.clear();
        // Stop listening (don't use server.close which waits for all connections)
        server.listening = false;
        if (server._handle) {
          server._handle.close();
          server._handle = null;
        }
        server.listen(PORT, newMode ? '0.0.0.0' : '127.0.0.1', () => {
          console.log(newMode
            ? `  LAN mode enabled — http://${lanIP}:${PORT}`
            : '  LAN mode disabled — localhost only');
          startFileWatcher(); // restart file watcher
        });
      });
    }
    // Templates API
    else if (url.pathname === '/api/templates' && req.method === 'GET') {
      let templates = [];
      const templatesDir = path.join(__dirname, 'templates');
      if (fs.existsSync(templatesDir)) {
        templates = fs.readdirSync(templatesDir)
          .filter(f => f.endsWith('.json'))
          .map(f => { try { const t = JSON.parse(fs.readFileSync(path.join(templatesDir, f), 'utf8')); t.source = 'templates'; return t; } catch { return null; } })
          .filter(Boolean);
      }
      const convDir = path.join(__dirname, 'conversation-templates');
      if (fs.existsSync(convDir)) {
        const conv = fs.readdirSync(convDir)
          .filter(f => f.endsWith('.json'))
          .map(f => { try { const t = JSON.parse(fs.readFileSync(path.join(convDir, f), 'utf8')); t.source = 'conversation-templates'; return t; } catch { return null; } })
          .filter(Boolean);
        templates = templates.concat(conv);
      }
      // Merge custom templates from project data dir
      const projectPath = url.searchParams.get('project') || null;
      const customTemplates = readJson(filePath('custom-templates.json', projectPath));
      if (Array.isArray(customTemplates) && customTemplates.length > 0) {
        templates = templates.concat(customTemplates);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(templates));
    }
    // Agent launcher
    else if (url.pathname === '/api/launch' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = apiLaunchAgent(body);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // --- v3.4: Notifications ---
    else if (url.pathname === '/api/notifications' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiNotifications()));
    }
    // --- v3.4: Performance Scores ---
    else if (url.pathname === '/api/scores' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiScores(url.searchParams)));
    }
    // --- v3.4: Cross-Project Search ---
    else if (url.pathname === '/api/search-all' && req.method === 'GET') {
      const result = apiSearchAll(url.searchParams);
      res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    // --- v3.4: Replay Export ---
    else if (url.pathname === '/api/export-replay' && req.method === 'GET') {
      const html = apiExportReplay(url.searchParams);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="replay-' + new Date().toISOString().slice(0, 10) + '.html"',
      });
      res.end(html);
    }
    // (World Builder API endpoints are handled earlier in the route chain by Architect's implementation)
    // Server-Sent Events endpoint for real-time updates
    else if (url.pathname === '/api/events' && req.method === 'GET') {
      if (sseClients.size >= 100) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many SSE connections' }));
        return;
      }
      // Per-IP SSE limit (max 5 connections per IP)
      const sseIP = req.socket.remoteAddress || 'unknown';
      const sseIPCount = [...sseClients].filter(c => c._sseIP === sseIP).length;
      if (sseIPCount >= 5) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many SSE connections from this IP (max 5)' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: connected\n\n`);
      res._sseIP = sseIP;
      sseClients.add(res);
      // Heartbeat every 30s to detect dead connections and prevent proxy timeouts
      const heartbeat = setInterval(() => {
        try { res.write(`:heartbeat\n\n`); } catch { clearInterval(heartbeat); sseClients.delete(res); }
      }, 30000);
      heartbeat.unref();
      req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    console.error('Server error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// --- Server-Sent Events for real-time updates ---
// Watches data files and pushes updates to connected clients instantly
const sseClients = new Set();

function sseNotifyAll(changeType) {
  // Generate notifications from agent state changes
  try {
    const agents = readJson(filePath('agents.json'));
    generateNotifications(agents);
  } catch {}

  // Send typed change event so client can do targeted fetches
  const eventData = changeType || 'update';
  const dead = [];
  for (const res of Array.from(sseClients)) {
    try {
      res.write(`data: ${(eventData || '').replace(/[\r\n]/g, '')}\n\n`);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) sseClients.delete(res);
}

// Watch data directory for changes and push SSE notifications
let fsWatcher = null;
let sseDebounceTimer = null;

function startFileWatcher() {
  // Clean up previous watcher to prevent memory leaks on LAN toggle
  if (fsWatcher) { try { fsWatcher.close(); } catch {} fsWatcher = null; }
  if (sseDebounceTimer) { clearTimeout(sseDebounceTimer); sseDebounceTimer = null; }

  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) return;
  try {
    // Track pending change types for diff-based SSE
    let pendingChangeTypes = new Set();
    fsWatcher = fs.watch(dataDir, { persistent: false }, (eventType, filename) => {
      // Filter: only react to data files, not temp/lock files
      if (filename && !filename.endsWith('.json') && !filename.endsWith('.jsonl')) return;
      if (filename && filename.endsWith('.lock')) return;
      // Scale fix: skip heartbeat file changes — they fire 100x/10s at scale
      // Dashboard already polls agents via /api/agents on its own interval
      if (filename && filename.startsWith('heartbeat-')) return;

      // Classify change type for targeted client fetches
      if (filename === 'messages.jsonl' || filename === 'history.jsonl' || (filename && filename.includes('-messages.jsonl'))) {
        pendingChangeTypes.add('messages');
      } else if (filename === 'agents.json' || filename === 'profiles.json') {
        pendingChangeTypes.add('agents');
      } else if (filename === 'tasks.json') {
        pendingChangeTypes.add('tasks');
      } else if (filename === 'workflows.json') {
        pendingChangeTypes.add('workflows');
      } else if (filename === 'hooks.json') {
        pendingChangeTypes.add('hooks');
      } else {
        pendingChangeTypes.add('update');
      }

      // Debounce — multiple file changes may fire rapidly
      // Increased from 200ms to 2000ms for 100-agent scale (prevents SSE flood)
      if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
      sseDebounceTimer = setTimeout(() => {
        // Send combined change types: "messages,agents" or just "messages"
        const changeType = Array.from(pendingChangeTypes).join(',');
        pendingChangeTypes.clear();
        sseNotifyAll(changeType);
      }, 2000);
    });
    fsWatcher.on('error', () => {}); // ignore watch errors
  } catch {}
}

startFileWatcher();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Error: Port ${PORT} is already in use.`);
    console.error(`  Another dashboard may be running. Try:`);
    console.error(`    - Kill it: npx kill-port ${PORT}`);
    console.error(`    - Or use a different port: NEOHIVE_PORT=3001 npx neohive dashboard\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, LAN_MODE ? '0.0.0.0' : '127.0.0.1', () => {
  const dataDir = resolveDataDir();
  const lanIP = getLanIP();
  console.log('');
  console.log('  Neohive Dashboard v6.0.0');
  console.log('  ============================================');
  console.log('  Dashboard:  http://localhost:' + PORT);
  if (LAN_MODE && lanIP) {
    console.log('  LAN access: http://' + lanIP + ':' + PORT);
    console.log('  WARNING:    LAN mode enabled — accessible to anyone on your network');
  }
  let dataDirLine = '  Data dir:   ' + dataDir;
  if (_defaultDataResolved.source === 'walk-up') {
    dataDirLine += ' (best .neohive among ancestors — tasks/agents/history)';
  } else if (_defaultDataResolved.source === 'mcp-config' && _defaultDataResolved.configAt) {
    dataDirLine += ' (from MCP config under ' + _defaultDataResolved.configAt + ')';
  } else if (_defaultDataResolved.source === 'environment') {
    dataDirLine += ' (NEOHIVE_DATA_DIR / NEOHIVE_DATA)';
  }
  console.log(dataDirLine);
  console.log('  Projects:   ' + getProjects().length + ' registered');
  console.log('  Updates:    SSE (real-time) + polling fallback (2s)');
  console.log('');
});
