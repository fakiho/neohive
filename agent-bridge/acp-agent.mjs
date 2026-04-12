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
import { buildWorkerSessionFromConfig, isCwdAllowed } from './acp-orchestrator.mjs';

const require = createRequire(import.meta.url);
const hub = require('./core/hub.js');

const STDERR_BANNER =
  '[neohive] acp-agent: ACP stdio ↔ core/hub.js (+ optional worker dispatch). Set NEOHIVE_DATA_DIR; NEOHIVE_ACP_AGENT_NAME optional. Commands: help | register | send_message | list_agents | get_briefing | listen | dispatch\n';

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
• dispatch — spawn headless ACP worker (see .neohive/acp-workers.json); first line:
    dispatch worker=<id> cwd=<path>
    <task body>
  cwd must be under the session workspace roots from Zed. Same-machine trust only.
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

JSON: {"action":"dispatch","worker":"gemini","cwd":"...","content":"..."} | send_message | list_agents | get_briefing | listen | register | help
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
    case 'dispatch': {
      const head = lines[0] || '';
      const mW = head.match(/\bworker\s*=\s*(\S+)/i);
      const mC = head.match(/\bcwd\s*=\s*(\S+)/i);
      const body = lines.slice(1).join('\n').trim();
      return {
        kind: 'dispatch',
        worker: mW ? mW[1] : null,
        cwd: mC ? mC[1] : null,
        body,
      };
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

async function runDispatch(agent, sessionId, turn, signal) {
  const session = agent.sessions.get(sessionId);
  if (!session) {
    return;
  }
  const allowedRoots = session.allowedRoots && session.allowedRoots.length > 0 ? session.allowedRoots : [process.cwd()];

  if (!turn.worker) {
    await pushText(agent.connection, sessionId, '[dispatch] missing worker= id (see .neohive/acp-workers.json)', signal);
    return;
  }

  const cwdCandidate = turn.cwd || allowedRoots[0];
  if (!isCwdAllowed(cwdCandidate, allowedRoots)) {
    await pushText(
      agent.connection,
      sessionId,
      `[dispatch] cwd not under allowed workspace roots: ${cwdCandidate}`,
      signal,
    );
    return;
  }

  const resolvedCwd = path.resolve(cwdCandidate);
  const built = buildWorkerSessionFromConfig(turn.worker, sessionId, agent.connection, {
    spawnCwd: resolvedCwd,
  });
  if (built.error) {
    await pushText(agent.connection, sessionId, `[dispatch] ${built.error}`, signal);
    return;
  }

  const ws = built.workerSession;
  session.worker = ws;
  try {
    if (signal.aborted) {
      return;
    }
    await ws.init(resolvedCwd);
    ws.startHubPoll(2000);
    if (signal.aborted) {
      return;
    }
    await ws.prompt(turn.body || '');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await pushText(agent.connection, sessionId, `[dispatch] worker error: ${msg}`, signal);
  } finally {
    try {
      ws.destroy();
    } catch {
      /* ignore */
    }
    session.worker = null;
  }
}

/** @returns {Promise<string|undefined>} new agent name when register succeeds */
async function runJsonAction(connection, sessionId, agentName, j, signal, neohiveAgent) {
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
    case 'dispatch': {
      const body =
        typeof j.content === 'string'
          ? j.content
          : typeof j.body === 'string'
            ? j.body
            : '';
      await runDispatch(neohiveAgent, sessionId, {
        kind: 'dispatch',
        worker: j.worker,
        cwd: j.cwd || null,
        body,
      }, signal);
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
    /** @type {Map<string, { pendingPrompt: AbortController | null, worker: object | null, allowedRoots: string[] }>} */
    this.sessions = new Map();
    this.defaultName = resolveAgentName();
    /** @type {string | null} */
    this.agentName = null;
    this.initError = null;

    connection.signal.addEventListener('abort', () => {
      for (const [, ses] of this.sessions) {
        try {
          ses.worker?.destroy();
        } catch {
          /* ignore */
        }
        ses.worker = null;
      }
    });
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

  async newSession(params) {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const allowedRoots = [];
    if (params?.cwd) {
      allowedRoots.push(path.resolve(params.cwd));
    }
    for (const d of params?.additionalDirectories || []) {
      if (d) allowedRoots.push(path.resolve(d));
    }
    if (allowedRoots.length === 0) {
      allowedRoots.push(process.cwd());
    }
    this.sessions.set(sessionId, { pendingPrompt: null, worker: null, allowedRoots });
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
          this,
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
      } else if (turn.kind === 'dispatch') {
        await runDispatch(this, params.sessionId, turn, signal);
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
    const session = this.sessions.get(params.sessionId);
    session?.pendingPrompt?.abort();
    const w = session?.worker;
    if (w) {
      try {
        await w.cancel();
      } catch {
        /* ignore */
      }
      try {
        w.destroy();
      } catch {
        /* ignore */
      }
      session.worker = null;
    }
  }
}

const toClient = Writable.toWeb(process.stdout);
const fromClient = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(toClient, fromClient);

new acp.AgentSideConnection((conn) => new NeohiveAcpAgent(conn), stream);
