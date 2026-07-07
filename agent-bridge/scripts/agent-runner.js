#!/usr/bin/env node
'use strict';

/**
 * agent-runner.js — Event-driven CLI agent wrapper
 *
 * Wraps any CLI agent process (Claude Code, Gemini CLI, custom scripts) and
 * watches .neohive/messages.jsonl for incoming messages. When a message arrives
 * addressed to this agent, it injects a prompt into the child's stdin, waking
 * the LLM without relying on the model to call listen() in a loop.
 *
 * This solves the fundamental fragility of LLM-driven polling: the system
 * layer owns the event loop, not the model.
 *
 * Usage:
 *   node agent-runner.js --name Coder --cmd "claude"
 *   node agent-runner.js --name Gemini --cmd "gemini" --data-dir /path/to/.neohive
 *   node agent-runner.js --name Worker --cmd "node my-agent.js" --cooldown 5000
 *
 * Environment:
 *   NEOHIVE_DATA_DIR — override data directory (default: cwd/.neohive)
 *   NEOHIVE_AGENT_NAME — override agent name (alternative to --name)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}
function hasFlag(flag) { return args.indexOf(flag) !== -1; }

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
agent-runner.js — Event-driven CLI agent wrapper for Neohive

Usage:
  node agent-runner.js --name <agent> --cmd <command> [options]

Options:
  --name <name>       Agent name to watch for (or NEOHIVE_AGENT_NAME env)
  --cmd <command>     CLI command to spawn (e.g. "claude", "gemini")
  --data-dir <path>   Path to .neohive/ directory (default: cwd/.neohive)
  --cooldown <ms>     Min interval between injections (default: 3000)
  --inject-mode <m>   "prompt" (inject as user text) or "newline" (just wake)
  --quiet             Suppress runner status messages
  --help              Show this help
  `);
  process.exit(0);
}

const agentName = getArg('--name', process.env.NEOHIVE_AGENT_NAME || '');
const cmd = getArg('--cmd', '');
const dataDir = getArg('--data-dir', process.env.NEOHIVE_DATA_DIR || path.join(process.cwd(), '.neohive'));
const cooldownMs = parseInt(getArg('--cooldown', '3000'), 10) || 3000;
const injectMode = getArg('--inject-mode', 'prompt'); // "prompt" or "newline"
const quiet = hasFlag('--quiet');

if (!agentName) {
  console.error('Error: --name <agent> is required (or set NEOHIVE_AGENT_NAME)');
  process.exit(1);
}
if (!cmd) {
  console.error('Error: --cmd <command> is required');
  process.exit(1);
}

// ── State ────────────────────────────────────────────────────────────────────

const messagesFile = path.join(dataDir, 'messages.jsonl');
let lastSize = 0;
let lastInjection = 0;
let childProcess = null;
let consumedIds = new Set();

function log(msg) {
  if (!quiet) {
    const ts = new Date().toISOString().slice(11, 19);
    process.stderr.write(`[agent-runner ${ts}] ${msg}\n`);
  }
}

// ── Consumed IDs tracking ────────────────────────────────────────────────────

function loadConsumedIds() {
  const consumedFile = path.join(dataDir, `consumed-${agentName}.json`);
  try {
    if (fs.existsSync(consumedFile)) {
      const data = JSON.parse(fs.readFileSync(consumedFile, 'utf8'));
      consumedIds = new Set(Array.isArray(data) ? data : (data.ids || []));
    }
  } catch { /* ignore */ }
}

// ── Message detection ────────────────────────────────────────────────────────

function readNewMessages() {
  if (!fs.existsSync(messagesFile)) return [];

  const stat = fs.statSync(messagesFile);
  if (stat.size <= lastSize) return [];

  const fd = fs.openSync(messagesFile, 'r');
  const buf = Buffer.alloc(stat.size - lastSize);
  fs.readSync(fd, buf, 0, buf.length, lastSize);
  fs.closeSync(fd);
  lastSize = stat.size;

  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (!msg || !msg.id) continue;
      if (consumedIds.has(msg.id)) continue;
      const to = msg.to || '';
      if (to !== agentName && to !== '__group__' && to !== '__all__') continue;
      if (to === '__group__' && msg.from === agentName) continue;
      messages.push(msg);
    } catch { /* skip malformed lines */ }
  }

  return messages;
}

// ── stdin injection ──────────────────────────────────────────────────────────

