'use strict';

// Knowledge tools: KB, decisions, compressed history, briefing, summary, progress.
// Extracted from server.js as part of modular tool architecture.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;

  const {
    getDecisions, getKB, getProgressData, getCompressed, getLocks, getConfig,
    generateId, writeJsonFile, readJsonFile, touchActivity, tailReadJsonl,
    getHistoryFile, getAgents, isPidAlive, getProfiles, getTasks, cachedRead,
    inspectMethodology, listArtifacts, projectRoot,
  } = helpers;

  const { DECISIONS_FILE, KB_FILE, PROGRESS_FILE, COMPRESSED_FILE } = files;

  // --- Decisions ---

  function toolLogDecision(decision, reasoning, topic) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof decision !== 'string' || decision.length < 1 || decision.length > 500) return { error: 'Decision must be 1-500 chars' };

    const decisions = getDecisions();
    const entry = {
      id: 'dec_' + generateId(),
      decision,
      reasoning: (reasoning || '').substring(0, 1000),
      topic: (topic || 'general').substring(0, 50),
      decided_by: state.registeredName,
      decided_at: new Date().toISOString(),
    };
    decisions.push(entry);
    if (decisions.length > 200) decisions.splice(0, decisions.length - 200);
    writeJsonFile(DECISIONS_FILE, decisions);
    touchActivity();
    return { success: true, decision_id: entry.id, message: 'Decision logged. Other agents can see it via get_decisions() or get_briefing().' };
  }

  function toolGetDecisions(topic) {
    let decisions = getDecisions();
    if (topic) decisions = decisions.filter(d => d.topic === topic);
    return { count: decisions.length, decisions: decisions.slice(-30) };
  }

  // --- Knowledge Base ---

  function toolKBWrite(key, content) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof key !== 'string' || key.length < 1 || key.length > 50) return { error: 'Key must be 1-50 chars' };
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(key)) return { error: 'Key must be alphanumeric/underscore/hyphen/dot' };
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 102400) return { error: 'Content exceeds 100KB' };

    const kb = getKB();
    // Check the cap BEFORE mutating the cached object — a new key that would exceed
    // the limit must not leave a phantom entry in the in-memory cache (amplified by
    // kb_mirror writing many keys in one action).
    if (!(key in kb) && Object.keys(kb).length >= 100) return { error: 'Knowledge base full (max 100 keys)' };
    kb[key] = { content, updated_by: state.registeredName, updated_at: new Date().toISOString() };
    writeJsonFile(KB_FILE, kb);
    touchActivity();
    return { success: true, key, size: content.length, total_keys: Object.keys(kb).length };
  }

  function toolKBRead(key) {
    const kb = getKB();
    if (key) {
      if (!kb[key]) return { error: `Key "${key}" not found in knowledge base` };
      return { key, content: kb[key].content, updated_by: kb[key].updated_by, updated_at: kb[key].updated_at };
    }
    const entries = {};
    for (const [k, v] of Object.entries(kb)) {
      entries[k] = { content: v.content, updated_by: v.updated_by, updated_at: v.updated_at };
    }
    return { entries, total_keys: Object.keys(kb).length };
  }

  function toolKBList() {
    const kb = getKB();
    return {
      keys: Object.keys(kb).map(k => ({ key: k, updated_by: kb[k].updated_by, updated_at: kb[k].updated_at, size: kb[k].content.length })),
      total: Object.keys(kb).length,
    };
  }

  // --- BMad kb mirror (AD-4 / FR4 / Story 2.2) ---
  // One-way, on-demand, idempotent upsert: reads PRD/architecture/decision BMad
  // artifacts and writes one kb entry per artifact via the existing kb_write path.
  // Never writes back to the BMad files. No polling — this only runs when invoked.

  const MIRROR_KB_CONTENT_LIMIT = 100 * 1024 - 2048; // stay under kb_write's 100KB cap after header overhead

  function isMirrorTarget(artifact) {
    if (artifact.kind === 'prd' || artifact.kind === 'architecture') return true;
    return /decision/i.test(artifact.relative_path || '');
  }

  function mirrorKeyFor(artifact) {
    // kb keys must be 1-50 alphanumeric/underscore/hyphen/dot chars (kb_write's schema),
    // so the source path is embedded in the kb entry content rather than used verbatim
    // as the key. The key itself is a deterministic hash of the source path, which is
    // what makes re-running the mirror an upsert (same path -> same key) instead of a
    // duplicate insert.
    const hash = crypto.createHash('sha1').update(artifact.relative_path).digest('hex').slice(0, 16);
    return `bmad_mirror_${artifact.kind}_${hash}`;
  }

  function toolKBMirror() {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof listArtifacts !== 'function' || !projectRoot) {
      return { success: true, mirrored: 0, skipped: 0, artifacts_found: 0, message: 'BMad artifact listing unavailable — no-op.' };
    }

    let artifacts;
    try {
      artifacts = listArtifacts(projectRoot, { hash: false }) || [];
    } catch {
      artifacts = [];
    }

    const targets = artifacts.filter(isMirrorTarget);
    if (targets.length === 0) {
      // NFR4: inert / clean no-op on non-BMad projects (or ones with no matching artifacts).
      return { success: true, mirrored: 0, skipped: 0, artifacts_found: artifacts.length, message: 'No PRD/architecture/decision BMad artifacts found — nothing to mirror.' };
    }

    const mirrored = [];
    const skipped = [];
    for (const artifact of targets) {
      const absolute = path.join(projectRoot, artifact.path);
      let raw;
      try {
        raw = fs.readFileSync(absolute, 'utf8');
      } catch (e) {
        skipped.push({ path: artifact.path, reason: 'read_failed' });
        continue;
      }
      const truncated = Buffer.byteLength(raw, 'utf8') > MIRROR_KB_CONTENT_LIMIT;
      const body = truncated ? raw.slice(0, MIRROR_KB_CONTENT_LIMIT) + '\n...[truncated]' : raw;
      const content = `[BMad Mirror] source: ${artifact.path} | kind: ${artifact.kind} | mirrored_at: ${new Date().toISOString()}\n---\n${body}`;
      const key = mirrorKeyFor(artifact);
      const result = toolKBWrite(key, content);
      if (result.error) {
        skipped.push({ path: artifact.path, reason: result.error });
      } else {
        mirrored.push({ path: artifact.path, kind: artifact.kind, key });
      }
    }

    touchActivity();
    return {
      success: true,
      mirrored: mirrored.length,
      skipped: skipped.length,
      artifacts_found: artifacts.length,
      entries: mirrored,
      skipped_entries: skipped,
      message: `Mirrored ${mirrored.length} BMad artifact(s) into the kb (one-way; BMad files are authoritative and were not modified).`,
    };
  }

  // --- Progress ---

  function toolUpdateProgress(feature, percent, notes) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof feature !== 'string' || feature.length < 1 || feature.length > 100) return { error: 'Feature name must be 1-100 chars' };
    if (typeof percent !== 'number' || percent < 0 || percent > 100) return { error: 'Percent must be 0-100' };

    const progress = getProgressData();
    progress[feature] = {
      percent,
      notes: (notes || '').substring(0, 500),
      updated_by: state.registeredName,
      updated_at: new Date().toISOString(),
    };
    writeJsonFile(PROGRESS_FILE, progress);
    touchActivity();
    return { success: true, feature, percent, message: `Progress updated: ${feature} is ${percent}% complete.` };
  }

  function toolGetProgress() {
    const progress = getProgressData();
    const features = Object.entries(progress).map(([name, p]) => ({
      feature: name, percent: p.percent, notes: p.notes, updated_by: p.updated_by, updated_at: p.updated_at,
    }));
    const avg = features.length > 0 ? Math.round(features.reduce((s, f) => s + f.percent, 0) / features.length) : 0;
    return { features, overall_percent: avg, feature_count: features.length };
  }

  // --- Compressed History ---

  function toolGetCompressedHistory() {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const compressed = getCompressed();
    const recent = tailReadJsonl(getHistoryFile(state.currentBranch), 20);

    return {
      compressed_segments: compressed.segments.slice(-20).map(s => ({
        time_range: s.from_time + ' to ' + s.to_time,
        speakers: s.speakers,
        message_count: s.message_count,
        summary: s.summary,
      })),
      recent_messages: recent.map(m => ({
        id: m.id, from: m.from, to: m.to,
        content: m.content.substring(0, 300),
        timestamp: m.timestamp,
      })),
      total_messages: compressed.segments.reduce((s, seg) => s + seg.message_count, 0) + recent.length,
      compressed_count: compressed.segments.reduce((s, seg) => s + seg.message_count, 0),
      recent_count: recent.length,
      next_action: 'Call listen() to receive messages.',
    };
  }

  // --- Summary ---

  function toolGetSummary(lastN) {
    lastN = Math.min(Math.max(1, lastN || 20), 500);
    const recent = tailReadJsonl(getHistoryFile(state.currentBranch), lastN);
    if (recent.length === 0) {
      return { summary: 'No messages in conversation yet.', message_count: 0 };
    }

    const agentsData = getAgents();
    const agents = Object.keys(agentsData);
    const threads = [...new Set(recent.filter(m => m.thread_id).map(m => m.thread_id))];

    const lines = recent.map(m => {
      const preview = m.content.length > 150 ? m.content.substring(0, 150) + '...' : m.content;
      return `[${m.from} → ${m.to}]: ${preview}`;
    });

    return {
      total_messages: recent.length,
      showing_last: recent.length,
      agents_involved: agents,
      thread_count: threads.length,
      first_message: recent[0].timestamp,
      last_message: recent[recent.length - 1].timestamp,
      summary: lines.join('\n'),
    };
  }

  // --- Briefing ---

  function toolGetBriefing() {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const agents = getAgents();
    const profiles = getProfiles();
    const tasks = getTasks();
    const decisions = getDecisions();
    const kb = getKB();
    const progress = getProgressData();
    const history = tailReadJsonl(getHistoryFile(state.currentBranch), 30);
    const locks = getLocks();
    const config = getConfig();

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

    const recentMsgs = history.slice(-15).map(m => ({
      from: m.from, to: m.to,
      preview: m.content.substring(0, 150),
      timestamp: m.timestamp,
    }));

    const activeTasks = tasks.filter(t => t.status !== 'done').map(t => ({
      id: t.id, title: t.title, status: t.status, assignee: t.assignee, created_by: t.created_by,
    }));
    const doneTasks = tasks.filter(t => t.status === 'done').length;

    const lockedFiles = {};
    for (const [fp, lock] of Object.entries(locks)) {
      lockedFiles[fp] = { locked_by: lock.agent, since: lock.since };
    }

    const myActiveTasks = tasks.filter(t => t.status !== 'done' && t.assignee === state.registeredName);
    const myCompletedCount = tasks.filter(t => t.status === 'done' && t.assignee === state.registeredName).length;
    let methodology = null;
    try {
      const status = typeof inspectMethodology === 'function'
        ? inspectMethodology({ preflight: false, hashArtifacts: false })
        : null;
      if (status && (status.installed || status.enabled)) {
        methodology = {
          id: status.id,
          label: status.label,
          installed: status.installed,
          enabled: status.enabled,
          compatible: status.compatible,
          version: status.version,
          mode: status.settings && status.settings.mode,
          next_action: status.next_action,
          artifact_count: status.artifact_count,
        };
      }
    } catch {}

    return {
      briefing: true,
      conversation_mode: config.conversation_mode || 'direct',
      agents: roster,
      your_name: state.registeredName,
      recent_messages: recentMsgs,
      tasks: { active: activeTasks, completed_count: doneTasks, total: tasks.length },
      decisions: decisions.slice(-5).map(d => ({ decision: d.decision, topic: d.topic })),
      knowledge_base_keys: Object.keys(kb),
      locked_files: lockedFiles,
      progress,
      your_tasks: myActiveTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
      your_completed: myCompletedCount,
      methodology,
      next_action: myActiveTasks.length > 0
        ? `You have ${myActiveTasks.length} active task(s). Continue working, then call listen().`
        : 'Call listen() to receive messages and start working.',
    };
  }

  // --- MCP tool definitions ---

  const definitions = [
    {
      name: 'get_summary',
      description: 'Get a condensed summary of the conversation so far. Useful when context is getting long and you need a quick recap of what was discussed.',
      inputSchema: { type: 'object', properties: { last_n: { type: 'number', description: 'Number of recent messages to summarize (default 20, max 500)' } }, additionalProperties: false },
    },
    {
      name: 'get_briefing',
      description: 'Get a full project briefing: who is online, active tasks, recent decisions, knowledge base, locked files, progress, and project files. Call this when joining a project or after being away. One call = fully onboarded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'log_decision',
      description: 'Record a team decision for future reference. Decisions persist across compaction and appear in briefings.',
      inputSchema: { type: 'object', properties: { decision: { type: 'string', description: 'The decision made (1-500 chars)' }, reasoning: { type: 'string', description: 'Why this was decided (optional, max 1000 chars)' }, topic: { type: 'string', description: 'Topic category (optional, e.g., "architecture", "deployment")' } }, required: ['decision'], additionalProperties: false },
    },
    {
      name: 'get_decisions',
      description: 'View logged team decisions, optionally filtered by topic.',
      inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Filter by topic (optional)' } }, additionalProperties: false },
    },
    {
      name: 'kb_write',
      description: 'Write to the shared knowledge base. Keys persist across compaction. Max 100 keys, 100KB per value.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key (1-50 alphanumeric/underscore/hyphen/dot chars)' }, content: { type: 'string', description: 'Content to store (max 100KB)' } }, required: ['key', 'content'], additionalProperties: false },
    },
    {
      name: 'kb_read',
      description: 'Read from the shared knowledge base. Omit key to read all entries.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key to read (optional — omit for all)' } }, additionalProperties: false },
    },
    {
      name: 'kb_list',
      description: 'List all knowledge base keys with metadata (who updated, when, size).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'kb_mirror',
      description: 'Mirror PRD/architecture/decision BMad artifacts into the shared kb (one entry per artifact, upserted by source path so re-running updates rather than duplicates). One-way only — reads BMad files, never writes back to them. No-op if no matching BMad artifacts exist.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'update_progress',
      description: 'Update progress on a feature or milestone. Shown in dashboard and briefings.',
      inputSchema: { type: 'object', properties: { feature: { type: 'string', description: 'Feature or milestone name (1-100 chars)' }, percent: { type: 'number', description: 'Completion percentage (0-100)' }, notes: { type: 'string', description: 'Optional progress notes' } }, required: ['feature', 'percent'], additionalProperties: false },
    },
    {
      name: 'get_progress',
      description: 'Get progress on all tracked features/milestones.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_compressed_history',
      description: 'Get conversation history with automatic compression. Old messages are summarized into segments, recent messages shown verbatim. Use this when the conversation is long and you need to catch up without overflowing your context.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const handlers = {
    log_decision: function (args) { return toolLogDecision(args.decision, args.reasoning, args.topic); },
    get_decisions: function (args) { return toolGetDecisions(args.topic); },
    kb_write: function (args) { return toolKBWrite(args.key, args.content); },
    kb_read: function (args) { return toolKBRead(args.key); },
    kb_list: function () { return toolKBList(); },
    kb_mirror: function () { return toolKBMirror(); },
    update_progress: function (args) { return toolUpdateProgress(args.feature, args.percent, args.notes); },
    get_progress: function () { return toolGetProgress(); },
    get_compressed_history: function () { return toolGetCompressedHistory(); },
    get_summary: function (args) { return toolGetSummary(args.last_n); },
    get_briefing: function () { return toolGetBriefing(); },
  };

  return { definitions, handlers };
};
