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
    return upsertEnvSection(config + addition, envSection);
  }

  const afterHeader = idx + HEADER.length;
  const nextSecIdx = config.indexOf('\n[', afterHeader);
  const end = nextSecIdx === -1 ? config.length : nextSecIdx;
  return upsertEnvSection(config.slice(0, idx) + HEADER + '\n' + blockBody + config.slice(end), envSection);
}

function upsertEnvSection(config, envSection) {
  if (!envSection) return config;
  const headerMatch = envSection.match(/^\s*(\[mcp_servers\.neohive\.env\])\s*$/m);
  if (!headerMatch) return config;
  const desired = {};
  for (const line of envSection.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (match) desired[match[1]] = match[2];
  }
  const envHeader = headerMatch[1];
  const headerIndex = config.indexOf(envHeader);
  if (headerIndex === -1) {
    const separator = config.endsWith('\n') ? '' : '\n';
    return config + separator + envSection.replace(/^\s+/, '').replace(/\s*$/, '\n');
  }
  const bodyStart = headerIndex + envHeader.length;
  const nextSection = config.indexOf('\n[', bodyStart);
  const bodyEnd = nextSection === -1 ? config.length : nextSection;
  let body = config.slice(bodyStart, bodyEnd);
  for (const [key, value] of Object.entries(desired)) {
    const keyPattern = new RegExp(`(^|\\n)(\\s*${key}\\s*=\\s*)[^\\n]*`);
    if (keyPattern.test(body)) body = body.replace(keyPattern, `$1$2${value}`);
    else body += `${body.endsWith('\n') ? '' : '\n'}${key} = ${value}\n`;
  }
  return config.slice(0, bodyStart) + body + config.slice(bodyEnd);
}

module.exports = { HEADER, upsertNeohiveMcpInToml };
