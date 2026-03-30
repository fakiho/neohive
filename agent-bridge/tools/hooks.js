'use strict';

// Hook tools: subscribe, unsubscribe, list hooks.
// Extracted as a tool module following the context injection pattern.

const hooksLib = require('../lib/hooks');

module.exports = function (ctx) {
  const { state } = ctx;

  function toolSubscribeHook(event, filter) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    return hooksLib.subscribe(state.registeredName, event, filter || null);
  }

  function toolUnsubscribeHook(hookId) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    return hooksLib.unsubscribe(state.registeredName, hookId || null);
  }

  function toolListHooks() {
    if (!state.registeredName) return { error: 'You must call register() first' };
    return hooksLib.listHooks(state.registeredName);
  }

  const definitions = [
    {
      name: 'subscribe_hook',
      description: 'Subscribe to an event — you will receive automatic system messages when the event fires. Events: task.status_changed, agent.idle, agent.stuck, workflow.advanced, review.submitted. Use filter to narrow (e.g. { status: "done" } for only completed tasks).',
      inputSchema: {
        type: 'object',
        properties: {
          event: { type: 'string', enum: hooksLib.VALID_EVENTS, description: 'Event to subscribe to' },
          filter: { type: 'object', description: 'Optional filter object (e.g. { status: "done", assignee: "Nick" })' },
        },
        required: ['event'],
        additionalProperties: false,
      },
    },
    {
      name: 'unsubscribe_hook',
      description: 'Unsubscribe from a hook by ID, or omit hook_id to remove all your subscriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          hook_id: { type: 'string', description: 'Hook ID to unsubscribe (optional — omit to remove all)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_hooks',
      description: 'List your active event hook subscriptions.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const handlers = {
    subscribe_hook: function (args) { return toolSubscribeHook(args.event, args.filter); },
    unsubscribe_hook: function (args) { return toolUnsubscribeHook(args.hook_id); },
    list_hooks: function () { return toolListHooks(); },
  };

  return { definitions, handlers };
};
