'use strict';

const fs = require('fs');
const state = require('./state');
const config = require('./config');
const {
  getMessagesFile, getHistoryFile, generateId, ensureDataDir,
  validateContentSize, TASKS_FILE, DECISIONS_FILE, KB_FILE, PROGRESS_FILE, LOCKS_FILE,
} = config;
const { readJsonFile, tailReadJsonl } = require('./file-io');
const { getAgents, isPidAlive, getProfiles } = require('./agents');
const compact = require('./compact');

// Rate limiting constants
const rateLimitWindow = 60000;
const rateLimitMax = 30;

function checkRateLimit(content, to) {
  const now = Date.now();
  state.rateLimitMessages = state.rateLimitMessages.filter(t => now - t < rateLimitWindow);
  if (state.rateLimitMessages.length >= rateLimitMax) {
    return { error: `Rate limit exceeded: max ${rateLimitMax} messages per minute. Wait before sending more.` };
  }
  state.recentSentMessages = state.recentSentMessages.filter(m => now - m.timestamp < 30000);
  if (content && typeof content === 'string' && to) {
    const contentKey = content.substring(0, 200);
    const dup = state.recentSentMessages.find(m => m.to === to && m.content === contentKey);
    if (dup) {
      return { error: `Duplicate message detected — you already sent this to ${to} ${Math.round((now - dup.timestamp) / 1000)}s ago. Send a different message.` };
    }
    state.recentSentMessages.push({ content: contentKey, to, timestamp: now });
    if (state.recentSentMessages.length > 50) state.recentSentMessages = state.recentSentMessages.slice(-30);
  }
  state.rateLimitMessages.push(now);
  return null;
}

function sendSystemMessage(toAgent, content) {
  state.messageSeq++;
  const agents = getAgents();
  const recipientBranch = (agents[toAgent] && agents[toAgent].branch) || state.currentBranch;
  const msg = {
    id: generateId(),
    seq: state.messageSeq,
    from: '__system__',
    to: toAgent,
    content,
    timestamp: new Date().toISOString(),
    system: true,
  };
  ensureDataDir();
  fs.appendFileSync(getMessagesFile(recipientBranch), JSON.stringify(msg) + '\n');
  fs.appendFileSync(getHistoryFile(recipientBranch), JSON.stringify(msg) + '\n');
}

// Match server.js: [STATUS] broadcasts are history/dashboard-only (not agent inbox).
function isHistoryOnlySystemStatus(content) {
  return typeof content === 'string' && content.startsWith('[STATUS]');
}

function broadcastSystemMessage(content, excludeAgent = null) {
  state.messageSeq++;
  const msg = {
    id: generateId(),
    seq: state.messageSeq,
    from: '__system__',
    to: '__group__',
    content,
    timestamp: new Date().toISOString(),
    system: true,
  };
  if (excludeAgent) msg.exclude_agent = excludeAgent;
  ensureDataDir();
  if (!isHistoryOnlySystemStatus(content)) {
    fs.appendFileSync(getMessagesFile(state.currentBranch), JSON.stringify(msg) + '\n');
  }
  fs.appendFileSync(getHistoryFile(state.currentBranch), JSON.stringify(msg) + '\n');
}

// Read new lines from messages.jsonl starting at a byte offset
function readNewMessages(fromOffset, branch) {
  const msgFile = getMessagesFile(branch || state.currentBranch);
  return readNewMessagesFromFile(fromOffset, msgFile);
}

function readNewMessagesFromFile(fromOffset, filePath) {
  if (!fs.existsSync(filePath)) return { messages: [], newOffset: 0 };
  const stat = fs.statSync(filePath);
  if (stat.size < fromOffset) return { messages: [], newOffset: 0 };
  if (stat.size === fromOffset) return { messages: [], newOffset: fromOffset };
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(stat.size - fromOffset);
  fs.readSync(fd, buf, 0, buf.length, fromOffset);
  fs.closeSync(fd);
  const chunk = buf.toString('utf8').trim();
  if (!chunk) return { messages: [], newOffset: stat.size };
  const messages = chunk.split(/\r?\n/).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return { messages, newOffset: stat.size };
}

