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
 * Cursor often spawns MCP with cwd=user home and omits NEOHIVE_DATA_DIR in the child env.
 * We mirror dashboard resolution: walk ancestors of cwd for MCP configs, then package sibling,
 * then ~/.cursor/mcp.json with an absolute path, then cwd/.neohive.
 *
 * @param {string} serverJsDir - __dirname of server.js (the agent-bridge folder)
 */
function resolveDataDirForServer(serverJsDir) {
  const raw = process.env.NEOHIVE_DATA_DIR || process.env.NEOHIVE_DATA;
  if (raw != null && String(raw).trim() !== '') {
    return path.resolve(String(raw).trim());
  }

  const fromWalk = findDataDirByWalkingUpFrom(process.cwd());
  if (fromWalk) return fromWalk;

  const parent = path.join(serverJsDir, '..');
  if (fs.existsSync(path.join(parent, '.cursor', 'mcp.json'))) {
    return path.join(parent, '.neohive');
  }
  if (fs.existsSync(path.join(serverJsDir, '.cursor', 'mcp.json'))) {
    return path.join(serverJsDir, '.neohive');
  }

  const fromUser = readNeohiveDirFromUserCursorMcp();
  if (fromUser) return fromUser;

  return path.join(process.cwd(), '.neohive');
}

module.exports = { resolveDataDirForServer };
