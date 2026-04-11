#!/usr/bin/env node
/**
 * MR-0 — ACP Phase 0 spike (Neohive).
 * Minimal stdio agent: @agentclientprotocol/sdk AgentSideConnection + ndJsonStream.
 * Does not touch Neohive hub (.neohive/) or server.js.
 *
 * Wire matches official SDK example (dist/examples/agent.js):
 *   ndJsonStream(Writable.toWeb(stdout), Readable.toWeb(stdin))
 *
 * @see docs/acp-mr0-zed-smoke.md
 */
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

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

class NeohiveAcpSpikeAgent {
  /** @param {object} connection - AgentSideConnection from @agentclientprotocol/sdk */
  constructor(connection) {
    this.connection = connection;
    /** @type {Map<string, { pendingPrompt: AbortController | null }>} */
    this.sessions = new Map();
  }

  async initialize(_params) {
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

  async setSessionMode(_params) {
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

    const userText = extractUserText(params.prompt);
    const reply =
      `[neohive ACP MR-0 spike] Echo:\n\n${userText || '(no text content blocks)'}`;

    try {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: reply },
        },
      });
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

process.stderr.write(
  '[neohive] acp-spike (MR-0): AgentSideConnection on stdio — connect from Zed (see docs/acp-mr0-zed-smoke.md)\n',
);

// Same mapping as SDK example: agent writes to stdout, reads from stdin
const toClient = Writable.toWeb(process.stdout);
const fromClient = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(toClient, fromClient);

new acp.AgentSideConnection((conn) => new NeohiveAcpSpikeAgent(conn), stream);
