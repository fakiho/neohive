'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, AGENTS_FILE, PROFILES_FILE, ACKS_FILE } = require('./config');
const { cachedRead, invalidateCache, lockAgentsFile, unlockAgentsFile, withFileLock, readJsonFile } = require('./file-io');

// Cache for isPidAlive results
const _pidAliveCache = {};

// isAutonomousMode is injected late to avoid circular dependency with workflows
let _isAutonomousMode = () => false;
function setAutonomousModeCheck(fn) { _isAutonomousMode = fn; }

function isPidAlive(pid, lastActivity) {
  const cacheKey = `${pid}_${lastActivity}`;
  const cached = _pidAliveCache[cacheKey];
  if (cached && Date.now() - cached.ts < 5000) return cached.alive;

  const STALE_THRESHOLD = _isAutonomousMode() ? 30000 : 60000;
  let alive = false;

  if (lastActivity) {
    const stale = Date.now() - new Date(lastActivity).getTime();
    if (stale < STALE_THRESHOLD) alive = true;
  }
  if (!alive) {
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

function getAgents() {
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

function touchHeartbeat(name) {
  if (!name) return;
  try {
    fs.writeFileSync(heartbeatFile(name), JSON.stringify({
      last_activity: new Date().toISOString(),
      pid: process.pid,
    }));
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

module.exports = {
  isPidAlive, setAutonomousModeCheck,
  getAgents, saveAgents,
  heartbeatFile, touchHeartbeat,
  getAcks,
  getProfiles, saveProfiles,
  lockAgentsFile, unlockAgentsFile,
};
