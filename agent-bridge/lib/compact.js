'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const state = require('./state');
const { DATA_DIR, getMessagesFile, sanitizeName } = require('./config');
const { getAgents, isPidAlive } = require('./agents');

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
  fs.writeFileSync(consumedFile(agentName), JSON.stringify([...ids]));
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

function autoCompact() {
  const msgFile = getMessagesFile(state.currentBranch);
  if (!fs.existsSync(msgFile)) return;
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
      try { fs.appendFileSync(archiveFile, archiveContent); } catch (e) { log.error('autoCompact archive write failed:', e.message); }
    }

    const newContent = active.map(m => JSON.stringify(m)).join('\n') + (active.length ? '\n' : '');
    const tmpFile = msgFile + '.tmp';
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
          const ids = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
          const trimmed = ids.filter(id => activeIds.has(id));
          fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(trimmed));
        } catch (e) { log.debug('consumed trim failed:', e.message); }
      }
    }
  } catch (e) { log.warn('autoCompact failed:', e.message); }
}

module.exports = {
  consumedFile, getConsumedIds, saveConsumedIds, trimConsumedIds,
  autoCompact,
};
