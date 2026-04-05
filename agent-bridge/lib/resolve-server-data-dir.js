'use strict';

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

/** Same candidate files as dashboard.js readNeohiveDataDirFromMcpConfigs */
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

/** User-level Cursor MCP may define neohive with an absolute data dir */
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
 * Neohive data directory for the MCP / CLI process.
 *
 * Resolution order:
 * 1. NEOHIVE_DATA_DIR env var (set by `neohive init` in project .cursor/mcp.json)
 * 2. Walk up from cwd looking for project MCP configs that define NEOHIVE_DATA_DIR
 * 3. Sibling .neohive/ next to the package (for local dev)
 * 4. User-level ~/.cursor/mcp.json (only if it has an absolute NEOHIVE_DATA_DIR)
 * 5. cwd/.neohive (last resort)
 *
 * Cursor spawns MCP processes with cwd set to a fixed directory (often $HOME),
 * NOT the project root. The only reliable way to identify the project is via
 * NEOHIVE_DATA_DIR in the env. All other fallbacks are best-effort heuristics.
 *
 * @param {string} serverJsDir - __dirname of server.js (the agent-bridge folder)
 */
function resolveDataDirForServer(serverJsDir) {
  const raw = process.env.NEOHIVE_DATA_DIR || process.env.NEOHIVE_DATA;
  if (raw != null && String(raw).trim() !== '') {
    const val = String(raw).trim();
    if (/\$\{workspaceFolder\}/i.test(val)) {
      // Cursor user-level configs don't expand ${workspaceFolder}.
      // Don't use this broken value — fall through to cwd/.neohive so the
      // data stays isolated to wherever the process is running.
      console.error('[neohive] NEOHIVE_DATA_DIR contains unexpanded ${workspaceFolder}: ' + val);
      console.error('[neohive] Run "npx neohive init --cursor" in your project to fix this.');
      return path.join(process.cwd(), '.neohive');
    }
    return path.resolve(val);
  }

  // No env var at all — IDE didn't pass one. Walk up from cwd looking for a
  // project MCP config that defines NEOHIVE_DATA_DIR (first match wins).
  const fromWalk = findDataDirByWalkingUpFrom(process.cwd());
  if (fromWalk) return fromWalk;

  // Local dev only: server.js lives inside a project repo (e.g. agent-bridge/).
  // Use the repo's .neohive/ — but ONLY if we aren't inside node_modules
  // (npm-installed copies must never resolve to the package author's project).
  const parent = path.join(serverJsDir, '..');
  if (!serverJsDir.includes('node_modules') && fs.existsSync(path.join(parent, '.cursor', 'mcp.json'))) {
    return path.join(parent, '.neohive');
  }

  // User-level ~/.cursor/mcp.json — only if it defines an absolute path
  const fromUser = readNeohiveDirFromUserCursorMcp();
  if (fromUser) return fromUser;

  return path.join(process.cwd(), '.neohive');
}

module.exports = { resolveDataDirForServer };
