'use strict';

// Backward-compatible re-export. The real implementation now lives in
// lib/paths.js (shared by both server.js and dashboard.js so they can never
// disagree about the data dir for a given {env, cwd}). Kept here so any
// existing `require('./resolve-server-data-dir')` call sites keep working.
const paths = require('./paths');

/**
 * @param {string} serverJsDir - __dirname of server.js (the agent-bridge folder)
 */
function resolveDataDirForServer(serverJsDir) {
  return paths.resolveDataDir({ serverJsDir });
}

module.exports = { resolveDataDirForServer };
