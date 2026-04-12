'use strict';

/**
 * MR-1 — Hub façade for ACP (and future non-MCP callers).
 * Five exports only; each delegates to lib/agents or lib/messaging.
 * MCP server is unchanged; wire this from MR-2 acp-agent.mjs via createRequire.
 */

const agents = require('../lib/agents');
const messaging = require('../lib/messaging');

function register(name, provider, skills) {
  return agents.hubRegisterAgent(name, provider, skills);
}

function sendMessage(fromName, content, to, replyTo, channel) {
  return messaging.hubSendUserMessage(fromName, content, to, replyTo, channel);
}

function listAgents() {
  return agents.listAgentsMcpPayload(null);
}

function getBriefing(agentName) {
  return messaging.hubBuildBriefing(agentName);
}

function listen(agentName, opts) {
  return messaging.hubListenNext(agentName, opts || {});
}

module.exports = {
  register,
  sendMessage,
  listAgents,
  getBriefing,
  listen,
};