function injectMessage(msg) {
  if (!childProcess || !childProcess.stdin || childProcess.stdin.destroyed) {
    log(`Cannot inject — child stdin unavailable`);
    return false;
  }

  const now = Date.now();
  if (now - lastInjection < cooldownMs) {
    log(`Cooldown active, skipping injection (${cooldownMs - (now - lastInjection)}ms remaining)`);
    return false;
  }
  lastInjection = now;

  const from = msg.from || 'unknown';
  const content = [...(msg.content || '')].slice(0, 500).join('');
  const priority = msg.priority && msg.priority !== 'normal' ? ` [${msg.priority.toUpperCase()}]` : '';

  let injection;
  if (injectMode === 'newline') {
    injection = '\n';
  } else {
    injection = [
      `[NEOHIVE MESSAGE${priority} from ${from}]: ${content}`,
      '',
      'You have a new Neohive message. Call listen() to retrieve and process it.',
      ''
    ].join('\n');
  }

  try {
    process.stdin.unpipe(childProcess.stdin);
    childProcess.stdin.write(injection);
    process.stdin.pipe(childProcess.stdin);
    log(`Injected message from ${from} (id: ${msg.id})`);
    return true;
  } catch (e) {
    try { process.stdin.pipe(childProcess.stdin); } catch {}
    log(`Injection failed: ${e.message}`);
    return false;
  }
}

// ── File watcher ─────────────────────────────────────────────────────────────

function startWatcher() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Initialize offset to current file size so we only see NEW messages
  if (fs.existsSync(messagesFile)) {
    lastSize = fs.statSync(messagesFile).size;
  }

  loadConsumedIds();

  let watcher;
  let debounceTimer = null;

  function onFileChange() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const messages = readNewMessages();
      for (const msg of messages) {
        if (injectMessage(msg)) break;
      }
      if (messages.length > 1) {
        log(`${messages.length - 1} additional message(s) queued — agent will retrieve via listen()`);
      }
    }, 200);
  }

  function setupWatch() {
    try {
      if (watcher) watcher.close();
    } catch {}

    try {
      watcher = fs.watch(messagesFile, onFileChange);
      watcher.on('error', () => {
        log('Watcher error, restarting in 2s...');
        setTimeout(setupWatch, 2000);
      });
    } catch {
      // File might not exist yet — watch the directory instead
      try {
        watcher = fs.watch(dataDir, (eventType, filename) => {
          if (filename === 'messages.jsonl') onFileChange();
        });
        watcher.on('error', () => {
          setTimeout(setupWatch, 2000);
        });
      } catch (e) {
        log(`Cannot watch ${dataDir}: ${e.message}. Falling back to polling.`);
        setInterval(onFileChange, 2000);
      }
    }
  }

  setupWatch();

  // Periodic reload of consumed IDs (other processes may update)
  setInterval(loadConsumedIds, 10000);

  // macOS fs.watch reliability: restart watcher periodically
  setInterval(setupWatch, 30000);

  log(`Watching ${messagesFile} for messages to "${agentName}"`);
  return { close: () => { try { watcher.close(); } catch {} } };
}

// ── Child process management ─────────────────────────────────────────────────

function spawnChild() {
  const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmd];
  const bin = parts[0].replace(/^"|"$/g, '');
  const cliArgs = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

  log(`Spawning: ${bin} ${cliArgs.join(' ')}`);

  childProcess = spawn(bin, cliArgs, {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NEOHIVE_DATA_DIR: dataDir,
      NEOHIVE_AGENT_NAME: agentName,
    },
    shell: process.platform === 'win32',
  });

  // Forward user stdin to child (so the human can still type)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pipe(childProcess.stdin);

  childProcess.on('exit', (code, signal) => {
    log(`Child exited (code=${code}, signal=${signal})`);
    process.exit(code || 0);
  });

  childProcess.on('error', (err) => {
    console.error(`Failed to spawn "${bin}": ${err.message}`);
    process.exit(1);
  });

  return childProcess;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  log(`Agent runner starting for "${agentName}"`);
  log(`Data dir: ${dataDir}`);
  log(`Command: ${cmd}`);
  log(`Inject mode: ${injectMode}, cooldown: ${cooldownMs}ms`);

  spawnChild();
  const watcher = startWatcher();

  const livenessCheck = setInterval(() => {
    if (childProcess && childProcess.stdin && childProcess.stdin.destroyed) {
      log('Child stdin destroyed — child may have crashed. Exiting.');
      process.exit(1);
    }
  }, 5000);
  livenessCheck.unref();

  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down...');
    watcher.close();
    if (childProcess) childProcess.kill('SIGINT');
    setTimeout(() => process.exit(0), 1000);
  });

  process.on('SIGTERM', () => {
    watcher.close();
    if (childProcess) childProcess.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
  });
}

main();
