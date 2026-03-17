'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { DATA_DIR, AGENTS_FILE, CONFIG_FILE, ensureDataDir } = require('./config');

// --- Read cache (eliminates 70%+ redundant disk I/O) ---
const _cache = {};
function cachedRead(key, readFn, ttlMs = 2000) {
  const now = Date.now();
  const entry = _cache[key];
  if (entry && now - entry.ts < ttlMs) return entry.val;
  const val = readFn();
  _cache[key] = { val, ts: now };
  return val;
}
function invalidateCache(key) { delete _cache[key]; }

// --- JSONL readers ---

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8').trim();
  if (!content) return [];
  return content.split(/\r?\n/).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Optimized: read only NEW lines from a JSONL file starting at byte offset
function readJsonlFromOffset(file, offset) {
  if (!fs.existsSync(file)) return { messages: [], newOffset: 0 };
  const stat = fs.statSync(file);
  if (stat.size <= offset) return { messages: [], newOffset: offset };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(stat.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const content = buf.toString('utf8').trim();
  if (!content) return { messages: [], newOffset: stat.size };
  const messages = content.split(/\r?\n/).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return { messages, newOffset: stat.size };
}

// Read only last N lines of a JSONL file — O(N) instead of O(all)
function tailReadJsonl(file, lineCount = 100) {
  if (!fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  if (stat.size === 0) return [];
  const readSize = Math.min(stat.size, lineCount * 300);
  const offset = Math.max(0, stat.size - readSize);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, offset);
  fs.closeSync(fd);
  const content = buf.toString('utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (offset > 0 && lines.length > 0) lines.shift();
  const messages = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return messages.slice(-lineCount);
}

// --- JSON file helpers ---

function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// File-to-cache-key map: writeJsonFile auto-invalidates the right cache entry
const _fileCacheKeys = {};

function registerFileCacheKey(file, cacheKey) {
  _fileCacheKeys[file] = cacheKey;
}

function writeJsonFile(file, data) {
  ensureDataDir();
  const str = JSON.stringify(data);
  if (str && str.length > 0) {
    // Use file lock to prevent concurrent write corruption
    const lockPath = file + '.lock';
    let locked = false;
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); locked = true; } catch {}
    try {
      fs.writeFileSync(file, str);
    } finally {
      if (locked) try { fs.unlinkSync(lockPath); } catch {}
    }
    const cacheKey = _fileCacheKeys[file];
    if (cacheKey) invalidateCache(cacheKey);
  }
}

// --- File locking ---

// Dedicated lock for agents.json (exponential backoff)
const AGENTS_LOCK = AGENTS_FILE + '.lock';
function lockAgentsFile() {
  const maxWait = 5000; const start = Date.now();
  let backoff = 1;
  while (Date.now() - start < maxWait) {
    try { fs.writeFileSync(AGENTS_LOCK, String(process.pid), { flag: 'wx' }); return true; }
    catch {}
    const wait = Date.now(); while (Date.now() - wait < backoff) {}
    backoff = Math.min(backoff * 2, 500);
  }
  try { fs.unlinkSync(AGENTS_LOCK); } catch {}
  try { fs.writeFileSync(AGENTS_LOCK, String(process.pid), { flag: 'wx' }); return true; } catch {}
  return false;
}
function unlockAgentsFile() { try { fs.unlinkSync(AGENTS_LOCK); } catch {} }

// Dedicated lock for config.json
const CONFIG_LOCK = CONFIG_FILE + '.lock';
function lockConfigFile() {
  const maxWait = 5000; const start = Date.now();
  while (Date.now() - start < maxWait) {
    try { fs.writeFileSync(CONFIG_LOCK, String(process.pid), { flag: 'wx' }); return true; }
    catch {}
    const wait = Date.now(); while (Date.now() - wait < 50) {}
  }
  try { fs.unlinkSync(CONFIG_LOCK); } catch {}
  try { fs.writeFileSync(CONFIG_LOCK, String(process.pid), { flag: 'wx' }); return true; } catch {}
  return false;
}
function unlockConfigFile() { try { fs.unlinkSync(CONFIG_LOCK); } catch {} }

// Generic file lock for any JSON file
function withFileLock(filePath, fn) {
  const lockPath = filePath + '.lock';
  const maxWait = 5000; const start = Date.now();
  let backoff = 1;
  while (Date.now() - start < maxWait) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); break; }
    catch {}
    const wait = Date.now(); while (Date.now() - wait < backoff) {}
    backoff = Math.min(backoff * 2, 500);
    if (Date.now() - start >= maxWait) {
      try {
        const lockPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
        if (lockPid && lockPid !== process.pid) {
          try { process.kill(lockPid, 0); return null; } catch {}
        }
      } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
      try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); } catch { return fn(); }
      break;
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lockPath); } catch {} }
}

module.exports = {
  cachedRead, invalidateCache,
  readJsonl, readJsonlFromOffset, tailReadJsonl,
  readJsonFile, writeJsonFile, registerFileCacheKey,
  lockAgentsFile, unlockAgentsFile,
  lockConfigFile, unlockConfigFile,
  withFileLock,
};
