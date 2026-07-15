'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const EXEC_TIMEOUT_MS = 5000;

const CLI_BINS = {
  claude: { bin: 'claude', label: 'Claude Code', windowPrefix: 'claude' },
  gemini: { bin: 'gemini', label: 'Gemini CLI', windowPrefix: 'gemini' },
  codex: { bin: 'codex', label: 'Codex CLI', windowPrefix: 'codex' },
  cursor: { bin: 'agent', label: 'Cursor Agent', windowPrefix: 'cursor' },
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function execTmux(args, timeout = EXEC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = (stderr || error.message || 'tmux command failed').trim();
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function findExecutable(name) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function getSessionName(dataDir) {
  const config = readJson(path.join(dataDir, 'config.json'), {});
  const configured = config.terminal && config.terminal.tmux_session;
  return typeof configured === 'string' && SESSION_RE.test(configured) ? configured : 'neohive';
}

async function ensureSession(sessionName, projectDir) {
  try {
    await execTmux(['has-session', '-t', sessionName]);
  } catch {
    await execTmux(['new-session', '-d', '-s', sessionName, '-n', 'main', '-c', projectDir]);
  }
}

/**
 * Spawn a command in a new tmux window (same pattern as managed Ollama agents).
 * envArgs is passed to `env` so VAR=value pairs work: ['NEOHIVE_DATA_DIR=...', bin, ...args]
 */
async function launchInTmux({ dataDir, projectDir, windowName, envArgs, tagOption, tagValue, select }) {
  if (!Array.isArray(envArgs) || !envArgs.length) throw new Error('launchInTmux requires envArgs');
  const safeWindow = String(windowName || 'agent').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50) || 'agent';
  const sessionName = getSessionName(dataDir);
  await ensureSession(sessionName, projectDir);
  const output = await execTmux([
    'new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}',
    '-t', sessionName, '-n', safeWindow, '-c', projectDir,
    'env', ...envArgs,
  ]);
  const [windowId, paneId] = output.split('\t');
  if (!windowId || !paneId) throw new Error('tmux did not return the new window and pane IDs');
  if (tagOption && tagValue) {
    await execTmux(['set-option', '-w', '-t', windowId, tagOption, String(tagValue)]);
  }
  if (select !== false) {
    await execTmux(['select-window', '-t', windowId]);
  }
  return { sessionName, windowId, paneId, windowName: safeWindow };
}

function getCliSpec(cli) {
  const spec = CLI_BINS[cli];
  if (!spec) throw new Error('Invalid cli type. Must be: claude, gemini, codex, or cursor');
  return spec;
}

/**
 * Build env + argv for a native CLI launch with the role prompt as the initial prompt.
 * Mirrors ollama-bridge-manager's env-prefixed tmux command style.
 */
function buildNativeCliEnvArgs({ cli, dataDir, prompt }) {
  const spec = getCliSpec(cli);
  const cliPath = findExecutable(spec.bin);
  if (!cliPath) {
    throw new Error(`${spec.label} is not installed or not available on PATH (${spec.bin})`);
  }
  const launchPrompt = String(prompt || '').trim();
  if (!launchPrompt) throw new Error('Launch prompt is required');

  // Gemini: -i keeps interactive mode after running the initial prompt.
  if (cli === 'gemini') {
    return [
      `NEOHIVE_DATA_DIR=${dataDir}`,
      cliPath,
      '--prompt-interactive', launchPrompt,
    ];
  }

  return [
    `NEOHIVE_DATA_DIR=${dataDir}`,
    cliPath,
    launchPrompt,
  ];
}

async function launchNativeCli({ dataDir, projectDir, cli, agentName, prompt }) {
  const spec = getCliSpec(cli);
  const safeName = String(agentName || 'agent').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 20) || 'agent';
  const windowName = `${spec.windowPrefix}-${safeName}`.slice(0, 50);
  const envArgs = buildNativeCliEnvArgs({ cli, dataDir, prompt });
  const window = await launchInTmux({
    dataDir,
    projectDir,
    windowName,
    envArgs,
    tagOption: '@neohive_cli_launch',
    tagValue: `${cli}:${safeName}`,
    select: true,
  });
  return {
    ...window,
    cli,
    bin: spec.bin,
    label: spec.label,
    agentName: safeName,
  };
}

module.exports = {
  CLI_BINS,
  execTmux,
  findExecutable,
  getSessionName,
  ensureSession,
  launchInTmux,
  getCliSpec,
  buildNativeCliEnvArgs,
  launchNativeCli,
};
