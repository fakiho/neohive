#!/usr/bin/env node
/**
 * MR-2 — Neohive ACP bridge: stdio AgentSideConnection + MR-1 core/hub.js (CJS).
 *
 * Prompt-turn protocol (first line = command, case-insensitive):
 *   register [name]     — hub register (optional name; default from env / cwd)
 *   send_message        — headers to:/reply_to: then blank line, then body (see help)
 *   list_agents         — roster JSON
 *   get_briefing        — briefing JSON
 *   listen [from name]  — one hub message (optional from-filter)
 *   help                — command summary
 *
 * Or a single JSON object: { "action": "send_message", "to": "...", "content": "..." } etc.
 *
 * @see SPEC.md §12.2, §12.3, §7.1
 */
import * as acp from '@agentclientprotocol/sdk';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const require = createRequire(import.meta.url);
const hub = require('./core/hub.js');

const STDERR_BANNER =
  '[neohive] acp-agent (MR-2): ACP stdio ↔ core/hub.js — set NEOHIVE_DATA_DIR; NEOHIVE_ACP_AGENT_NAME optional. Commands: help | register | send_message | list_agents | get_briefing | listen\n';

process.stderr.write(STDERR_BANNER);

function resolveAgentName() {
  const raw = (process.env.NEOHIVE_ACP_AGENT_NAME || '').trim();
  if (raw && !raw.includes('${')) {
    return raw;
  }
  const base = path
    .basename(process.cwd())
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = (base || 'work').slice(0, 16);
  let name = `acp-${suffix}`;
  if (name.length > 20) name = name.slice(0, 20);
  return name;
}

function extractUserText(promptBlocks) {
  if (!Array.isArray(promptBlocks)) return '';
  const parts = [];
  for (const block of promptBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
    if (block.type === 'resource_link') {
      parts.push(`[resource_link: ${block.uri || '?'}]`);
    }
  }
  return parts.join('\n');
}

const HELP_TEXT = `Neohive ACP hub commands (MVP):
• register [name] — register with Neohive (optional name; max 20 chars alnum/_/-)
• send_message — block format:
    send_message
    to: AgentName
    reply_to: optionalMessageId

    Your message body here.
  (omit "to:" to broadcast to __all__)
• list_agents — who is online / roster
• get_briefing — tasks, decisions, recent messages snapshot
• listen [from:Name] — consume next message for this agent (optional from-filter)
• help — this text

JSON: {"action":"send_message","to":"X","content":"..."} | list_agents | get_briefing | listen | register | help
`;

async function pushText(connection, sessionId, text, signal) {
  const chunkSize = 10000;
  for (let i = 0; i < text.length; i += chunkSize) {
    if (signal.aborted) {
      return;
    }
    const piece = text.slice(i, i + chunkSize);
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: piece },
      },
    });
  }
}

function parseSendLines(lines) {
  const headers = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      break;
    }
    const m = line.match(/^(to|reply_to|reply-to)\s*:\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase().replace(/-/g, '_');
      if (key === 'reply_to') headers.reply_to = m[2].trim();
      else headers.to = m[2].trim();
    } else {
      break;
    }
  }
  const body = lines.slice(i).join('\n').trim();
  return { to: headers.to || null, reply_to: headers.reply_to || undefined, body };
}

function parsePromptTurn(text, defaultName) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: 'help' };
  }

  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      if (j && typeof j === 'object' && typeof j.action === 'string') {
        return { kind: 'json', payload: j };
      }
    } catch {
      /* fall through */
    }
  }

  const lines = text.split(/\r?\n/);
  const first = lines[0].trim();
  const [cmdRaw, ...restFirst] = first.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const tailFirst = restFirst.join(' ').trim();

  switch (cmd) {
    case 'register': {
      const nameLine = tailFirst || (lines[1] && lines[1].trim()) || '';
      return { kind: 'register', name: nameLine || defaultName };
    }
    case 'send':
    case 'send_message': {
      const { to, reply_to, body } = parseSendLines(lines);
      return { kind: 'send', to, reply_to, body };
    }
    case 'list_agents':
    case 'agents':
      return { kind: 'list_agents' };
    case 'get_briefing':
    case 'briefing':
      return { kind: 'get_briefing' };
    case 'listen': {
      let from = null;
      if (tailFirst) {
        const m = tailFirst.match(/^from\s*:\s*(.+)$/i) || tailFirst.match(/^from\s+(.+)$/i);
        from = m ? m[1].trim() : tailFirst;
      } else if (lines[1] && lines[1].trim()) {
        const m2 = lines[1].trim().match(/^from\s*:\s*(.+)$/i) || lines[1].trim().match(/^from\s+(.+)$/i);
        from = m2 ? m2[1].trim() : lines[1].trim();
      }
      return { kind: 'listen', from };
    }
    case 'help':
    case '?':
      return { kind: 'help' };
    default:
      return {
        kind: 'help',
        unknown: cmd,
      };
  }
}

