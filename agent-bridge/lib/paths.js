'use strict';

// Single source of truth for "given {env, cwd}, what is the neohive data dir /
// project root?" — used identically by server.js (via lib/config.js) and by
// dashboard.js, so the two processes can never disagree about where an
// agent's data lives.
//
// This module is the union of the two resolvers that previously existed
// independently:
//   - lib/resolve-server-data-dir.js (server-side: literal env value, node_modules
//     guard, user-level ~/.cursor/mcp.json fallback)
//   - dashboard.js's resolveDashboardDefaultDataDir (dashboard-side: env-as-project-root
//     convenience, best-scored-ancestor walk)
// Both behaviors are preserved (see resolveDataDir below) — nothing that
// resolved correctly before should resolve differently now.

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizeNeohiveDataDirString(raw, workspaceRoot) {
  if (raw == null || typeof raw !== 'string') return null;
  let d = raw.trim();
  if (!d) return null;
  d = d.replace(/\$\{workspaceFolder\}/gi, workspaceRoot);
  return path.isAbsolute(d) ? path.resolve(d) : path.resolve(workspaceRoot, d);
}

// Check if a directory has actual data files (not just an empty dir)
function hasDataFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    const files = fs.readdirSync(dir);
    return files.some((f) => f.endsWith('.jsonl') || f === 'agents.json');
  } catch {
    return false;
  }
}

/** Candidate MCP/IDE config files that `neohive init` writes NEOHIVE_DATA_DIR into. */
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
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** First-match ancestor walk looking only at MCP configs (server's original behavior). */
function findDataDirByWalkingUpFrom(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  for (let depth = 0; depth < 32 && dir !== root; depth++) {
    const fromMcp = readNeohiveDataDirFromMcpConfigs(dir);
    if (fromMcp) return fromMcp;
    dir = path.dirname(dir);
  }
  return null;
}

function findCursorProjectRootWithNeohive(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const mcpPath = path.join(dir, '.cursor', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        if (j.mcpServers && j.mcpServers.neohive) return dir;
      } catch {
        /* ignore */
      }
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

function countAgentsInNeohiveDir(nhDir) {
  if (!fs.existsSync(nhDir)) return 0;
  const ag = path.join(nhDir, 'agents.json');
  if (!fs.existsSync(ag)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(ag, 'utf8'));
    return j && typeof j === 'object' ? Object.keys(j).length : 0;
  } catch {
    return 0;
  }
}

function countNeohiveJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(j) ? j.length : 0;
  } catch {
    return 0;
  }
}

// Score each ancestor's .neohive so we prefer the hive that has tasks/workflows
// (not just the first one with agents). Ported unchanged from the dashboard's
// original bestNeohiveAmongAncestors/scoreNeohiveDataDir.
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

/** User-level Cursor MCP may define neohive with an absolute data dir. */
function readNeohiveDirFromUserCursorMcp() {
  const userMcp = path.join(os.homedir(), '.cursor', 'mcp.json');
  if (!fs.existsSync(userMcp)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(userMcp, 'utf8'));
    const nh = j.mcpServers && j.mcpServers.neohive;
    const raw = nh && nh.env && nh.env.NEOHIVE_DATA_DIR;
    if (raw == null || typeof raw !== 'string') return null;
    const d = raw.trim();
    if (!d || /\$\{workspaceFolder\}/i.test(d)) return null;
    return path.resolve(d);
  } catch {
    return null;
  }
}

/**
 * Resolve the neohive data directory for the current process (MCP server or
 * dashboard). Both callers MUST get byte-identical results for identical
 * {env, cwd} — this is the invariant the whole module exists to guarantee.
 *
 * Resolution order:
 *   1. NEOHIVE_DATA_DIR / NEOHIVE_DATA env var.
 *      UNIFIED RULE (locked in): if `<value>/.neohive` exists AND has data
 *      files, use that subdir (treats value as a possible project root —
 *      this was previously dashboard-only behavior). Otherwise use the value
 *      literally as the data dir (previously server-only behavior). This
 *      preserves both existing behaviors without any caller needing to guess
 *      which one applies.
 *   2. Walk up from cwd looking for a project MCP config that defines
 *      NEOHIVE_DATA_DIR (first match wins) — server's original behavior.
 *   3. Best-scored-ancestor .neohive walk (prefers the ancestor with the most
 *      agents/tasks/workflows) — dashboard's original behavior. Only used as
 *      a fallback when (2) finds nothing, so it never overrides an explicit
 *      MCP config.
 *   4. Local-dev sibling fallback: server.js lives inside a project repo
 *      (e.g. agent-bridge/) with a `.cursor/mcp.json` next to it — but only
 *      if we're not inside node_modules (npm-installed copies must never
 *      resolve to the package author's project).
 *   5. User-level ~/.cursor/mcp.json, if it defines an absolute path.
 *   6. cwd/.neohive — last resort.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] - defaults to process.env
 * @param {string} [opts.cwd] - defaults to process.cwd()
 * @param {string} [opts.serverJsDir] - __dirname of server.js / dashboard.js (the
 *   agent-bridge folder), used only for the local-dev sibling fallback (step 4).
 * @returns {string} absolute path to the data dir
 */
