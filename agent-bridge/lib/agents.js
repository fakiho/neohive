'use strict';

const fs = require('fs');
const path = require('path');
const {
  DATA_DIR, AGENTS_FILE, PROFILES_FILE, ACKS_FILE,
  sanitizeName, generateToken, ensureDataDir,
} = require('./config');
const { cachedRead, invalidateCache, lockAgentsFile, unlockAgentsFile, withFileLock, readJsonFile, writeJsonFile } = require('./file-io');

// Cache for isPidAlive results
const _pidAliveCache = {};

// isAutonomousMode is injected late to avoid circular dependency with workflows
let _isAutonomousMode = () => false;
function setAutonomousModeCheck(fn) { _isAutonomousMode = fn; }

const PID_TRUST_WINDOW_MS = 60000;
function isPidAlive(pid, lastActivity) {
  const cacheKey = `${pid}_${lastActivity}`;
  const cached = _pidAliveCache[cacheKey];
  if (cached && Date.now() - cached.ts < 5000) return cached.alive;

  const STALE_THRESHOLD = _isAutonomousMode() ? 30000 : 60000;
  let alive = false;

  if (lastActivity) {
    const stale = Date.now() - new Date(lastActivity).getTime();
    if (stale < STALE_THRESHOLD) {
      alive = true;
    } else if (stale > PID_TRUST_WINDOW_MS) {
      alive = false;
    } else {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
  } else {
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  }
  _pidAliveCache[cacheKey] = { alive, ts: Date.now() };
  const keys = Object.keys(_pidAliveCache);
  if (keys.length > 200) {
    const cutoff = Date.now() - 10000;
    for (const k of keys) { if (_pidAliveCache[k].ts < cutoff) delete _pidAliveCache[k]; }
  }
  return alive;
}

function getAgents(force = false) {
  if (force) invalidateCache('agents');
  return cachedRead('agents', () => {
    if (!fs.existsSync(AGENTS_FILE)) return {};
    let agents;
    try { agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); } catch { return {}; }
    try {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('heartbeat-') && f.endsWith('.json'));
      for (const f of files) {
        const name = f.slice(10, -5);
        if (agents[name]) {
          try {
            const hb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
            if (hb.last_activity) agents[name].last_activity = hb.last_activity;
            if (hb.pid) agents[name].pid = hb.pid;
            if (hb.listen_history) agents[name].listen_history = hb.listen_history;
          } catch {}
        }
      }
    } catch {}
    return agents;
  }, 1500);
}

function saveAgents(agents) {
  const data = JSON.stringify(agents);
  if (data && data.length > 2) {
    fs.writeFileSync(AGENTS_FILE, data);
  }
  invalidateCache('agents');
}

function heartbeatFile(name) { return path.join(DATA_DIR, `heartbeat-${name}.json`); }

function touchHeartbeat(name, type = null) {
  if (!name) return;
  try {
    const file = heartbeatFile(name);
    let data = { last_activity: new Date().toISOString(), pid: process.pid, listen_history: [] };
    if (fs.existsSync(file)) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    }
    data.last_activity = new Date().toISOString();
    data.pid = process.pid;

    if (type === 'listen' || type === true) {
      if (!data.listen_history) data.listen_history = [];
      const nowTs = Date.now();
      data.listen_history.unshift(nowTs);
      data.listen_history = data.listen_history.slice(0, 10);
      data.last_listen_call = new Date(nowTs).toISOString();
    }
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {}
}

function getAcks() {
  if (!fs.existsSync(ACKS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(ACKS_FILE, 'utf8')); } catch { return {}; }
}

function getProfiles() {
  return cachedRead('profiles', () => {
    if (!fs.existsSync(PROFILES_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch { return {}; }
  }, 2000);
}

function saveProfiles(profiles) {
  withFileLock(PROFILES_FILE, () => {
    invalidateCache('profiles');
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles));
  });
}

/**
 * MCP `list_agents` payload — disk/agent state via this module + profiles.
 * Optional enrichRow(name, row) for server-only hints (workspace, IDE activity).
 */
function listAgentsMcpPayload(enrichRow) {
  const all = getAgents();
  const profiles = getProfiles();
  const result = {};
  for (const [name, info] of Object.entries(all)) {
    const alive = isPidAlive(info.pid, info.last_activity);
    const lastActivity = info.last_activity || info.timestamp;
    const idleSeconds = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 1000);
    const hasHeartbeat = fs.existsSync(heartbeatFile(name));
    const profile = profiles[name] || {};
    let status;
    if (alive) {
      status = info.listening_since ? 'listening' : idleSeconds > 30 ? 'idle' : 'working';
    } else if (!hasHeartbeat) {
      status = 'unknown';
    } else if (idleSeconds <= 120) {
      status = 'stale';
    } else {
      status = 'offline';
    }
    result[name] = {
      alive,
      registered_at: info.timestamp,
      last_activity: lastActivity,
      idle_seconds: alive ? idleSeconds : null,
      status,
      listening_since: info.listening_since || null,
      is_listening: !!(info.listening_since && alive),
      last_listened_at: info.last_listened_at || null,
      provider: info.provider || 'unknown',
      branch: info.branch || 'main',
      display_name: profile.display_name || name,
      avatar: profile.avatar || '',
      role: profile.role || '',
      bio: profile.bio || '',
    };
    if (typeof enrichRow === 'function') {
      try {
        enrichRow(name, result[name]);
      } catch (_) { /* best-effort */ }
    }
  }
  return { agents: result };
}

/**
 * Hub / ACP path: persist registration to agents.json + profile + agent-cards (no MCP heartbeat timer).
 * Disk protocol only — callers manage process-local session state separately.
 */
function hubRegisterAgent(name, provider = null, skills = null) {
  ensureDataDir();
  sanitizeName(name);
  lockAgentsFile();
  try {
    const all = getAgents(true);
    if (all[name] && all[name].pid !== process.pid && isPidAlive(all[name].pid, all[name].last_activity)) {
      return { error: `Agent "${name}" is already registered by a live process. Choose a different name.` };
    }
    const now = new Date().toISOString();
    const token = generateToken();
    all[name] = {
      pid: process.pid,
      ppid: process.ppid,
      timestamp: now,
      last_activity: now,
      last_listened_at: now,
      provider: provider || 'unknown',
      branch: 'main',
      token,
      started_at: now,
    };
    saveAgents(all);
    const profiles = getProfiles();
    if (!profiles[name]) {
      profiles[name] = { display_name: name, avatar: '', bio: '', role: '', created_at: now };
      saveProfiles(profiles);
    }
    touchHeartbeat(name);
    const cardsPath = path.join(DATA_DIR, 'agent-cards.json');
    const cards = readJsonFile(cardsPath) || {};
    const explicitSkills = Array.isArray(skills) ? skills.map((s) => String(s).toLowerCase().substring(0, 30)).slice(0, 20) : [];
    cards[name] = {
      name,
      provider: provider || 'unknown',
      skills: explicitSkills,
      platform_skills: [],
      registered_at: now,
    };
    writeJsonFile(cardsPath, cards);
    return { success: true, name, token };
  } finally {
    unlockAgentsFile();
  }
}

module.exports = {
  isPidAlive, setAutonomousModeCheck,
  getAgents, saveAgents,
  heartbeatFile, touchHeartbeat,
  getAcks,
  getProfiles, saveProfiles,
  listAgentsMcpPayload,
  hubRegisterAgent,
  lockAgentsFile, unlockAgentsFile,
};
