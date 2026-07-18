'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCK_WAIT_MS = 5000;
const STALE_LOCK_MS = 30000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function configFile(dataDir) {
  return path.join(path.resolve(dataDir), 'config.json');
}

function readProjectConfig(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(configFile(dataDir), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function lockOwnerIsAlive(lockFile) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const pid = Number(owner && owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function acquireLock(file) {
  const lockFile = `${file}.lock`;
  const started = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lockFile); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stale = Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS;
        if (stale && !lockOwnerIsAlive(lockFile)) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  throw new Error('Timed out waiting for project config lock');
}

function writeAtomic(file, config) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function mutateProjectConfig(dataDir, mutator) {
  if (typeof mutator !== 'function') throw new TypeError('Project config mutator must be a function');
  const file = configFile(dataDir);
  const release = acquireLock(file);
  try {
    const config = readProjectConfig(dataDir);
    const replacement = mutator(config);
    const next = replacement === undefined ? config : replacement;
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new TypeError('Project config mutator must return an object or undefined');
    }
    writeAtomic(file, next);
    return next;
  } finally {
    release();
  }
}

function replaceProjectConfig(dataDir, config) {
  return mutateProjectConfig(dataDir, () => config);
}

module.exports = {
  mutateProjectConfig,
  readProjectConfig,
  replaceProjectConfig,
};
