'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_VERSION = 1;
const DEFAULT_LEASE_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class DeliveryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    if (details) this.details = details;
  }
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  return [...new Set(capabilities
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))]
    .slice(0, 100);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // Fallback for runtimes without Atomics.wait.
    }
  }
}

function createDurableDeliveryStore(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir || typeof dataDir !== 'string') {
    throw new TypeError('createDurableDeliveryStore requires a dataDir');
  }

  const stateFile = options.stateFile || path.join(dataDir, 'deliveries.json');
  const lockFile = options.lockFile || `${stateFile}.lock`;
  const leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryBaseMs = positiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
  const lockTimeoutMs = positiveInteger(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const terminalRetentionMs = positiveInteger(
    options.terminalRetentionMs,
    DEFAULT_TERMINAL_RETENTION_MS
  );
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const makeToken = typeof options.makeToken === 'function' ? options.makeToken : randomToken;

  function ensureDataDir() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  function emptyState() {
    return {
      version: STATE_VERSION,
      deliveries: {},
      consumers: {},
    };
  }

  function readState() {
    if (!fs.existsSync(stateFile)) return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (error) {
      throw new DeliveryError(
        'DELIVERY_STATE_CORRUPT',
        `Delivery state is not valid JSON: ${error.message}`,
        { state_file: stateFile }
      );
    }
    if (!parsed || parsed.version !== STATE_VERSION ||
        !parsed.deliveries || typeof parsed.deliveries !== 'object' ||
        !parsed.consumers || typeof parsed.consumers !== 'object') {
      throw new DeliveryError(
        'DELIVERY_STATE_INVALID',
        `Unsupported or malformed delivery state in ${stateFile}`,
        { expected_version: STATE_VERSION }
      );
    }
    return parsed;
  }

  function writeState(state) {
    const tempFile = `${stateFile}.${process.pid}.${makeToken()}.tmp`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tempFile, stateFile);
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch {}
      throw classifyStorageError(error, stateFile);
    }
  }

  function acquireLock() {
    ensureDataDir();
    const owner = {
      pid: process.pid,
      token: makeToken(),
      acquired_at: Date.now(),
    };
    const deadline = Date.now() + lockTimeoutMs;
    let backoffMs = 1;

    while (Date.now() < deadline) {
      try {
        fs.writeFileSync(lockFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
        return owner;
      } catch (error) {
        if (error.code !== 'EEXIST') throw classifyStorageError(error, lockFile);
      }

      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      } catch {
        // A malformed lock has no trustworthy live owner and may be replaced.
      }
      if (!existing || !isPidAlive(existing.pid)) {
        try { fs.unlinkSync(lockFile); } catch {}
        continue;
      }

      sleepSync(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 50);
    }

    throw new DeliveryError(
      'DELIVERY_BUSY',
      `Timed out acquiring delivery state lock after ${lockTimeoutMs}ms`,
      { lock_file: lockFile }
    );
  }

  function releaseLock(owner) {
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (current.pid === owner.pid && current.token === owner.token) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // The lock is already gone or no longer ours; never delete blindly.
    }
  }

  function transaction(mutator) {
    const owner = acquireLock();
    try {
      const state = readState();
      const result = mutator(state);
      pruneTerminalDeliveries(state);
      writeState(state);
      return result;
    } finally {
      releaseLock(owner);
    }
  }

  function pruneTerminalDeliveries(state) {
    const cutoff = now() - terminalRetentionMs;
    for (const [id, delivery] of Object.entries(state.deliveries)) {
      if ((delivery.status === 'acked' || delivery.status === 'dead_letter') &&
          new Date(delivery.updated_at).getTime() < cutoff) {
        delete state.deliveries[id];
      }
    }
  }

  function assertActiveSession(state, agent, epoch) {
    const consumer = state.consumers[agent];
    if (!consumer || consumer.epoch !== epoch) {
      throw new DeliveryError(
        'STALE_SESSION',
        `Session epoch for "${agent}" is stale or unknown`,
        {
          agent,
          expected_epoch: consumer ? consumer.epoch : null,
          received_epoch: epoch || null,
        }
      );
    }
    return consumer;
  }

  function registerSession(params) {
    validateAgentEpoch(params);
    const capabilities = normalizeCapabilities(params.capabilities);
    return transaction((state) => {
      const timestamp = new Date(now()).toISOString();
      state.consumers[params.agent] = {
        agent: params.agent,
        epoch: params.epoch,
        ready: false,
        capabilities,
        updated_at: timestamp,
      };
      return clone(state.consumers[params.agent]);
    });
  }

  function setReady(params) {
    validateAgentEpoch(params);
    return transaction((state) => {
      const consumer = assertActiveSession(state, params.agent, params.epoch);
      consumer.ready = params.ready !== false;
      if (params.capabilities) {
        consumer.capabilities = normalizeCapabilities(params.capabilities);
      }
      consumer.updated_at = new Date(now()).toISOString();
      return clone(consumer);
    });
  }

  function assertSession(agent, epoch) {
    if (!agent || !epoch) {
      throw new DeliveryError('STALE_SESSION', 'Agent and session epoch are required');
    }
    const state = readState();
    return clone(assertActiveSession(state, agent, epoch));
  }

  function enqueue(params) {
    validateEnqueue(params);
    const requiredCapabilities = normalizeCapabilities(params.requiredCapabilities);
    return transaction((state) => {
      if (params.idempotencyKey) {
        const existing = Object.values(state.deliveries).find((delivery) =>
          delivery.sender === params.sender &&
          delivery.recipient === params.recipient &&
          delivery.kind === (params.kind || 'message') &&
          delivery.idempotency_key === params.idempotencyKey
        );
        if (existing) {
          return { delivery: clone(existing), duplicate: true };
        }
      }

      const timestampMs = now();
      const timestamp = new Date(timestampMs).toISOString();
      const messageId = params.messageId || params.payloadRef || makeToken();
      const id = params.deliveryId || `${messageId}:${params.recipient}`;
      const existingById = state.deliveries[id];
      if (existingById) {
        return { delivery: clone(existingById), duplicate: true };
      }

      const delivery = {
        id,
        message_id: messageId,
        kind: params.kind || 'message',
        sender: params.sender,
        recipient: params.recipient,
        payload_ref: params.payloadRef || messageId,
        status: 'pending',
        attempts: 0,
        max_attempts: positiveInteger(params.maxAttempts, maxAttempts),
        available_at: timestamp,
        expires_at: params.ttlMs
          ? new Date(timestampMs + positiveInteger(params.ttlMs, 0)).toISOString()
          : null,
        priority: ['critical', 'high', 'normal', 'low'].includes(params.priority)
          ? params.priority
          : 'normal',
        required_capabilities: requiredCapabilities,
        idempotency_key: params.idempotencyKey || null,
        lease: null,
        last_error: null,
        created_at: timestamp,
        updated_at: timestamp,
      };
      state.deliveries[id] = delivery;
      return { delivery: clone(delivery), duplicate: false };
    });
  }

  function claim(params) {
    validateAgentEpoch(params);
    const limit = Math.min(positiveInteger(params.limit, 1), 20);
    return transaction((state) => {
      const consumer = assertActiveSession(state, params.agent, params.epoch);
      if (!consumer.ready) {
        throw new DeliveryError(
          'CONSUMER_NOT_READY',
          `Agent "${params.agent}" has not declared delivery readiness`
        );
      }

      const capabilities = new Set(consumer.capabilities);
      const timestampMs = now();
      const claimed = [];
      const deliveries = Object.values(state.deliveries)
        .filter((delivery) => delivery.recipient === params.agent)
        .sort((a, b) => {
          const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
          if (priorityDelta) return priorityDelta;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

      for (const delivery of deliveries) {
        normalizeExpiredDelivery(delivery, timestampMs);
        if (delivery.status !== 'pending') continue;
        if (new Date(delivery.available_at).getTime() > timestampMs) continue;
        const missing = delivery.required_capabilities.filter((capability) => !capabilities.has(capability));
        if (missing.length > 0) {
          delivery.blocked_reason = {
            code: 'CAPABILITY_NOT_READY',
            missing_capabilities: missing,
          };
          delivery.updated_at = new Date(timestampMs).toISOString();
          continue;
        }

        delete delivery.blocked_reason;
        const leaseToken = makeToken();
        delivery.status = 'leased';
        delivery.attempts += 1;
        delivery.lease = {
          token: leaseToken,
          owner: params.agent,
          epoch: params.epoch,
          leased_at: new Date(timestampMs).toISOString(),
          expires_at: new Date(timestampMs + leaseMs).toISOString(),
        };
        delivery.updated_at = new Date(timestampMs).toISOString();
        claimed.push(clone(delivery));
        if (claimed.length >= limit) break;
      }
      return claimed;
    });
  }

  function ack(params) {
    validateAgentEpoch(params);
    if (!params.deliveryId) throw new TypeError('deliveryId is required');
    return transaction((state) => {
      assertActiveSession(state, params.agent, params.epoch);
      const delivery = requireDelivery(state, params.deliveryId);
      assertLeaseOwner(delivery, params);
      const timestamp = new Date(now()).toISOString();
      delivery.status = 'acked';
      delivery.acked_at = timestamp;
      delivery.updated_at = timestamp;
      delivery.lease = null;
      delete delivery.blocked_reason;
      return clone(delivery);
    });
  }

  function ackLeases(params) {
    validateAgentEpoch(params);
    const allow = params.deliveryIds ? new Set(params.deliveryIds) : null;
    return transaction((state) => {
      assertActiveSession(state, params.agent, params.epoch);
      const timestamp = new Date(now()).toISOString();
      const acked = [];
      for (const delivery of Object.values(state.deliveries)) {
        if (delivery.status !== 'leased' || !delivery.lease) continue;
        if (delivery.lease.owner !== params.agent || delivery.lease.epoch !== params.epoch) continue;
        if (allow && !allow.has(delivery.id)) continue;
        delivery.status = 'acked';
        delivery.acked_at = timestamp;
        delivery.updated_at = timestamp;
        delivery.lease = null;
        acked.push(clone(delivery));
      }
      return acked;
    });
  }

  function fail(params) {
    validateAgentEpoch(params);
    if (!params.deliveryId) throw new TypeError('deliveryId is required');
    return transaction((state) => {
      assertActiveSession(state, params.agent, params.epoch);
      const delivery = requireDelivery(state, params.deliveryId);
      assertLeaseOwner(delivery, params);
      const timestampMs = now();
      delivery.last_error = {
        code: params.code || 'DELIVERY_FAILED',
        message: String(params.error || 'Delivery processing failed').slice(0, 1000),
        at: new Date(timestampMs).toISOString(),
      };
      delivery.lease = null;
      if (params.retryable === false || delivery.attempts >= delivery.max_attempts) {
        moveToDeadLetter(delivery, timestampMs, 'max_attempts_exceeded');
      } else {
        const retryDelay = retryBaseMs * Math.pow(2, Math.max(0, delivery.attempts - 1));
        delivery.status = 'pending';
        delivery.available_at = new Date(timestampMs + retryDelay).toISOString();
        delivery.updated_at = new Date(timestampMs).toISOString();
      }
      return clone(delivery);
    });
  }

  function redrive(params) {
    if (!params || !params.deliveryId) throw new TypeError('deliveryId is required');
    return transaction((state) => {
      const delivery = requireDelivery(state, params.deliveryId);
      if (delivery.status !== 'dead_letter') {
        throw new DeliveryError(
          'DELIVERY_NOT_DEAD',
          `Delivery "${params.deliveryId}" is not in the dead-letter queue`
        );
      }
      const timestamp = new Date(now()).toISOString();
      delivery.status = 'pending';
      delivery.attempts = 0;
      delivery.available_at = timestamp;
      delivery.updated_at = timestamp;
      delivery.dead_lettered_at = null;
      delivery.dead_letter_reason = null;
      delivery.last_error = null;
      delivery.lease = null;
      return clone(delivery);
    });
  }

  function getDeliveries(filters = {}) {
    const state = readState();
    const timestampMs = now();
    return Object.values(state.deliveries)
      .map((delivery) => {
        const copy = clone(delivery);
        normalizeExpiredDelivery(copy, timestampMs);
        return copy;
      })
      .filter((delivery) => !filters.recipient || delivery.recipient === filters.recipient)
      .filter((delivery) => !filters.status || delivery.status === filters.status)
      .filter((delivery) => !filters.messageId || delivery.message_id === filters.messageId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  function getDeadLetters(recipient) {
    return getDeliveries({ recipient, status: 'dead_letter' });
  }

  function normalizeExpiredDelivery(delivery, timestampMs) {
    if (delivery.status === 'acked' || delivery.status === 'dead_letter') return;
    if (delivery.expires_at && new Date(delivery.expires_at).getTime() <= timestampMs) {
      moveToDeadLetter(delivery, timestampMs, 'ttl_expired');
      return;
    }
    if (delivery.status === 'leased' && delivery.lease &&
        new Date(delivery.lease.expires_at).getTime() <= timestampMs) {
      delivery.lease = null;
      if (delivery.attempts >= delivery.max_attempts) {
        moveToDeadLetter(delivery, timestampMs, 'lease_attempts_exhausted');
      } else {
        delivery.status = 'pending';
        delivery.available_at = new Date(timestampMs).toISOString();
        delivery.updated_at = new Date(timestampMs).toISOString();
      }
    }
  }

  function moveToDeadLetter(delivery, timestampMs, reason) {
    const timestamp = new Date(timestampMs).toISOString();
    delivery.status = 'dead_letter';
    delivery.dead_lettered_at = timestamp;
    delivery.dead_letter_reason = reason;
    delivery.updated_at = timestamp;
    delivery.lease = null;
  }

  return {
    stateFile,
    registerSession,
    setReady,
    assertSession,
    enqueue,
    claim,
    ack,
    ackLeases,
    fail,
    redrive,
    getDeliveries,
    getDeadLetters,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function validateAgentEpoch(params) {
  if (!params || typeof params.agent !== 'string' || !params.agent) {
    throw new TypeError('agent is required');
  }
  if (typeof params.epoch !== 'string' || !params.epoch) {
    throw new TypeError('epoch is required');
  }
}

function validateEnqueue(params) {
  if (!params || typeof params.sender !== 'string' || !params.sender) {
    throw new TypeError('sender is required');
  }
  if (typeof params.recipient !== 'string' || !params.recipient) {
    throw new TypeError('recipient is required');
  }
  if (params.idempotencyKey != null &&
      (typeof params.idempotencyKey !== 'string' || !params.idempotencyKey.trim())) {
    throw new TypeError('idempotencyKey must be a non-empty string');
  }
}

function requireDelivery(state, deliveryId) {
  const delivery = state.deliveries[deliveryId];
  if (!delivery) {
    throw new DeliveryError('DELIVERY_NOT_FOUND', `Delivery "${deliveryId}" was not found`);
  }
  return delivery;
}

function assertLeaseOwner(delivery, params) {
  if (delivery.status !== 'leased' || !delivery.lease) {
    throw new DeliveryError(
      'DELIVERY_NOT_LEASED',
      `Delivery "${delivery.id}" does not have an active lease`
    );
  }
  if (delivery.lease.owner !== params.agent || delivery.lease.epoch !== params.epoch) {
    throw new DeliveryError(
      'STALE_LEASE',
      `Delivery "${delivery.id}" is leased to another session`
    );
  }
  if (params.leaseToken && delivery.lease.token !== params.leaseToken) {
    throw new DeliveryError(
      'STALE_LEASE',
      `Lease token for delivery "${delivery.id}" is stale`
    );
  }
}

function priorityRank(priority) {
  return { critical: 4, high: 3, normal: 2, low: 1 }[priority] || 0;
}

function classifyStorageError(error, target) {
  if (error instanceof DeliveryError) return error;
  if (error && error.code === 'ENOSPC') {
    return new DeliveryError('STORAGE_FULL', `Disk is full while writing ${target}`);
  }
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return new DeliveryError('PERMISSION_DENIED', `Permission denied while writing ${target}`);
  }
  return error;
}

module.exports = {
  STATE_VERSION,
  DeliveryError,
  createDurableDeliveryStore,
  normalizeCapabilities,
};
