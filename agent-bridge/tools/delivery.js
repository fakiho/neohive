'use strict';

// Durable command/task delivery tools: at-least-once, idempotent, lease-based
// delivery with capability gating, retries, and dead-lettering.
//
// This module is purely additive — it introduces a new, opt-in delivery
// channel backed by lib/durable-delivery.js. It does not alter the existing
// send_message/listen/handoff paths, so it carries no regression risk for
// agents that never call these tools.
//
// Session epoch fencing reuses the same per-registration token already
// tracked by server.js (ctx.state.registeredToken), so a re-register()
// automatically invalidates any stale in-flight leases/acks from a prior
// process for the same agent name.

const { createDurableDeliveryStore, DeliveryError } = require('../lib/durable-delivery');

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;
  const { generateId, ensureDataDir, touchActivity } = helpers;
  const { DATA_DIR } = files;

  let store = null;
  function getStore() {
    if (!store) {
      ensureDataDir();
      const options = { dataDir: DATA_DIR };
      // Test-only override so lease-expiry/fencing scenarios can be exercised
      // deterministically without waiting out the production 30s default lease.
      const leaseOverride = Number(process.env.NEOHIVE_DELIVERY_LEASE_MS);
      if (Number.isFinite(leaseOverride) && leaseOverride > 0) options.leaseMs = leaseOverride;
      store = createDurableDeliveryStore(options);
    }
    return store;
  }

  // Tracks the last epoch we registered a session for, so claim/set-capabilities
  // calls can lazily (re)register exactly once per registration token.
  let lastRegisteredEpoch = null;

  function requireAgent() {
    if (!state.registeredName) return { error: 'You must call register() first' };
    return null;
  }

  function currentEpoch() {
    return state.registeredToken || null;
  }

  function ensureSession(capabilities) {
    const epoch = currentEpoch();
    if (!epoch) return { error: 'No active registration token — call register() first' };
    if (lastRegisteredEpoch !== epoch) {
      getStore().registerSession({ agent: state.registeredName, epoch, capabilities: capabilities || [] });
      lastRegisteredEpoch = epoch;
    }
    getStore().setReady({ agent: state.registeredName, epoch, ready: true, capabilities });
    return null;
  }

  function handleDeliveryError(e) {
    if (e instanceof DeliveryError) {
      return { error: e.message, code: e.code, details: e.details || null };
    }
    throw e;
  }

  // Internal, best-effort enqueue for other tool modules (e.g. tools/tasks.js)
  // to durably back a structured task/handoff without changing their existing
  // user-visible responses. Never throws — a delivery-layer failure must not
  // block the structured operation it is backing. Callers MUST check `ok`:
  // on failure the caller is responsible for surfacing a structured error
  // (with the same idempotency_key) so a retry can safely re-attempt the
  // enqueue without risk of duplicating it once the underlying issue clears.
  //
  // `skipped: true` means "intentionally not enqueued" (no recipient, or
  // recipient === sender) — this is not a failure and callers should not
  // report it as one.
  function internalEnqueue(params) {
    if (!params || !params.recipient || params.recipient === state.registeredName) {
      return { ok: true, skipped: true };
    }
    if (!state.registeredName) {
      return { ok: false, error: 'Cannot enqueue: no active registration', code: 'NOT_REGISTERED' };
    }
    try {
      const { delivery, duplicate } = getStore().enqueue({
        sender: state.registeredName,
        recipient: params.recipient,
        messageId: params.messageId || generateId(),
        payloadRef: params.payload != null ? params.payload : null,
        kind: params.kind || 'message',
        priority: params.priority,
        requiredCapabilities: params.requiredCapabilities,
        ttlMs: params.ttlMs,
        idempotencyKey: params.idempotencyKey,
        maxAttempts: params.maxAttempts,
      });
      return { ok: true, delivery_id: delivery.id, duplicate };
    } catch (e) {
      const message = e instanceof DeliveryError ? e.message : (e && e.message) || String(e);
      const code = e instanceof DeliveryError ? e.code : 'DELIVERY_ENQUEUE_FAILED';
      return { ok: false, error: message, code };
    }
  }

  // --- Enqueue ---

  function toolEnqueueDelivery(recipient, payload, kind, priority, requiredCapabilities, ttlMs, idempotencyKey, maxAttempts) {
    const authError = requireAgent();
    if (authError) return authError;
    if (!recipient || typeof recipient !== 'string') return { error: 'recipient is required' };
    if (recipient === state.registeredName) return { error: 'Cannot enqueue a durable delivery to yourself' };

    try {
      const { delivery, duplicate } = getStore().enqueue({
        sender: state.registeredName,
        recipient,
        messageId: generateId(),
        payloadRef: payload != null ? payload : null,
        kind: kind || 'message',
        priority,
        requiredCapabilities,
        ttlMs,
        idempotencyKey,
        maxAttempts,
      });
      touchActivity();
      return {
        success: true,
        delivery_id: delivery.id,
        status: delivery.status,
        duplicate,
        next_action: duplicate
          ? 'An in-flight delivery already matches this idempotency_key; no new delivery was created.'
          : `${recipient} must call claim_deliveries() to receive this.`,
      };
    } catch (e) {
      return handleDeliveryError(e);
    }
  }

  // --- Claim ---

  function toolClaimDeliveries(limit, capabilities) {
    const authError = requireAgent();
    if (authError) return authError;

    try {
      const sessionError = ensureSession(capabilities);
      if (sessionError) return sessionError;
      const claimed = getStore().claim({ agent: state.registeredName, epoch: currentEpoch(), limit: limit || 1 });
      touchActivity();
      return {
        count: claimed.length,
        deliveries: claimed.map((d) => ({
          delivery_id: d.id,
          sender: d.sender,
          kind: d.kind,
          payload: d.payload_ref,
          priority: d.priority,
          attempts: d.attempts,
          max_attempts: d.max_attempts,
          lease_expires_at: d.lease.expires_at,
          lease_token: d.lease.token,
        })),
        next_action: claimed.length > 0
          ? 'Process each delivery, then call ack_delivery() or fail_delivery() before the lease expires.'
          : 'No deliveries available right now.',
      };
    } catch (e) {
      return handleDeliveryError(e);
    }
  }

  // --- Ack / Fail / Redrive ---

  function toolAckDelivery(deliveryId, leaseToken) {
    const authError = requireAgent();
    if (authError) return authError;
    if (!deliveryId) return { error: 'delivery_id is required' };

    try {
      const delivery = getStore().ack({ agent: state.registeredName, epoch: currentEpoch(), deliveryId, leaseToken });
      touchActivity();
      return { success: true, delivery_id: delivery.id, status: delivery.status };
    } catch (e) {
      return handleDeliveryError(e);
    }
  }

  function toolFailDelivery(deliveryId, error, retryable, leaseToken) {
    const authError = requireAgent();
    if (authError) return authError;
    if (!deliveryId) return { error: 'delivery_id is required' };

    try {
      const delivery = getStore().fail({
        agent: state.registeredName,
        epoch: currentEpoch(),
        deliveryId,
        leaseToken,
        error,
        retryable,
      });
      touchActivity();
      return { success: true, delivery_id: delivery.id, status: delivery.status };
    } catch (e) {
      return handleDeliveryError(e);
    }
  }

  function toolRedriveDelivery(deliveryId) {
    const authError = requireAgent();
    if (authError) return authError;
    if (!deliveryId) return { error: 'delivery_id is required' };

    try {
      const delivery = getStore().redrive({ deliveryId });
      touchActivity();
      return { success: true, delivery_id: delivery.id, status: delivery.status };
    } catch (e) {
      return handleDeliveryError(e);
    }
  }

  // --- Listing ---

  function toolListDeliveries(status, recipient) {
    const authError = requireAgent();
    if (authError) return authError;

    const deliveries = getStore().getDeliveries({ recipient: recipient || state.registeredName, status });
    return {
      count: deliveries.length,
      deliveries: deliveries.map((d) => ({
        delivery_id: d.id,
        sender: d.sender,
        recipient: d.recipient,
        kind: d.kind,
        status: d.status,
        attempts: d.attempts,
        max_attempts: d.max_attempts,
        priority: d.priority,
        created_at: d.created_at,
        updated_at: d.updated_at,
        blocked_reason: d.blocked_reason || null,
      })),
    };
  }

  function toolListDeadLetters(recipient) {
    const authError = requireAgent();
    if (authError) return authError;

    const deadLetters = getStore().getDeadLetters(recipient || state.registeredName);
    return {
      count: deadLetters.length,
      deliveries: deadLetters.map((d) => ({
        delivery_id: d.id,
        sender: d.sender,
        recipient: d.recipient,
        kind: d.kind,
        payload: d.payload_ref,
        dead_letter_reason: d.dead_letter_reason,
        last_error: d.last_error,
        created_at: d.created_at,
      })),
    };
  }

  // --- MCP tool definitions ---

  const definitions = [
    {
      name: 'enqueue_delivery',
      description: 'Durably enqueue a command/task/message for another agent with at-least-once delivery: idempotent by idempotency_key, retried with backoff, and dead-lettered after max_attempts or ttl_ms. The recipient must call claim_deliveries() to receive it. Use for critical handoffs that must not be silently lost.',
      inputSchema: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'Agent name to deliver to', maxLength: 50 },
          payload: { description: 'Arbitrary JSON-serializable content to deliver' },
          kind: { type: 'string', description: 'Delivery kind, e.g. command, task, handoff, message', maxLength: 50 },
          priority: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'Delivery priority (default normal)' },
          required_capabilities: { type: 'array', items: { type: 'string' }, description: 'Capabilities the recipient must have declared via claim_deliveries() before this can be claimed' },
          ttl_ms: { type: 'number', description: 'Time-to-live in milliseconds; expires to dead-letter if not delivered in time' },
          idempotency_key: { type: 'string', description: 'Dedup key — repeated enqueue calls with the same key/sender/recipient/kind return the original delivery' },
          max_attempts: { type: 'number', description: 'Max claim/fail attempts before dead-lettering (default 5)' },
        },
        required: ['recipient'],
        additionalProperties: false,
      },
    },
    {
      name: 'claim_deliveries',
      description: 'Claim up to `limit` pending durable deliveries addressed to you, leasing each one. Call ack_delivery() or fail_delivery() before the lease expires, or it will be redelivered. Declares your capabilities for capability-gated deliveries.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max deliveries to claim (default 1, max 20)' },
          capabilities: { type: 'array', items: { type: 'string' }, description: 'Capabilities you can currently handle (optional; persists across calls until changed)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'ack_delivery',
      description: 'Acknowledge successful processing of a claimed delivery, marking it done.',
      inputSchema: {
        type: 'object',
        properties: {
          delivery_id: { type: 'string', description: 'Delivery ID returned by claim_deliveries()', maxLength: 200 },
          lease_token: { type: 'string', description: 'Lease token from claim_deliveries(); recommended to avoid acking a stale lease', maxLength: 100 },
        },
        required: ['delivery_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'fail_delivery',
      description: 'Report failed processing of a claimed delivery. Retries with exponential backoff unless retryable=false or max_attempts is exhausted, in which case it is dead-lettered.',
      inputSchema: {
        type: 'object',
        properties: {
          delivery_id: { type: 'string', description: 'Delivery ID returned by claim_deliveries()', maxLength: 200 },
          error: { type: 'string', description: 'Error description', maxLength: 1000 },
          retryable: { type: 'boolean', description: 'Set false to force immediate dead-lettering (default true)' },
          lease_token: { type: 'string', description: 'Lease token from claim_deliveries()', maxLength: 100 },
        },
        required: ['delivery_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'redrive_delivery',
      description: 'Reset a dead-lettered delivery back to pending for redelivery (attempts reset to 0).',
      inputSchema: {
        type: 'object',
        properties: {
          delivery_id: { type: 'string', description: 'Delivery ID to redrive', maxLength: 200 },
        },
        required: ['delivery_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_deliveries',
      description: 'List durable deliveries addressed to you (or another recipient), optionally filtered by status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'leased', 'acked', 'dead_letter'], description: 'Filter by status' },
          recipient: { type: 'string', description: 'Defaults to yourself', maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_dead_letters',
      description: 'List dead-lettered deliveries addressed to you (or another recipient) that exhausted retries or expired.',
      inputSchema: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'Defaults to yourself', maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
  ];

  const handlers = {
    enqueue_delivery: (args) => toolEnqueueDelivery(
      args.recipient, args.payload, args.kind, args.priority,
      args.required_capabilities, args.ttl_ms, args.idempotency_key, args.max_attempts
    ),
    claim_deliveries: (args) => toolClaimDeliveries(args.limit, args.capabilities),
    ack_delivery: (args) => toolAckDelivery(args.delivery_id, args.lease_token),
    fail_delivery: (args) => toolFailDelivery(args.delivery_id, args.error, args.retryable, args.lease_token),
    redrive_delivery: (args) => toolRedriveDelivery(args.delivery_id),
    list_deliveries: (args) => toolListDeliveries(args.status, args.recipient),
    list_dead_letters: (args) => toolListDeadLetters(args.recipient),
  };

  return { definitions, handlers, internalEnqueue };
};
