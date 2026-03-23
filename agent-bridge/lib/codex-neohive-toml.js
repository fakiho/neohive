'use strict';

/** TOML section header for Neohive MCP in Codex config.toml */
const HEADER = '[mcp_servers.neohive]';

/**
 * Insert or replace the [mcp_servers.neohive] table (up to the next [section]).
 * Preserves following sections (e.g. [mcp_servers.neohive.env]).
 * @param {string} config
 * @param {{ command: string, serverPath: string, timeout?: number, envSection?: string }} opts
 * @returns {string}
 */
function upsertNeohiveMcpInToml(config, opts) {
  const { command, serverPath, timeout = 300, envSection } = opts;
  const blockBody =
    `command = ${JSON.stringify(command)}\n` +
    `args = [${JSON.stringify(serverPath)}]\n` +
    `timeout = ${timeout}\n`;

  const idx = config.indexOf(HEADER);
  if (idx === -1) {
    const sep = config.length && !config.endsWith('\n') ? '\n' : '';
    let addition = `${sep}\n${HEADER}\n${blockBody}`;
    if (envSection) addition += envSection.endsWith('\n') ? envSection : envSection + '\n';
    return config + addition;
  }

  const afterHeader = idx + HEADER.length;
  const nextSecIdx = config.indexOf('\n[', afterHeader);
  const end = nextSecIdx === -1 ? config.length : nextSecIdx;
  return config.slice(0, idx) + HEADER + '\n' + blockBody + config.slice(end);
}

module.exports = { HEADER, upsertNeohiveMcpInToml };