// Build standard message delivery response
function buildMessageResponse(msg, consumedIds) {
  const log = require('./logger');
  let pendingCount = 0;
  try {
    const msgFile = getMessagesFile(state.currentBranch);
    if (fs.existsSync(msgFile)) {
      const { messages: tail } = readNewMessages(state.lastReadOffset);
      pendingCount = tail.filter(m => m.to === state.registeredName && m.id !== msg.id && !consumedIds.has(m.id)).length;
    }
  } catch (e) { log.debug('pending count failed:', e.message); }

  const agents = getAgents();
  const agentsOnline = Object.entries(agents).filter(([, info]) => isPidAlive(info.pid, info.last_activity)).length;

  return {
    success: true,
    message: {
      id: msg.id,
      from: msg.from,
      content: msg.content,
      timestamp: msg.timestamp,
      ...(msg.reply_to && { reply_to: msg.reply_to }),
      ...(msg.thread_id && { thread_id: msg.thread_id }),
    },
    pending_count: pendingCount,
    agents_online: agentsOnline,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function adaptiveSleep(pollCount) {
  if (pollCount < 10) return sleep(500);
  if (pollCount < 30) return sleep(1000);
  return sleep(2000);
}

function hubSendUserMessage(fromName, content, to, reply_to, _channel) {
  const rateErr = checkRateLimit(content, to || '__broadcast__');
  if (rateErr) return rateErr;
  const sizeErr = validateContentSize(content);
  if (sizeErr) return sizeErr;
  if (!fromName || typeof fromName !== 'string') return { error: 'fromName is required' };
  const branch = state.currentBranch || 'main';
  state.messageSeq++;
  const msg = {
    id: generateId(),
    seq: state.messageSeq,
    from: fromName,
    to: to || '__all__',
    content,
    timestamp: new Date().toISOString(),
    ...(reply_to && { reply_to }),
  };
  ensureDataDir();
  const mf = getMessagesFile(branch);
  const hf = getHistoryFile(branch);
  fs.appendFileSync(mf, JSON.stringify(msg) + '\n');
  fs.appendFileSync(hf, JSON.stringify(msg) + '\n');
  return { success: true, id: msg.id };
}

function messageVisibleToAgent(m, agentName) {
  if (!m || !agentName) return false;
  if (m.to === agentName || m.to === '__all__') return true;
  if (m.to === '__group__') return m.from !== agentName;
  return false;
}

/** @returns {number} batch size 1–20 (default 1) for hub listen */
function hubParseListenN(n) {
  if (n == null || n === '') return 1;
  const x = Number(n);
  if (!Number.isFinite(x)) return 1;
  const i = Math.floor(x);
  if (i < 1) return 1;
  return Math.min(20, i);
}

function hubListenNext(agentName, opts = {}) {
  if (!agentName || typeof agentName !== 'string') return { error: 'agentName is required' };
  const n = hubParseListenN(opts.n);
  const branch = opts.branch || state.currentBranch || 'main';
  const fromFilter = opts.from || null;
  const mf = getMessagesFile(branch);
  if (!fs.existsSync(mf)) {
    return n === 1
      ? { success: true, message: null }
      : { success: true, messages: [], count: 0, pending_count: 0 };
  }
  const consumed = compact.getConsumedIds(agentName);
  const raw = fs.readFileSync(mf, 'utf8').trim();
  if (!raw) {
    return n === 1
      ? { success: true, message: null }
      : { success: true, messages: [], count: 0, pending_count: 0 };
  }

  function countPendingVisible(consumedSet) {
    let c = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (consumedSet.has(m.id)) continue;
      if (!messageVisibleToAgent(m, agentName)) continue;
      if (fromFilter && m.from !== fromFilter) continue;
      c++;
    }
    return c;
  }

  if (n === 1) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (consumed.has(m.id)) continue;
      if (!messageVisibleToAgent(m, agentName)) continue;
      if (fromFilter && m.from !== fromFilter) continue;
      consumed.add(m.id);
      compact.saveConsumedIds(agentName, consumed);
      return { success: true, message: m };
    }
    return { success: true, message: null };
  }

  const collected = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (consumed.has(m.id)) continue;
    if (!messageVisibleToAgent(m, agentName)) continue;
    if (fromFilter && m.from !== fromFilter) continue;
    consumed.add(m.id);
    collected.push(m);
    if (collected.length >= n) break;
  }
  if (collected.length === 0) {
    return { success: true, messages: [], count: 0, pending_count: countPendingVisible(consumed) };
  }
  compact.saveConsumedIds(agentName, consumed);
  return {
    success: true,
    messages: collected,
    count: collected.length,
    pending_count: countPendingVisible(consumed),
  };
}

