'use strict';

// System tools: profiles, workspaces, branches, reputation.
// Extracted from server.js as part of modular tool architecture.

const fs = require('fs');

module.exports = function (ctx) {
  const { state, helpers } = ctx;

  const {
    getProfiles, saveProfiles, getWorkspace, saveWorkspace, ensureDataDir,
    getAgents, getBranches, getHistoryFile, getReputation, touchActivity,
  } = helpers;

  // --- Profile ---

  function toolUpdateProfile(displayName, avatar, bio, role) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const profiles = getProfiles();
    if (!profiles[state.registeredName]) {
      profiles[state.registeredName] = { display_name: state.registeredName, avatar: '', bio: '', role: '', created_at: new Date().toISOString() };
    }
    const p = profiles[state.registeredName];
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== 'string' || displayName.length > 30) return { error: 'display_name must be <= 30 chars' };
      p.display_name = displayName;
    }
    if (avatar !== undefined && avatar !== null) {
      if (typeof avatar !== 'string' || avatar.length > 65536) return { error: 'avatar too large (max 64KB)' };
      p.avatar = avatar;
    }
    if (bio !== undefined && bio !== null) {
      if (typeof bio !== 'string' || bio.length > 200) return { error: 'bio must be <= 200 chars' };
      p.bio = bio;
    }
    if (role !== undefined && role !== null) {
      if (typeof role !== 'string' || role.length > 30) return { error: 'role must be <= 30 chars' };
      p.role = role;
    }
    p.updated_at = new Date().toISOString();
    saveProfiles(profiles);
    return { success: true, profile: p };
  }

  // --- Workspace ---

  function toolWorkspaceWrite(key, content) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof key !== 'string' || key.length < 1 || key.length > 50) return { error: 'key must be 1-50 chars' };
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(key)) return { error: 'key must be alphanumeric/underscore/hyphen/dot' };
    if (typeof content !== 'string') return { error: 'content must be a string' };
    if (Buffer.byteLength(content, 'utf8') > 102400) return { error: 'content exceeds 100KB limit' };

    ensureDataDir();
    const ws = getWorkspace(state.registeredName);
    if (!ws[key] && Object.keys(ws).length >= 50) return { error: 'Maximum 50 keys per workspace' };
    ws[key] = { content, updated_at: new Date().toISOString() };
    saveWorkspace(state.registeredName, ws);
    touchActivity();
    return { success: true, key, size: content.length, total_keys: Object.keys(ws).length };
  }

  function toolWorkspaceRead(key, agent) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    const targetAgent = agent || state.registeredName;
    if (targetAgent !== state.registeredName && !/^[a-zA-Z0-9_-]{1,20}$/.test(targetAgent)) {
      return { error: 'Invalid agent name' };
    }

    const ws = getWorkspace(targetAgent);
    if (key) {
      if (!ws[key]) return { error: `Key "${key}" not found in ${targetAgent}'s workspace` };
      return { agent: targetAgent, key, content: ws[key].content, updated_at: ws[key].updated_at };
    }
    const entries = {};
    for (const [k, v] of Object.entries(ws)) {
      entries[k] = { content: v.content, updated_at: v.updated_at };
    }
    return { agent: targetAgent, entries, total_keys: Object.keys(ws).length };
  }

  function toolWorkspaceList(agent) {
    const agents = getAgents();
    if (agent) {
      if (!/^[a-zA-Z0-9_-]{1,20}$/.test(agent)) return { error: 'Invalid agent name' };
      const ws = getWorkspace(agent);
      return { agent, keys: Object.keys(ws).map(k => ({ key: k, size: ws[k].content.length, updated_at: ws[k].updated_at })) };
    }
    const result = {};
    for (const name of Object.keys(agents)) {
      const ws = getWorkspace(name);
      result[name] = { key_count: Object.keys(ws).length, keys: Object.keys(ws) };
    }
    return { workspaces: result };
  }

  // --- Branches ---

  function toolListBranches() {
    const branches = getBranches();
    const result = {};
    for (const [name, info] of Object.entries(branches)) {
      const histFile = getHistoryFile(name);
      let msgCount = 0;
      if (fs.existsSync(histFile)) {
        const content = fs.readFileSync(histFile, 'utf8').trim();
        if (content) msgCount = content.split(/\r?\n/).filter(l => l.trim()).length;
      }
      result[name] = { ...info, message_count: msgCount, is_current: name === state.currentBranch };
    }
    return { branches: result, current: state.currentBranch };
  }

  // --- Reputation ---

  function toolGetReputation(agent) {
    const rep = getReputation();

    if (agent) {
      if (!rep[agent]) return { agent, message: 'No reputation data yet for this agent.' };
      return { agent, reputation: rep[agent] };
    }

    const leaderboard = Object.entries(rep).map(([name, r]) => {
      const avgTaskTime = r.task_times && r.task_times.length > 0
        ? Math.round(r.task_times.reduce((a, b) => a + b, 0) / r.task_times.length) : null;
      return {
        agent: name,
        score: r.tasks_completed * 10 + r.reviews_done * 5 + r.decisions_made * 3 + r.kb_contributions * 2 + r.bugs_found * 8,
        tasks_completed: r.tasks_completed,
        reviews_done: r.reviews_done,
        strengths: r.strengths,
        avg_task_time_sec: avgTaskTime,
        messages_sent: r.messages_sent,
        last_active: r.last_active,
      };
    }).sort((a, b) => b.score - a.score);

    return { leaderboard, total_agents: leaderboard.length };
  }

  // --- MCP tool definitions ---

  const definitions = [
    {
      name: 'update_profile',
      description: 'Update your agent profile (display name, avatar, bio, role). Profile data is shown in the dashboard.',
      inputSchema: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'Display name (max 30 chars)' },
          avatar: { type: 'string', description: 'Avatar URL or data URI (max 64KB)' },
          bio: { type: 'string', description: 'Short bio (max 200 chars)' },
          role: { type: 'string', description: 'Role/title (max 30 chars, e.g. "Architect", "Reviewer")' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'workspace_write',
      description: 'Write a key-value entry to your workspace. Other agents can read your workspace but only you can write to it. Max 50 keys, 100KB per value.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key name (1-50 alphanumeric/underscore/hyphen/dot chars)' }, content: { type: 'string', description: 'Content to store (max 100KB)' } }, required: ['key', 'content'], additionalProperties: false },
    },
    {
      name: 'workspace_read',
      description: 'Read workspace entries. Read your own or another agent\'s workspace. Omit key to read all entries.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Specific key to read (optional — omit for all keys)' }, agent: { type: 'string', description: 'Agent whose workspace to read (optional — defaults to yourself)' } }, additionalProperties: false },
    },
    {
      name: 'workspace_list',
      description: 'List workspace keys. Specify agent for one workspace, or omit for all agents\' workspace summaries.',
      inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent name (optional — omit for all)' } }, additionalProperties: false },
    },
    {
      name: 'list_branches',
      description: 'List all conversation branches with message counts and metadata.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_reputation',
      description: 'View agent reputation — tasks completed, reviews done, bugs found, strengths. Shows leaderboard when called without agent name.',
      inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent name (optional — omit for leaderboard)' } }, additionalProperties: false },
    },
  ];

  const handlers = {
    update_profile: function (args) { return toolUpdateProfile(args.display_name, args.avatar, args.bio, args.role); },
    workspace_write: function (args) { return toolWorkspaceWrite(args.key, args.content); },
    workspace_read: function (args) { return toolWorkspaceRead(args.key, args.agent); },
    workspace_list: function (args) { return toolWorkspaceList(args.agent); },
    list_branches: function () { return toolListBranches(); },
    get_reputation: function (args) { return toolGetReputation(args.agent); },
  };

  return { definitions, handlers };
};
