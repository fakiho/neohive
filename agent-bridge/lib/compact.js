'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const state = require('./state');
const { DATA_DIR, getMessagesFile, sanitizeName } = require('./config');
const { getAgents, isPidAlive } = require('./agents');

const COMPACT_LEASE_FILE = path.join(DATA_DIR, 'compact.lease');
const COMPACT_LEASE_TTL_MS = 30000;

// --- Consumed ID tracking ---

function consumedFile(agentName) {
  sanitizeName(agentName);
  return path.join(DATA_DIR, `consumed-${agentName}.json`);
}

function getConsumedIds(agentName) {
  const file = consumedFile(agentName);
  if (!fs.existsSync(file)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveConsumedIds(agentName, ids) {
  if (ids.size > 500) {
    trimConsumedIds(agentName, ids);
  }
  const file = consumedFile(agentName);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify([...ids]));
  fs.renameSync(tmp, file);
}

function trimConsumedIds(agentName, ids) {
  try {
    const msgFile = getMessagesFile(state.currentBranch);
    if (!fs.existsSync(msgFile)) { ids.clear(); return; }
    const content = fs.readFileSync(msgFile, 'utf8').trim();
    if (!content) { ids.clear(); return; }
    const currentIds = new Set();
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/"id"\s*:\s*"([^"]+)"/);
      if (match) currentIds.add(match[1]);
    }
    for (const id of ids) {
      if (!currentIds.has(id)) ids.delete(id);
    }
  } catch {}
}

// --- Auto-compact ---

function tryAcquireCompactLease() {
  try {
    const leaseData = { pid: process.pid, ts: Date.now() };
    fs.writeFileSync(COMPACT_LEASE_FILE, JSON.stringify(leaseData), { flag: 'wx' });
    return true;
  } catch {
    // Lease file already exists — check if we can force-break it
    try {
      const existing = JSON.parse(fs.readFileSync(COMPACT_LEASE_FILE, 'utf8'));
      // Never preempt a live owner, regardless of TTL
      if (existing.pid && existing.pid !== process.pid) {
        try { process.kill(existing.pid, 0); return false; } catch {}
        // Owner PID is dead — fall through to force-break
      }
      // Only force-break an expired lease with a dead owner
      if (Date.now() - existing.ts < COMPACT_LEASE_TTL_MS && existing.pid === process.pid) {
        return true; // we already hold it
      }
      fs.unlinkSync(COMPACT_LEASE_FILE);
      fs.writeFileSync(COMPACT_LEASE_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return true;
    } catch { return false; }
  }
}

function releaseCompactLease() {
  try { fs.unlinkSync(COMPACT_LEASE_FILE); } catch {}
}

function autoCompact() {
  const { withFileLock } = require('./file-io');
  const msgFile = getMessagesFile(state.currentBranch);
  if (!fs.existsSync(msgFile)) return;
  if (!tryAcquireCompactLease()) return;

  // Hold the messages-file lock across read→archive→rename so no append
  // can interleave and be lost. All appenders use withFileLock(msgFile).
  withFileLock(msgFile, () => {
    try {
      const content = fs.readFileSync(msgFile, 'utf8').trim();
      if (!content) return;
      const lines = content.split(/\r?\n/);
      if (lines.length < 500) return;

      const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      const agents = getAgents();
      const allAgentNames = Object.keys(agents);
      const retentionMs = (parseInt(process.env.NEOHIVE_RETENTION_HOURS) || 24) * 3600000;
      const allConsumed = new Set();
      const perAgentConsumed = {};
      if (fs.existsSync(DATA_DIR)) {
        for (const f of fs.readdirSync(DATA_DIR)) {
          if (f.startsWith('consumed-') && f.endsWith('.json')) {
            const agentName = f.replace('consumed-', '').replace('.json', '');
            try {
              const ids = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
              perAgentConsumed[agentName] = new Set(ids);
              ids.forEach(id => allConsumed.add(id));
            } catch {}
          }
        }
      }

      const active = messages.filter(m => {
        if (m.to === '__group__') {
          const msgTime = new Date(m.timestamp).getTime();
          if (msgTime < Date.now() - retentionMs) return false;
          return !allAgentNames.every(n => n === m.from || (perAgentConsumed[n] && perAgentConsumed[n].has(m.id)));
        }
        if (!allConsumed.has(m.id)) return true;
        return false;
      });

      const archived = messages.filter(m => !active.includes(m));
      if (archived.length > 0) {
        const dateStr = new Date().toISOString().slice(0, 10);
        const archiveFile = path.join(DATA_DIR, `archive-${dateStr}.jsonl`);
        const archiveContent = archived.map(m => JSON.stringify(m)).join('\n') + '\n';
        // If archive write fails, abort compaction — do not delete unarchived messages
        const archiveResult = withFileLock(archiveFile, () => {
          try { fs.appendFileSync(archiveFile, archiveContent); return true; }
          catch (e) { log.error('autoCompact archive write failed:', e.message); return false; }
        });
        if (!archiveResult) return; // archive lock failed or write failed — abort
      }

      const newContent = active.map(m => JSON.stringify(m)).join('\n') + (active.length ? '\n' : '');
      const tmpFile = `${msgFile}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpFile, newContent);
      try {
        fs.renameSync(tmpFile, msgFile);
      } catch {
        try { fs.unlinkSync(tmpFile); } catch {}
        return;
      }
      state.lastReadOffset = Buffer.byteLength(newContent, 'utf8');

      const activeIds = new Set(active.map(m => m.id));
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.startsWith('consumed-') && f.endsWith('.json')) {
          try {
            const fp = path.join(DATA_DIR, f);
            const ids = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const trimmed = ids.filter(id => activeIds.has(id));
            const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tmp, JSON.stringify(trimmed));
            fs.renameSync(tmp, fp);
          } catch (e) { log.debug('consumed trim failed:', e.message); }
        }
      }
    } catch (e) { log.warn('autoCompact failed:', e.message); }
  });

  releaseCompactLease();
}

module.exports = {
  consumedFile, getConsumedIds, saveConsumedIds, trimConsumedIds,
  autoCompact,
};
