'use strict';

// Codex's real hook config lives under [[hooks.<EventName>]] array-of-tables in
// config.toml (PascalCase event names — PostToolUse, Stop, etc. — camelCase
// fields: command, timeoutSec, async). It is NOT a separate hooks.json file;
// that format only exists in Claude Code's settings.json.
const START = '# --- neohive hooks (managed, see agent-bridge/lib/codex-neohive-hooks-toml.js) ---';
const END = '# --- end neohive hooks ---';

/**
 * Insert or replace the neohive-managed hook block in a Codex config.toml.
 * Preserves everything else in the file (including user-defined hooks).
 * @param {string} config
 * @param {{ trackActivityCmd: string, enforceListenCmd: string }} opts
 * @returns {string}
 */
function upsertNeohiveHooksInToml(config, opts) {
  const { trackActivityCmd, enforceListenCmd } = opts;

  const block =
    `${START}\n` +
    `[[hooks.PostToolUse]]\n` +
    `matcher = "mcp__neohive__.*"\n` +
    `hooks = [\n` +
    `  { type = "command", command = ${JSON.stringify(trackActivityCmd)}, timeoutSec = 3 },\n` +
    `]\n\n` +
    `[[hooks.Stop]]\n` +
    `hooks = [\n` +
    `  { type = "command", command = ${JSON.stringify(enforceListenCmd)}, timeoutSec = 5 },\n` +
    `]\n` +
    `${END}\n`;

  const startIdx = config.indexOf(START);
  if (startIdx === -1) {
    const sep = config.length && !config.endsWith('\n') ? '\n' : '';
    return config + `${sep}\n${block}`;
  }

  const endIdx = config.indexOf(END, startIdx);
  const afterEnd = endIdx === -1 ? startIdx : endIdx + END.length + 1;
  return config.slice(0, startIdx) + block + config.slice(afterEnd);
}

module.exports = { upsertNeohiveHooksInToml };