/** @returns {Promise<string|undefined>} new agent name when register succeeds */
async function runJsonAction(connection, sessionId, agentName, j, signal) {
  const a = String(j.action || '').toLowerCase().replace(/-/g, '_');
  switch (a) {
    case 'register':
      return runRegister(
        connection,
        sessionId,
        typeof j.name === 'string' ? j.name : agentName,
        signal,
      );
    case 'send_message':
    case 'send': {
      const content = typeof j.content === 'string' ? j.content : JSON.stringify(j.content ?? '');
      const r = hub.sendMessage(agentName, content, j.to || null, j.reply_to || undefined, j.channel);
      await pushText(connection, sessionId, formatResult('send_message', r), signal);
      return undefined;
    }
    case 'list_agents': {
      const r = hub.listAgents();
      await pushText(connection, sessionId, formatResult('list_agents', r), signal);
      return undefined;
    }
    case 'get_briefing': {
      const r = hub.getBriefing(agentName);
      await pushText(connection, sessionId, formatResult('get_briefing', r), signal);
      return undefined;
    }
    case 'listen': {
      const r = hub.listen(agentName, { from: j.from || undefined });
      await pushText(connection, sessionId, formatResult('listen', r), signal);
      return undefined;
    }
    case 'help':
      await pushText(connection, sessionId, HELP_TEXT, signal);
      return undefined;
    default:
      await pushText(
        connection,
        sessionId,
        `Unknown action "${j.action}". ${HELP_TEXT}`,
        signal,
      );
      return undefined;
  }
}

function formatResult(label, r) {
  if (r && r.error) {
    return `[${label}] error: ${r.error}`;
  }
  return `[${label}]\n${JSON.stringify(r, null, 2)}`;
}

async function runRegister(connection, sessionId, name, signal) {
  const r = hub.register(name, 'ACP', ['acp', 'messaging']);
  const text = r.error ? `[register] error: ${r.error}` : `[register] ok: ${r.name}`;
  await pushText(connection, sessionId, text, signal);
  return r.error ? null : r.name;
}

class NeohiveAcpAgent {
  /** @param {object} connection */
  constructor(connection) {
    this.connection = connection;
    /** @type {Map<string, { pendingPrompt: AbortController | null }>} */
    this.sessions = new Map();
    this.defaultName = resolveAgentName();
    /** @type {string | null} */
    this.agentName = null;
    this.initError = null;
  }

  async initialize(_params) {
    try {
      const r = hub.register(this.defaultName, 'ACP', ['acp', 'messaging']);
      if (r.error) {
        this.initError = r.error;
      } else {
        this.agentName = r.name;
        this.initError = null;
      }
    } catch (e) {
      this.initError = e instanceof Error ? e.message : String(e);
    }

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          embeddedContext: false,
        },
      },
    };
  }

  async newSession(_params) {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    this.sessions.set(sessionId, { pendingPrompt: null });
    return { sessionId };
  }

  async authenticate(_params) {
    return {};
  }

  async setSessionMode(params) {
    if (params && params.mode != null) {
      process.stderr.write(`[neohive] acp-agent: setSessionMode ${JSON.stringify(params.mode)}\n`);
    }
    return {};
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();
    const signal = session.pendingPrompt.signal;

    const agentName = this.agentName || this.defaultName;
    const userText = extractUserText(params.prompt);

    try {
      if (this.initError) {
        await pushText(
          this.connection,
          params.sessionId,
          `[neohive] register failed at startup: ${this.initError}\nYou can try: register YourName`,
          signal,
        );
      }

      const turn = parsePromptTurn(userText, this.defaultName);

      if (turn.kind === 'json') {
        const renamed = await runJsonAction(
          this.connection,
          params.sessionId,
          agentName,
          turn.payload,
          signal,
        );
        if (renamed) this.agentName = renamed;
      } else if (turn.kind === 'register') {
        const target = turn.name || this.defaultName;
        const newName = await runRegister(this.connection, params.sessionId, target, signal);
        if (newName) this.agentName = newName;
      } else if (turn.kind === 'send') {
        if (!turn.body) {
          await pushText(this.connection, params.sessionId, '[send_message] missing body after headers', signal);
        } else {
          const r = hub.sendMessage(agentName, turn.body, turn.to, turn.reply_to, undefined);
          await pushText(this.connection, params.sessionId, formatResult('send_message', r), signal);
        }
      } else if (turn.kind === 'list_agents') {
        const r = hub.listAgents();
        await pushText(this.connection, params.sessionId, formatResult('list_agents', r), signal);
      } else if (turn.kind === 'get_briefing') {
        const r = hub.getBriefing(agentName);
        await pushText(this.connection, params.sessionId, formatResult('get_briefing', r), signal);
      } else if (turn.kind === 'listen') {
        const r = hub.listen(agentName, { from: turn.from || undefined });
        await pushText(this.connection, params.sessionId, formatResult('listen', r), signal);
      } else {
        const extra = turn.unknown ? `Unknown command "${turn.unknown}".\n\n` : '';
        await pushText(this.connection, params.sessionId, extra + HELP_TEXT, signal);
      }
    } catch (err) {
      if (signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      throw err;
    }

    session.pendingPrompt = null;
    return { stopReason: 'end_turn' };
  }

  async cancel(params) {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }
}

const toClient = Writable.toWeb(process.stdout);
const fromClient = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(toClient, fromClient);

new acp.AgentSideConnection((conn) => new NeohiveAcpAgent(conn), stream);
