'use strict';

// Global cross-project agent registry: ~/.neohive/registry.json
//
// Problem: the dashboard's data-dir resolution (lib/paths.js) is a best-effort
// guess from {env, cwd} — for an unusual cwd/ancestor layout it can pick a
// different .neohive than the one an agent actually registered into, so the
// agent never shows up. The registry is a side channel: on register(), the
// MCP server records {projectRoot, dataDir, agent, pid} here; the dashboard
// reads it and ADDITIVELY merges any dataDir it doesn't already know about
// into its project list, without touching which project is "active".
//
// Concurrency: multiple agent processes (different projects, different PIDs)
// call registerAgent() concurrently. Writes go through the same
// withFileLock + atomic-rename pattern already used for agents.json
// (lib/file-io.js), applied here to registry.json instead.

const fs = require('fs');
const path = require('path');
const os = require('os');
// Reuse the project's existing generic file-lock primitive (same one guarding
// agents.json/config.json/tasks.json elsewhere) instead of reimplementing
// locking for a new file.
const { withFileLock } = require('./file-io');

// NEOHIVE_REGISTRY_FILE lets tests (and any isolated run) redirect the global
// registry away from the real ~/.neohive/registry.json so they never pollute it.
const REGISTRY_FILE = process.env.NEOHIVE_REGISTRY_FILE
  ? path.resolve(process.env.NEOHIVE_REGISTRY_FILE)
  : path.join(os.homedir(), '.neohive', 'registry.json');
const REGISTRY_DIR = path.dirname(REGISTRY_FILE);

// Entries older than this with a dead PID are pruned on next write.
const STALE_MS = 24 * 60 * 60 * 1000; // 24h

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readRegistryUnlocked() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.agents)) return j;
  } catch {
    /* missing/corrupt — treat as empty */
  }
  return { agents: [] };
}

function writeRegistryUnlocked(data) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${REGISTRY_FILE}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
}

function pruneStale(agents) {
  const now = Date.now();
  return agents.filter((e) => {
    if (isPidAlive(e.pid)) return true;
    const age = now - (Date.parse(e.lastSeen) || 0);
    return age < STALE_MS;
  });
}

/**
 * Record/update a single agent's registration. Safe for concurrent callers
 * (locked read-modify-write + atomic rename).
 *
 * @param {{name: string, projectRoot: string, dataDir: string, pid: number}} entry
 */
function registerAgent(entry) {
  if (!entry || !entry.name || !entry.dataDir) return;
  // withFileLock creates `${REGISTRY_FILE}.lock` with an exclusive (wx) write;
  // if REGISTRY_DIR doesn't exist yet that fails with ENOENT (not EEXIST),
  // which looks identical to "lock is held" and silently spins for the full
  // timeout without ever running the callback. Ensure the dir exists first.
  try { fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  return withFileLock(REGISTRY_FILE, () => {
    const data = readRegistryUnlocked();
    const key = (e) => `${e.dataDir}::${e.name}`;
    const now = new Date().toISOString();
    const next = { name: entry.name, projectRoot: entry.projectRoot || null, dataDir: entry.dataDir, pid: entry.pid, lastSeen: now };
    const idx = data.agents.findIndex((e) => key(e) === key(next));
    if (idx >= 0) data.agents[idx] = next;
    else data.agents.push(next);
    data.agents = pruneStale(data.agents);
    writeRegistryUnlocked(data);
    return next;
  });
}

/** Read the registry (best-effort — returns { agents: [] } if missing/corrupt/locked out). */
function readRegistry() {
  try { fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  return withFileLock(REGISTRY_FILE, () => readRegistryUnlocked()) || { agents: [] };
}

/**
 * Distinct {projectRoot, dataDir} pairs currently in the registry, with dead
 * entries pruned. Used by the dashboard to additively discover projects it
 * wouldn't otherwise have found via its own cwd-based resolution.
 */
function listDiscoveredProjects() {
  const data = readRegistry();
  const seen = new Map();
  for (const e of pruneStale(data.agents)) {
    if (!e.dataDir) continue;
    const root = e.projectRoot || path.dirname(e.dataDir);
    if (!seen.has(root)) seen.set(root, { path: root, dataDir: e.dataDir, discovered: true });
  }
  return [...seen.values()];
}

module.exports = {
  REGISTRY_FILE,
  registerAgent,
  readRegistry,
  listDiscoveredProjects,
};
