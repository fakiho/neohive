#!/usr/bin/env node
'use strict';

// Integration test for tools/delivery.js — exercises the MCP tool-handler
// layer (ctx injection, session epoch reuse of registeredToken, arg mapping)
// on top of the already-unit-tested lib/durable-delivery.js engine.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-delivery-tool-'));

function makeAgentCtx(name) {
  const agentState = { registeredName: null, registeredToken: null };
  const delivery = require('../tools/delivery')({
    state: {
      get registeredName() { return agentState.registeredName; },
      get registeredToken() { return agentState.registeredToken; },
    },
    helpers: {
      generateId: () => Math.random().toString(36).slice(2),
      ensureDataDir: () => fs.mkdirSync(root, { recursive: true }),
      touchActivity: () => {},
    },
    files: { DATA_DIR: root },
  });
  agentState.registeredName = name;
  agentState.registeredToken = `token-${name}-1`;
  return { delivery, agentState };
}

const lead = makeAgentCtx('Lead');
const coder = makeAgentCtx('Coder');

test('enqueue_delivery requires registration', () => {
  const anon = require('../tools/delivery')({
    state: { registeredName: null, registeredToken: null },
    helpers: { generateId: () => 'x', ensureDataDir: () => {}, touchActivity: () => {} },
    files: { DATA_DIR: root },
  });
  const result = anon.handlers.enqueue_delivery({ recipient: 'Coder' });
  assert.strictEqual(result.error, 'You must call register() first');
});

test('enqueue_delivery rejects self-delivery', () => {
  const result = lead.delivery.handlers.enqueue_delivery({ recipient: 'Lead', payload: { x: 1 } });
  assert.ok(result.error);
});

let deliveryId;
test('enqueue_delivery creates a pending delivery for the recipient', () => {
  const result = lead.delivery.handlers.enqueue_delivery({
    recipient: 'Coder',
    payload: { instruction: 'run migration' },
    kind: 'command',
    idempotency_key: 'migrate:v1',
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.duplicate, false);
  deliveryId = result.delivery_id;
});

test('duplicate enqueue with same idempotency_key is a no-op', () => {
  const result = lead.delivery.handlers.enqueue_delivery({
    recipient: 'Coder',
    payload: { instruction: 'run migration AGAIN' },
    kind: 'command',
    idempotency_key: 'migrate:v1',
  });
  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(result.delivery_id, deliveryId);
});

test('recipient without registration cannot claim', () => {
  const anon = require('../tools/delivery')({
    state: { registeredName: null, registeredToken: null },
    helpers: { generateId: () => 'x', ensureDataDir: () => {}, touchActivity: () => {} },
    files: { DATA_DIR: root },
  });
  const result = anon.handlers.claim_deliveries({});
  assert.strictEqual(result.error, 'You must call register() first');
});

let leaseToken;
test('claim_deliveries auto-registers a session and leases the delivery', () => {
  const result = coder.delivery.handlers.claim_deliveries({ limit: 5 });
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.deliveries[0].delivery_id, deliveryId);
  assert.deepStrictEqual(result.deliveries[0].payload, { instruction: 'run migration' });
  leaseToken = result.deliveries[0].lease_token;
  assert.ok(leaseToken);
});

test('a second claim call returns nothing new (already leased)', () => {
  const result = coder.delivery.handlers.claim_deliveries({ limit: 5 });
  assert.strictEqual(result.count, 0);
});

test('ack_delivery marks the delivery acked', () => {
  const result = coder.delivery.handlers.ack_delivery({ delivery_id: deliveryId, lease_token: leaseToken });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'acked');
});

test('list_deliveries reflects the acked state for the recipient', () => {
  const result = coder.delivery.handlers.list_deliveries({});
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.deliveries[0].status, 'acked');
});

test('re-registration rotates the epoch and fences stale acks', () => {
  const failing = lead.delivery.handlers.enqueue_delivery({
    recipient: 'Coder',
    payload: { instruction: 'deploy' },
    kind: 'command',
    max_attempts: 1,
  });
  const claim1 = coder.delivery.handlers.claim_deliveries({ limit: 5 });
  const claimed = claim1.deliveries.find((d) => d.delivery_id === failing.delivery_id);
  assert.ok(claimed);

  // Simulate Coder's process dying and a fresh process re-registering.
  coder.agentState.registeredToken = 'token-Coder-2';

  const staleAck = coder.delivery.handlers.ack_delivery({ delivery_id: claimed.delivery_id, lease_token: claimed.lease_token });
  assert.ok(staleAck.error, 'ack under a new epoch without reclaiming must fail');
  assert.strictEqual(staleAck.code, 'STALE_SESSION');
});

test('fail_delivery with retryable=false dead-letters immediately', () => {
  const enqueued = lead.delivery.handlers.enqueue_delivery({ recipient: 'Coder', payload: { instruction: 'noop' } });
  const claimed = coder.delivery.handlers.claim_deliveries({ limit: 5 }).deliveries
    .find((d) => d.delivery_id === enqueued.delivery_id);
  const failed = coder.delivery.handlers.fail_delivery({
    delivery_id: claimed.delivery_id,
    error: 'permanent config error',
    retryable: false,
    lease_token: claimed.lease_token,
  });
  assert.strictEqual(failed.status, 'dead_letter');
  const deadLetters = coder.delivery.handlers.list_dead_letters({});
  assert.ok(deadLetters.deliveries.some((d) => d.delivery_id === claimed.delivery_id));
});

test('redrive_delivery resets a dead-lettered delivery to pending', () => {
  const dead = coder.delivery.handlers.list_dead_letters({}).deliveries[0];
  const redriven = coder.delivery.handlers.redrive_delivery({ delivery_id: dead.delivery_id });
  assert.strictEqual(redriven.status, 'pending');
});

test('capability-gated delivery is only claimable after matching capabilities are declared', () => {
  const enqueued = lead.delivery.handlers.enqueue_delivery({
    recipient: 'Coder',
    payload: { instruction: 'db-migrate' },
    required_capabilities: ['database'],
  });
  // Coder's session currently has no capabilities (never declared any).
  const blockedClaim = coder.delivery.handlers.claim_deliveries({ limit: 10 });
  assert.strictEqual(blockedClaim.deliveries.some((d) => d.delivery_id === enqueued.delivery_id), false);

  const readyClaim = coder.delivery.handlers.claim_deliveries({ limit: 10, capabilities: ['database'] });
  assert.strictEqual(readyClaim.deliveries.some((d) => d.delivery_id === enqueued.delivery_id), true);
});

process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});

if (!process.exitCode) {
  process.stdout.write(`1..${passed}\n`);
}