function resolveDataDir(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const serverJsDir = opts.serverJsDir || __dirname;

  // 1. Env var — unified rule.
  const raw = env.NEOHIVE_DATA_DIR || env.NEOHIVE_DATA;
  if (raw != null && String(raw).trim() !== '') {
    const val = String(raw).trim();
    if (/\$\{workspaceFolder\}/i.test(val)) {
      // Cursor user-level configs don't expand ${workspaceFolder}. Try to
      // recover the real project root by walking up from cwd; otherwise fall
      // through to cwd/.neohive so data stays isolated to wherever we run.
      const root = findCursorProjectRootWithNeohive(cwd);
      if (root) {
        const expanded = val.replace(/\$\{workspaceFolder\}/gi, root);
        return path.resolve(expanded);
      }
      return path.join(cwd, '.neohive');
    }
    const resolved = path.resolve(val);
    const neohiveSubdir = path.join(resolved, '.neohive');
    if (hasDataFiles(neohiveSubdir)) return neohiveSubdir;
    return resolved;
  }

  // 2. Walk up from cwd looking for a project MCP config (first match wins).
  const fromWalk = findDataDirByWalkingUpFrom(cwd);
  if (fromWalk) return fromWalk;

  // 3. Best-scored-ancestor .neohive walk (fallback only — no MCP config found).
  const fromScoredAncestors = bestNeohiveAmongAncestors(cwd);
  if (fromScoredAncestors) return fromScoredAncestors;

  // 4. Local dev only: serverJsDir lives inside a project repo (e.g. agent-bridge/).
  const parent = path.join(serverJsDir, '..');
  if (!serverJsDir.includes('node_modules') && fs.existsSync(path.join(parent, '.cursor', 'mcp.json'))) {
    return path.join(parent, '.neohive');
  }

  // 5. User-level ~/.cursor/mcp.json — only if it defines an absolute path.
  const fromUser = readNeohiveDirFromUserCursorMcp();
  if (fromUser) return fromUser;

  // 6. cwd/.neohive — last resort.
  return path.join(cwd, '.neohive');
}

/**
 * Resolve the project root for a given data dir (used to locate BMad artifacts,
 * package.json, etc. relative to the actual project, not just the data dir).
 * Ported unchanged from lib/bmad-provider.js#projectRootFromDataDir.
 *
 * @param {string} dataDir
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.cwd]
 */
function resolveProjectRoot(dataDir, opts = {}) {
  const env = opts.env || process.env;
  if (env.NEOHIVE_PROJECT_ROOT) return path.resolve(env.NEOHIVE_PROJECT_ROOT);
  const cwd = opts.cwd || process.cwd();
  const resolved = path.resolve(String(dataDir || ''));
  if (['.neohive', 'data'].includes(path.basename(resolved))) return path.dirname(resolved);
  if (['_bmad', '_bmad-output', 'package.json', '.git'].some((name) => fs.existsSync(path.join(resolved, name)))) {
    return resolved;
  }
  return path.resolve(cwd);
}

module.exports = {
  resolveDataDir,
  resolveProjectRoot,
  // exported for reuse/testing by dashboard.js's per-monitored-project resolution
  // and by the invariant test suite
  hasDataFiles,
  normalizeNeohiveDataDirString,
  readNeohiveDataDirFromMcpConfigs,
  findDataDirByWalkingUpFrom,
  findCursorProjectRootWithNeohive,
  bestNeohiveAmongAncestors,
  scoreNeohiveDataDir,
  countAgentsInNeohiveDir,
  countNeohiveJsonArray,
  readNeohiveDirFromUserCursorMcp,
};
