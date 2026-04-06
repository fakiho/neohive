'use strict';

// Messaging tools (read-oriented): check, consume, ack, history, notifications, search.
// Extracted from server.js as part of modular tool architecture.
// Note: send_message, broadcast, handoff, share_file remain in server.js (deeply stateful).

const fs = require('fs');

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;

  const {
    getUnconsumedMessages, getConsumedIds, saveConsumedIds, markAsRead,
    getNotifications, saveNotifications, getAcks, getPermissions,
    getAgents, isPidAlive, getConfig, touchActivity,
    tailReadJsonl, readJsonl, getMessagesFile, getHistoryFile,
    getAgentChannels, getChannelHistoryFile,
    withFileLock,
  } = helpers;

  const { ACKS_FILE } = files;

  // --- Check Messages (peek, non-consuming) ---

  function toolCheckMessages(from) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const unconsumed = getUnconsumedMessages(state.registeredName, from || null);

    const senders = {};
    let addressedCount = 0;
    for (const m of unconsumed) {
      senders[m.from] = (senders[m.from] || 0) + 1;
      if (m.addressed_to && m.addressed_to.includes(state.registeredName)) addressedCount++;
    }

    const allNotifs = getNotifications();
    const unreadNotifs = allNotifs.filter(n => !n.read_by.includes(state.registeredName));

    const result = {
      count: unconsumed.length,
      pending_notifications: unreadNotifs.length,
      messages: unconsumed.map(m => ({
        id: m.id,
        from: m.from,
        preview: m.content.substring(0, 120),
        timestamp: m.timestamp,
        ...(m.addressed_to && { addressed_to: m.addressed_to }),
      })),
    };

    if (unconsumed.length > 0) {
      result.senders = senders;
      result.addressed_to_you = addressedCount;
      const latest = unconsumed[unconsumed.length - 1];
      result.preview = `${latest.from}: "${latest.content.substring(0, 80).replace(/\n/g, ' ')}..."`;
      const oldestAge = Math.round((Date.now() - new Date(unconsumed[0].timestamp).getTime()) / 1000);
      result.urgency = oldestAge > 120 ? 'critical' : oldestAge > 30 ? 'urgent' : 'normal';
      result.next_action = 'Call listen() to receive and process these messages.';
    } else {
      result.next_action = 'No messages. Call listen() to wait for new messages.';
    }

    return result;
  }

  // --- Consume Messages (grab all + mark read) ---

  function toolConsumeMessages(from, limit) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    let unconsumed = getUnconsumedMessages(state.registeredName, from || null);
    if (limit && limit > 0 && unconsumed.length > limit) {
      unconsumed = unconsumed.slice(0, limit);
    }

    if (unconsumed.length === 0) {
      return { success: true, count: 0, messages: [] };
    }

    const consumed = getConsumedIds(state.registeredName);
    for (const msg of unconsumed) {
      consumed.add(msg.id);
      markAsRead(state.registeredName, msg.id);
    }
    saveConsumedIds(state.registeredName, consumed);

    const msgFile = getMessagesFile(state.currentBranch);
    if (fs.existsSync(msgFile)) {
      state.lastReadOffset = fs.statSync(msgFile).size;
    }

    touchActivity();

    const remaining = getUnconsumedMessages(state.registeredName, null);
    const agents = getAgents();
    const agentsOnline = Object.entries(agents).filter(([, info]) => isPidAlive(info.pid, info.last_activity)).length;

    return {
      success: true,
      count: unconsumed.length,
      messages: unconsumed.map(m => ({
        id: m.id,
        from: m.from,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.reply_to && { reply_to: m.reply_to }),
        ...(m.thread_id && { thread_id: m.thread_id }),
        ...(m.addressed_to && { addressed_to: m.addressed_to }),
      })),
      remaining: remaining.length,
      agents_online: agentsOnline,
      coordinator_mode: getConfig().coordinator_mode || 'responsive',
    };
  }

  // --- Ack Message ---

  function toolAckMessage(messageId) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const history = tailReadJsonl(getHistoryFile(state.currentBranch), 100);
    const msg = history.find(m => m.id === messageId);
    if (msg && msg.to !== state.registeredName) {
      return { error: 'Can only acknowledge messages addressed to you' };
    }

    withFileLock(ACKS_FILE, () => {
      const acks = getAcks();
      acks[messageId] = {
        acked_by: state.registeredName,
        acked_at: new Date().toISOString(),
      };
      fs.writeFileSync(ACKS_FILE, JSON.stringify(acks));
    });
    touchActivity();

    return { success: true, message: `Message ${messageId} acknowledged` };
  }

  // --- Get History ---

  function toolGetHistory(limit, thread_id) {
    limit = Math.min(Math.max(1, limit || 50), 500);
    let history = tailReadJsonl(getHistoryFile(state.currentBranch), limit * 2);
    if (thread_id) {
      history = history.filter(m => m.thread_id === thread_id || m.id === thread_id);
    }
    if (state.registeredName) {
      const perms = getPermissions();
      if (perms[state.registeredName] && perms[state.registeredName].can_read) {
        const allowed = perms[state.registeredName].can_read;
        if (allowed !== '*' && Array.isArray(allowed)) {
          history = history.filter(m => m.from === state.registeredName || m.to === state.registeredName || allowed.includes(m.from));
        }
      }
    }
    const recent = history.slice(-limit);
    const acks = getAcks();

    return {
      count: recent.length,
      total: history.length,
      messages: recent.map(m => ({
        id: m.id,
        from: m.from,
        to: m.to,
        content: m.content,
        timestamp: m.timestamp,
        acked: !!acks[m.id],
        ...(m.reply_to && { reply_to: m.reply_to }),
        ...(m.thread_id && { thread_id: m.thread_id }),
      })),
    };
  }

  // --- Get Notifications ---

  function toolGetNotifications(since, type) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    let notifs = getNotifications();
    notifs = notifs.filter(n => !n.read_by.includes(state.registeredName));
    if (since) {
      const sinceTs = new Date(since).getTime();
      notifs = notifs.filter(n => new Date(n.timestamp).getTime() > sinceTs);
    }
    if (type) {
      notifs = notifs.filter(n => n.type === type);
    }
    if (notifs.length > 0) {
      const allNotifs = getNotifications();
      const readIds = new Set(notifs.map(n => n.id));
      for (const n of allNotifs) {
        if (readIds.has(n.id) && !n.read_by.includes(state.registeredName)) {
          n.read_by.push(state.registeredName);
        }
      }
      saveNotifications(allNotifs);
    }
    return {
      count: notifs.length,
      notifications: notifs.map(n => ({
        id: n.id,
        type: n.type,
        source_agent: n.source_agent,
        related_id: n.related_id,
        summary: n.summary,
        timestamp: n.timestamp,
      })),
    };
  }

  // --- Search Messages ---

  function toolSearchMessages(query, from, limit) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof query !== 'string' || query.length < 2) return { error: 'Query must be at least 2 characters' };
    limit = Math.min(Math.max(1, limit || 20), 50);
    from = from || null;

    const queryLower = query.toLowerCase();
    let allMessages = tailReadJsonl(getHistoryFile(state.currentBranch), 500);
    try {
      const myChannels = getAgentChannels(state.registeredName);
      for (const ch of myChannels) {
        if (ch === 'general') continue;
        const chFile = getChannelHistoryFile(ch);
        if (fs.existsSync(chFile)) {
          allMessages = allMessages.concat(tailReadJsonl(chFile, 100));
        }
      }
    } catch (e) { /* channel read failed */ }
    allMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const results = [];
    for (let i = 0; i < allMessages.length && results.length < limit; i++) {
      const m = allMessages[i];
      if (from && m.from !== from) continue;
      if (m.content && m.content.toLowerCase().includes(queryLower)) {
        results.push({
          id: m.id, from: m.from, to: m.to,
          preview: m.content.substring(0, 200),
          timestamp: m.timestamp,
          ...(m.channel && { channel: m.channel }),
        });
      }
    }
    // Fall back to full read if tail search found nothing
    if (results.length === 0) {
      allMessages = readJsonl(getHistoryFile(state.currentBranch));
      try {
        const myChannels = getAgentChannels(state.registeredName);
        for (const ch of myChannels) {
          if (ch === 'general') continue;
          const chFile = getChannelHistoryFile(ch);
          if (fs.existsSync(chFile)) {
            allMessages = allMessages.concat(readJsonl(chFile));
          }
        }
      } catch (e) { /* channel read failed */ }
      allMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      for (let i = 0; i < allMessages.length && results.length < limit; i++) {
        const m = allMessages[i];
        if (from && m.from !== from) continue;
        if (m.content && m.content.toLowerCase().includes(queryLower)) {
          results.push({
            id: m.id, from: m.from, to: m.to,
            preview: m.content.substring(0, 200),
            timestamp: m.timestamp,
            ...(m.channel && { channel: m.channel }),
          });
        }
      }
    }
    return { query, results_count: results.length, results, searched: allMessages.length };
  }

  // --- MCP tool definitions ---

  const definitions = [
    {
      name: 'check_messages',
      description: 'Non-blocking PEEK at your inbox — shows message previews but does NOT consume them. Use listen() to actually receive and process messages. Do NOT call this in a loop — it wastes tokens returning the same messages repeatedly. Use listen() instead which blocks efficiently and consumes messages.',
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'Only check messages from this agent (optional)' } }, additionalProperties: false },
    },
    {
      name: 'consume_messages',
      description: 'Non-blocking check that returns ALL unconsumed messages with full content AND marks them as consumed. Unlike check_messages (peek-only) or listen (blocking), this is a one-shot "grab everything and mark it read" call. Ideal for agents that need to process a batch of messages without blocking.',
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'Only consume from this agent (optional)' }, limit: { type: 'number', description: 'Max messages to consume (optional)' } }, additionalProperties: false },
    },
    {
      name: 'ack_message',
      description: 'Acknowledge a message — marks it as seen/received in the history. Appears as a read receipt in the dashboard.',
      inputSchema: { type: 'object', properties: { message_id: { type: 'string', description: 'ID of the message to acknowledge' } }, required: ['message_id'], additionalProperties: false },
    },
    {
      name: 'get_history',
      description: 'Get recent conversation history. Returns messages with acknowledgment status. Filter by thread_id to view a specific conversation thread.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Number of recent messages (default: 50, max: 500)' }, thread_id: { type: 'string', description: 'Filter by thread ID (optional)' } }, additionalProperties: false },
    },
    {
      name: 'get_notifications',
      description: 'Get unread notifications (task completions, workflow advances, agent status changes). Returns and marks as read. Non-blocking — use this instead of listen() when you need a quick status update without waiting.',
      inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'ISO timestamp — only notifications after this time (optional)' }, type: { type: 'string', description: 'Filter by type: task_done, workflow_advanced, agent_join, etc. (optional)' } }, additionalProperties: false },
    },
    {
      name: 'search_messages',
      description: 'Search conversation history by keyword. Returns matching messages with previews. Useful for finding past discussions, decisions, or code references.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search term (min 2 chars)' }, from: { type: 'string', description: 'Filter by sender agent name (optional)' }, limit: { type: 'number', description: 'Max results (default: 20, max: 50)' } }, required: ['query'], additionalProperties: false },
    },
  ];

  const handlers = {
    check_messages: function (args) { return toolCheckMessages(args.from); },
    consume_messages: function (args) { return toolConsumeMessages(args.from, args.limit); },
    ack_message: function (args) { return toolAckMessage(args.message_id); },
    get_history: function (args) { return toolGetHistory(args.limit, args.thread_id); },
    get_notifications: function (args) { return toolGetNotifications(args.since, args.type); },
    search_messages: function (args) { return toolSearchMessages(args.query, args.from, args.limit); },
  };

  return { definitions, handlers };
};
