'use strict';

// Shared mutable state for this MCP server process.
// All modules import and mutate this single object.
module.exports = {
  registeredName: null,
  registeredToken: null,
  lastReadOffset: 0,
  channelOffsets: new Map(),
  heartbeatInterval: null,
  messageSeq: 0,
  currentBranch: 'main',
  lastSentAt: 0,
  sendsSinceLastListen: 0,
  sendLimit: 1,
  unaddressedSends: 0,
  budgetResetTime: Date.now(),
  _channelSendTimes: {},
  // Rate limiting state
  rateLimitMessages: [],
  recentSentMessages: [],
  recentErrorCalls: [],
};