function hubBuildBriefing(agentName) {
  if (!agentName || typeof agentName !== 'string') return { error: 'agentName is required' };
  const agents = getAgents();
  const profiles = getProfiles();
  const tasks = readJsonFile(TASKS_FILE) || [];
  const decisions = readJsonFile(DECISIONS_FILE) || [];
  const kb = readJsonFile(KB_FILE) || {};
  const progress = readJsonFile(PROGRESS_FILE) || {};
  const locks = readJsonFile(LOCKS_FILE) || {};
  const cfg = config.getConfig();
  const branch = state.currentBranch || 'main';
  const history = tailReadJsonl(getHistoryFile(branch), 30);
  const roster = {};
  for (const [name, info] of Object.entries(agents)) {
    const alive = isPidAlive(info.pid, info.last_activity);
    const profile = profiles[name] || {};
    roster[name] = {
      status: !alive ? 'offline' : info.listening_since ? 'listening' : 'working',
      role: profile.role || '',
      provider: info.provider || 'unknown',
    };
  }
  const recentMsgs = history.slice(-15).map((m) => ({
    from: m.from,
    to: m.to,
    preview: (m.content || '').substring(0, 150),
    timestamp: m.timestamp,
  }));
  const activeTasks = tasks.filter((t) => t.status !== 'done').map((t) => ({
    id: t.id, title: t.title, status: t.status, assignee: t.assignee, created_by: t.created_by,
  }));
  const doneTasks = tasks.filter((t) => t.status === 'done').length;
  const lockedFiles = {};
  for (const [fp, lock] of Object.entries(locks)) {
    lockedFiles[fp] = { locked_by: lock.agent, since: lock.since };
  }
  const myActiveTasks = tasks.filter((t) => t.status !== 'done' && t.assignee === agentName);
  const myCompletedCount = tasks.filter((t) => t.status === 'done' && t.assignee === agentName).length;
  return {
    briefing: true,
    conversation_mode: cfg.conversation_mode || 'direct',
    agents: roster,
    your_name: agentName,
    recent_messages: recentMsgs,
    tasks: { active: activeTasks, completed_count: doneTasks, total: tasks.length },
    decisions: decisions.slice(-5).map((d) => ({ decision: d.decision, topic: d.topic })),
    knowledge_base_keys: Object.keys(kb),
    locked_files: lockedFiles,
    progress,
    your_tasks: myActiveTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    your_completed: myCompletedCount,
    next_action: myActiveTasks.length > 0
      ? `You have ${myActiveTasks.length} active task(s). Continue working, then listen().`
      : 'Call listen() to receive messages and start working.',
  };
}

module.exports = {
  checkRateLimit,
  sendSystemMessage, broadcastSystemMessage,
  readNewMessages, readNewMessagesFromFile,
  buildMessageResponse,
  sleep, adaptiveSleep,
  hubSendUserMessage,
  hubListenNext,
  hubBuildBriefing,
};
