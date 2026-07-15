#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');

const { DATA_DIR, sanitizeName, ensureDataDir } = require('../lib/config');
const { hubRegisterAgent, hubUnregisterAgent, touchHeartbeat } = require('../lib/agents');

const POLL_MS = 2000;
const HEARTBEAT_MS = 10000;
const REQUEST_TIMEOUT_MS = 300000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith('--') || value === undefined) {
      throw new Error('Usage: ollama-agent.js --name NAME --model MODEL --endpoint URL --instance ID');
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function validateEndpoint(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama endpoint must use HTTP or HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Ollama endpoint cannot contain credentials, query, or fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Ollama endpoint cannot contain a path');
  return url.origin;
}

function validateModel(model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model)) {
    throw new Error('Invalid model name');
  }
  return model;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logText(value, maxLength = 4000) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) + '\n[output truncated]' : text;
}

function callOllama(endpoint, model, systemPrompt, prompt, history) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', endpoint);
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (Array.isArray(history)) messages.push(...history);
    messages.push({ role: 'user', content: prompt });
    const body = JSON.stringify({ model, messages, stream: false });
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Ollama response exceeded 2 MB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const message = parsed.message || {};
          resolve(message.content || message.thinking || data);
        } catch {
          resolve(data);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Ollama request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function appendMessage(name, to, content) {
  const message = {
    id: `m${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    from: name,
    to,
    content: String(content).slice(0, 1000000),
    timestamp: new Date().toISOString(),
  };
  const line = JSON.stringify(message) + '\n';
  fs.appendFileSync(path.join(DATA_DIR, 'messages.jsonl'), line);
  fs.appendFileSync(path.join(DATA_DIR, 'history.jsonl'), line);
}

async function main() {
  const args = parseArgs(process.argv);
  const name = sanitizeName(args.name || '');
  const model = validateModel(args.model || '');
  const endpoint = validateEndpoint(args.endpoint || '');
  const instanceId = String(args.instance || '');
  const skills = String(args.skills || '').split(',').map((skill) => skill.trim()).filter(Boolean).slice(0, 20);
  const systemPrompt = String(args['system-prompt'] || '').trim().slice(0, 12000);
  if (!/^[a-f0-9]{16,64}$/.test(instanceId)) throw new Error('Invalid instance ID');

  ensureDataDir();
  const stopFile = path.join(DATA_DIR, `ollama-stop-${instanceId}`);
  const runtimeFile = path.join(DATA_DIR, `ollama-runtime-${instanceId}.json`);
  const consumedFile = path.join(DATA_DIR, `consumed-${name}.json`);
  let stopping = false;
  let cleaned = false;
  let terminal = null;
  let requestQueue = Promise.resolve();
  let terminalHistory = [];

  function writeRuntime(status, extra) {
    writeJsonAtomic(runtimeFile, Object.assign({
      instance_id: instanceId,
      name,
      model,
      pid: process.pid,
      status,
      last_activity: new Date().toISOString(),
    }, extra || {}));
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    stopping = true;
    if (terminal) terminal.close();
    hubUnregisterAgent(name);
    try { fs.unlinkSync(runtimeFile); } catch {}
    try { fs.unlinkSync(stopFile); } catch {}
  }

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);

  const registration = hubRegisterAgent(name, `Ollama (${model})`, ['ollama', 'local-model', ...skills]);
  if (registration.error) throw new Error(registration.error);
  writeRuntime('running', { started_at: new Date().toISOString() });
  console.log(`[${name}] Ollama agent running with ${model} at ${endpoint}`);
  console.log(`[${name}] Type a message and press Enter to chat. Use /exit to stop.`);

  function enqueueRequest(work) {
    const result = requestQueue.then(work, work);
    requestQueue = result.catch(() => {});
    return result;
  }

  if (process.stdin.isTTY) {
    terminal = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: 'You> ',
    });
    terminal.prompt();
    terminal.on('line', (line) => {
      const prompt = line.trim();
      if (!prompt) {
        terminal.prompt();
        return;
      }
      if (prompt === '/exit' || prompt === '/quit') {
        cleanup();
        process.exit(0);
        return;
      }

      terminal.pause();
      writeRuntime('working', { request_from: 'terminal' });
      enqueueRequest(async () => {
        try {
          const response = await callOllama(endpoint, model, systemPrompt, prompt, terminalHistory);
          terminalHistory.push(
            { role: 'user', content: prompt },
            { role: 'assistant', content: response });
          while (
            terminalHistory.length > 20 ||
            terminalHistory.reduce((total, message) => total + message.content.length, 0) > 40000
          ) {
            terminalHistory.splice(0, 2);
          }
          console.log(`\n${name}> ${logText(response)}`);
        } catch (error) {
          console.error(`\n[${name}] Ollama request failed: ${error.message}`);
        } finally {
          touchHeartbeat(name);
          writeRuntime('running');
          if (!stopping) {
            terminal.resume();
            terminal.prompt();
          }
        }
      });
    });
  }

  let lastHeartbeat = 0;
  while (!stopping) {
    if (fs.existsSync(stopFile)) break;
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      touchHeartbeat(name);
      writeRuntime('running');
      lastHeartbeat = now;
    }

    const consumed = readJson(consumedFile, {});
    const messagesFile = path.join(DATA_DIR, 'messages.jsonl');
    const raw = fs.existsSync(messagesFile) ? fs.readFileSync(messagesFile, 'utf8') : '';
    const messages = raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const offset = Number.isInteger(consumed.offset) ? consumed.offset : 0;
    const pending = messages.slice(offset).filter((message) =>
      message && message.from !== name && (message.to === name || message.to === 'all'));
    writeJsonAtomic(consumedFile, Object.assign({}, consumed, { offset: messages.length }));

    for (const message of pending) {
      if (stopping || fs.existsSync(stopFile)) break;
      if (message.from === '__system__') continue;
      writeRuntime('working', { request_from: message.from });
      console.log(`\n[${name}] ${message.from}: ${logText(message.content)}`);
      try {
        const response = await enqueueRequest(() =>
          callOllama(endpoint, model, systemPrompt, message.content));
        appendMessage(name, message.from, response);
        console.log(`[${name}] -> ${message.from}: ${logText(response)}`);
      } catch (error) {
        appendMessage(name, message.from, `Error calling Ollama: ${error.message}`);
        console.error(`[${name}] Ollama request failed: ${error.message}`);
      }
      touchHeartbeat(name);
      writeRuntime('running');
    }
    await sleep(POLL_MS);
  }

  cleanup();
}

main().catch((error) => {
  console.error('[Ollama agent] ' + error.message);
  process.exitCode = 1;
});
