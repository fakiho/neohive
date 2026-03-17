'use strict';

const fs = require('fs');
const state = require('./state');
const { DATA_DIR, getMessagesFile, getHistoryFile, generateId, ensureDataDir } = require('./config');
const { readJsonlFromOffset } = require('./file-io');
const { getAgents, isPidAlive } = require('./agents');

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
  fs.appendFileSync(getMessagesFile(state.currentBranch), JSON.stringify(msg) + '\n');
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

module.exports = {
  checkRateLimit,
  sendSystemMessage, broadcastSystemMessage,
  readNewMessages, readNewMessagesFromFile,
  buildMessageResponse,
  sleep, adaptiveSleep,
};
