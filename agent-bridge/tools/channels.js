'use strict';

// Channel tools: join, leave, list.
// Extracted from server.js as part of modular tool architecture.

const fs = require('fs');

module.exports = function (ctx) {
  const { state, helpers } = ctx;

  const {
    getChannelsData, saveChannelsData, sanitizeName,
    isChannelMember, getAgentChannels, getChannelMessagesFile,
    touchActivity,
  } = helpers;

  function toolJoinChannel(channelName, description, rateLimit) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof channelName !== 'string' || channelName.length < 1 || channelName.length > 20) return { error: 'Channel name must be 1-20 chars' };
    sanitizeName(channelName);

    const channels = getChannelsData();
    if (!channels[channelName]) {
      if (Object.keys(channels).length >= 100) return { error: 'Channel limit reached (max 100).' };
      channels[channelName] = {
        description: (description || '').substring(0, 200),
        members: [state.registeredName],
        created_by: state.registeredName,
        created_at: new Date().toISOString(),
      };
    } else if (!isChannelMember(channelName, state.registeredName)) {
      channels[channelName].members.push(state.registeredName);
    } else if (!rateLimit) {
      return { success: true, channel: channelName, message: 'Already a member of #' + channelName };
    }
    if (rateLimit && typeof rateLimit === 'object' && rateLimit.max_sends_per_minute) {
      const max = Math.min(Math.max(1, parseInt(rateLimit.max_sends_per_minute) || 10), 60);
      channels[channelName].rate_limit = { max_sends_per_minute: max };
    }
    saveChannelsData(channels);
    touchActivity();
    const result = { success: true, channel: channelName, members: channels[channelName].members, message: 'Joined #' + channelName };
    if (channels[channelName].rate_limit) result.rate_limit = channels[channelName].rate_limit;
    return result;
  }

  function toolLeaveChannel(channelName) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (channelName === 'general') return { error: 'Cannot leave #general' };

    const channels = getChannelsData();
    if (!channels[channelName]) return { error: 'Channel not found: #' + channelName };
    channels[channelName].members = channels[channelName].members.filter(m => m !== state.registeredName);
    if (channels[channelName].members.length === 0) delete channels[channelName];
    saveChannelsData(channels);
    touchActivity();
    return { success: true, channel: channelName, message: 'Left #' + channelName };
  }

  function toolListChannels() {
    const channels = getChannelsData();
    const result = {};
    for (const [name, ch] of Object.entries(channels)) {
      const msgFile = getChannelMessagesFile(name);
      let msgCount = 0;
      if (fs.existsSync(msgFile)) {
        const content = fs.readFileSync(msgFile, 'utf8').trim();
        if (content) msgCount = content.split(/\r?\n/).filter(l => l.trim()).length;
      }
      result[name] = {
        description: ch.description || '',
        members: ch.members,
        member_count: ch.members.includes('*') ? 'all' : ch.members.length,
        created_by: ch.created_by,
        message_count: msgCount,
        you_are_member: isChannelMember(name, state.registeredName),
      };
    }
    return { channels: result, your_channels: getAgentChannels(state.registeredName) };
  }

  const definitions = [
    {
      name: 'join_channel',
      description: 'Join or create a sub-channel for focused discussion. Channels keep noise out of #general.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel name (1-20 alphanumeric chars)' },
          description: { type: 'string', description: 'Channel description (optional, for new channels)' },
          rate_limit: { type: 'object', properties: { max_sends_per_minute: { type: 'number' } }, description: 'Optional rate limit config' },
        },
        required: ['channel'],
        additionalProperties: false,
      },
    },
    {
      name: 'leave_channel',
      description: 'Leave a sub-channel. Cannot leave #general.',
      inputSchema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel name to leave' } }, required: ['channel'], additionalProperties: false },
    },
    {
      name: 'list_channels',
      description: 'List all channels, their members, and message counts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const handlers = {
    join_channel: function (args) { return toolJoinChannel(args.channel, args.description, args.rate_limit); },
    leave_channel: function (args) { return toolLeaveChannel(args.channel); },
    list_channels: function () { return toolListChannels(); },
  };

  return { definitions, handlers };
};
