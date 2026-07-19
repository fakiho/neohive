'use strict';

// PTY-based native CLI launcher (Story 1.2).
//
// Mirrors the launchNativeCli() interface of tmux-cli-launcher.js, but instead
// of opening a tmux window it spawns a standalone, DETACHED per-agent "owner"
// process (lib/pty-owner.js, Story 1.1) that holds the node-pty master fd.
// Per architecture AD-1, the master fd must live in that detached owner, NOT
// in the dashboard process — so a dashboard restart (which happens on every
// code edit) never kills running agents.
//
// This module reuses the CLI-spec / env-arg helpers from tmux-cli-launcher so
// the two launchers stay in lock-step on how a native CLI is invoked.
//
// ─────────────────────────────────────────────────────────────────────────
// OWNER-SPAWN CONTRACT (must match lib/pty-owner.js — Story 1.1)
// ─────────────────────────────────────────────────────────────────────────
// Invocation (launcher → owner):
//   process.execPath lib/pty-owner.js '<json-config>'
//   config = { dataDir, agentName, command, args, env, cwd, cols, rows }
//   • spawned with { detached: true, stdio: 'ignore' } and .unref()'d so the
//     PTY master fd is never held by this (dashboard/MCP) process (AD-1).
// Readiness handshake (owner → launcher), via agents.json (no extra file):
//   The owner calls registerPid() immediately after pty.spawn(), writing
//     agents.json[agentName] = { pid: <cli_pid>, pty_owner: true,
//                                pty_owner_pid: <owner process pid>, ... }
//   The launcher polls agents.json for an entry whose pty_owner_pid matches the
//   owner PID it just spawned; its `pid` is the live CLI process (cli_pid).
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  CLI_BINS,
  findExecutable,
  getCliSpec,
  buildNativeCliEnvArgs,
} = require('./tmux-cli-launcher');

const OWNER_SCRIPT = path.join(__dirname, 'pty-owner.js');
const READY_TIMEOUT_MS = 4000;
const READY_POLL_MS = 50;

/**
 * True when the node-pty native addon can be loaded AND the owner script is
 * present. Used by the dashboard to decide whether to take the PTY path or
 * fall back to the tmux launcher (AD-5) — node-pty is an optionalDependency +
 * native addon, so a failed build must degrade gracefully, not crash.
 */
function isPtyAvailable() {
  try {
    require.resolve('node-pty');
    return fs.existsSync(OWNER_SCRIPT);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/**
 * Split the flat envArgs array from buildNativeCliEnvArgs
 * (['VAR=value', …, cliPath, ...cliArgs]) into { env, command, args }.
 * Leading `KEY=value` tokens are env pairs; the first non-`KEY=value` token is
 * the CLI path, and the remainder are its arguments.
 */
function splitEnvArgs(envArgs) {
  const env = {};
  let i = 0;
  for (; i < envArgs.length; i++) {
    const tok = envArgs[i];
    const eq = tok.indexOf('=');
    if (eq > 0 && !tok.slice(0, eq).includes('/') && !tok.slice(0, eq).includes(path.sep)) {
      env[tok.slice(0, eq)] = tok.slice(eq + 1);
    } else {
      break;
    }
  }
  const rest = envArgs.slice(i); // [cliPath, ...cliArgs]
  return { env, command: rest[0], args: rest.slice(1) };
}

/**
 * Launch a native CLI agent under a detached PTY owner process.
 * Signature-compatible with tmuxCliLauncher.launchNativeCli().
 *
 * @throws {Error} with code 'ENOBIN' when the CLI binary is missing (FR-3),
 *   or 'EPTYUNAVAIL' when node-pty/owner is unavailable (caller falls back).
 */
async function launchNativeCli({ dataDir, projectDir, cli, agentName, prompt, profile, model }) {
  if (!isPtyAvailable()) {
    const err = new Error('node-pty is not available; use the tmux launcher fallback');
    err.code = 'EPTYUNAVAIL';
    throw err;
  }

  const spec = getCliSpec(cli); // throws on invalid cli
  const safeName = String(agentName || 'agent').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 20) || 'agent';

  // FR-3: structured error (not a crash) when the binary is missing. Checked
  // synchronously here so the caller gets an immediate, actionable failure
  // before any detached process is spawned. (The owner re-checks defensively.)
  const cliPath = findExecutable(spec.bin);
  if (!cliPath) {
    const err = new Error(`${spec.label} is not installed or not available on PATH (${spec.bin})`);
    err.code = 'ENOBIN';
    throw err;
  }

  const envArgs = buildNativeCliEnvArgs({ cli, dataDir, projectDir, prompt, profile, model });
  const { env: childEnv, command, args } = splitEnvArgs(envArgs);
  const cwd = projectDir || path.dirname(dataDir);

  const config = {
    dataDir,
    agentName: safeName,
    command: command || cliPath,
    args,
    env: childEnv,
    cwd,
    cols: 220,
    rows: 50,
  };

  // AD-1: detached + unref so the owner (and its PTY master fd) outlives this
  // dashboard process. stdio ignored — all agent output flows through the log
  // file and the per-agent socket, never this parent's pipes.
  const owner = spawn(process.execPath, [OWNER_SCRIPT, JSON.stringify(config)], {
    cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  const ownerPid = owner.pid;
  owner.unref();

  let spawnFailed = null;
  owner.once('error', (e) => { spawnFailed = e; });

  // Readiness handshake: wait for the owner to register itself in agents.json
  // (registerPid fires synchronously right after pty.spawn — FR-7).
  const agentsFile = path.join(dataDir, 'agents.json');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let entry = null;
  while (Date.now() < deadline) {
    if (spawnFailed) throw new Error(`Failed to spawn PTY owner: ${spawnFailed.message}`);
    const agents = readJson(agentsFile);
    const candidate = agents && agents[safeName];
    if (candidate && candidate.pty_owner && candidate.pty_owner_pid === ownerPid) {
      entry = candidate;
      break;
    }
    await sleep(READY_POLL_MS);
  }

  if (!entry) {
    throw new Error(`PTY owner for "${safeName}" did not register within ${READY_TIMEOUT_MS}ms`);
  }

  return {
    launch_mode: 'pty',
    cli,
    bin: spec.bin,
    label: spec.label,
    agentName: safeName,
    owner_pid: ownerPid,
    cli_pid: entry.pid,
    log: path.join(dataDir, `agent-log-${safeName}.jsonl`),
    sock: path.join(dataDir, `pty-${safeName}.sock`),
  };
}

module.exports = {
  CLI_BINS,
  isPtyAvailable,
  splitEnvArgs,
  launchNativeCli,
  OWNER_SCRIPT,
};
