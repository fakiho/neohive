#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DeliveryError,
  createDurableDeliveryStore,
} = require('../lib/durable-delivery');

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

function expectCode(code, fn) {
  assert.throws(fn, (error) => error instanceof DeliveryError && error.code === code);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-delivery-'));
let clock = Date.parse('2026-07-17T20:00:00.000Z');
let tokenSequence = 0;
const makeStore = (overrides = {}) => createDurableDeliveryStore({
  dataDir: root,
  now: () => clock,
  makeToken: () => `token-${++tokenSequence}`,
  leaseMs: 1000,
  retryBaseMs: 100,
  maxAttempts: 2,
  terminalRetentionMs: 60000,
  ...overrides,
});
const store = makeStore();

test('idempotent enqueue returns the original delivery', () => {
  const first = store.enqueue({
    sender: 'Lead',
    recipient: 'Coder',
    messageId: 'msg-1',
    payloadRef: 'msg-1',
    kind: 'command',
    idempotencyKey: 'deploy:42',
  });
  const duplicate = store.enqueue({
    sender: 'Lead',
    recipient: 'Coder',
    messageId: 'msg-2',
    payloadRef: 'msg-2',
    kind: 'command',
    idempotencyKey: 'deploy:42',
  });
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(duplicate.delivery.id, first.delivery.id);
  assert.strictEqual(store.getDeliveries().length, 1);
});

test('claim requires an active ready session', () => {
  expectCode('STALE_SESSION', () => store.claim({
    agent: 'Coder',
    epoch: 'epoch-1',
  }));
  store.registerSession({
    agent: 'Coder',
    epoch: 'epoch-1',
    capabilities: ['nodejs'],
  });
  store.setReady({
    agent: 'Coder',
    epoch: 'epoch-1',
    ready: false,
    capabilities: ['nodejs'],
  });
  expectCode('CONSUMER_NOT_READY', () => store.claim({
    agent: 'Coder',
    epoch: 'epoch-1',
  }));
});

test('capability-gated delivery waits until the consumer is ready', () => {
  store.enqueue({
    sender: 'Lead',
    recipient: 'Coder',
    messageId: 'msg-capability',
    kind: 'task',
    requiredCapabilities: ['database'],
  });
  store.setReady({
    agent: 'Coder',
    epoch: 'epoch-1',
    capabilities: ['nodejs'],
  });
  const blocked = store.claim({ agent: 'Coder', epoch: 'epoch-1', limit: 10 });
  assert.strictEqual(blocked.some((delivery) => delivery.message_id === 'msg-capability'), false);
  const state = store.getDeliveries({ messageId: 'msg-capability' })[0];
  assert.deepStrictEqual(state.blocked_reason.missing_capabilities, ['database']);

  store.setReady({
    agent: 'Coder',
    epoch: 'epoch-1',
    capabilities: ['nodejs', 'database'],
  });
  const claimed = store.claim({ agent: 'Coder', epoch: 'epoch-1', limit: 10 });
  assert.strictEqual(claimed.some((delivery) => delivery.message_id === 'msg-capability'), true);
});

test('session epoch fences stale acknowledgements', () => {
  const delivery = store.getDeliveries({ messageId: 'msg-capability' })[0];
  store.registerSession({
    agent: 'Coder',
    epoch: 'epoch-2',
    capabilities: ['nodejs', 'database'],
  });
  store.setReady({
    agent: 'Coder',
    epoch: 'epoch-2',
    capabilities: ['nodejs', 'database'],
  });
  expectCode('STALE_SESSION', () => store.setReady({
    agent: 'Coder',
    epoch: 'epoch-1',
    ready: true,
  }));
  expectCode('STALE_SESSION', () => store.claim({
    agent: 'Coder',
    epoch: 'epoch-1',
  }));
  expectCode('STALE_SESSION', () => store.ack({
    agent: 'Coder',
    epoch: 'epoch-1',
    deliveryId: delivery.id,
    leaseToken: delivery.lease.token,
  }));
  expectCode('STALE_LEASE', () => store.ack({
    agent: 'Coder',
    epoch: 'epoch-2',
    deliveryId: delivery.id,
    leaseToken: delivery.lease.token,
  }));
});

test('expired lease redelivers to the current session and can be acked', () => {
  clock += 1001;
  const redelivered = store.claim({ agent: 'Coder', epoch: 'epoch-2', limit: 10 })
    .find((delivery) => delivery.message_id === 'msg-capability');
  assert(redelivered);
  assert.strictEqual(redelivered.attempts, 2);
  const acked = store.ack({
    agent: 'Coder',
    epoch: 'epoch-2',
    deliveryId: redelivered.id,
    leaseToken: redelivered.lease.token,
  });
  assert.strictEqual(acked.status, 'acked');
});

test('retryable failures back off and exhaust into dead-letter', () => {
  store.enqueue({
    sender: 'Lead',
    recipient: 'Coder',
    messageId: 'msg-fail',
    kind: 'handoff',
  });
  const first = store.claim({ agent: 'Coder', epoch: 'epoch-2', limit: 10 })
    .find((delivery) => delivery.message_id === 'msg-fail');
  const retry = store.fail({
    agent: 'Coder',
    epoch: 'epoch-2',
    deliveryId: first.id,
    leaseToken: first.lease.token,
    error: 'worker crashed',
  });
  assert.strictEqual(retry.status, 'pending');
  assert.strictEqual(store.claim({ agent: 'Coder', epoch: 'epoch-2', limit: 10 })
    .some((delivery) => delivery.message_id === 'msg-fail'), false);

  clock += 100;
  const second = store.claim({ agent: 'Coder', epoch: 'epoch-2', limit: 10 })
    .find((delivery) => delivery.message_id === 'msg-fail');
  const dead = store.fail({
    agent: 'Coder',
    epoch: 'epoch-2',
    deliveryId: second.id,
    leaseToken: second.lease.token,
    error: 'worker crashed again',
  });
  assert.strictEqual(dead.status, 'dead_letter');
  assert.strictEqual(store.getDeadLetters('Coder').some((item) => item.id === dead.id), true);
});

test('dead-letter entries can be explicitly redriven', () => {
  const dead = store.getDeadLetters('Coder').find((item) => item.message_id === 'msg-fail');
  const redriven = store.redrive({ deliveryId: dead.id });
  assert.strictEqual(redriven.status, 'pending');
  assert.strictEqual(redriven.attempts, 0);
  assert.strictEqual(redriven.last_error, null);
});

test('TTL expiry moves undelivered work to dead-letter', () => {
  store.enqueue({
    sender: 'Lead',
    recipient: 'Coder',
    messageId: 'msg-expiring',
    ttlMs: 50,
  });
  clock += 51;
  const expired = store.getDeliveries({ messageId: 'msg-expiring' })[0];
  assert.strictEqual(expired.status, 'dead_letter');
  assert.strictEqual(expired.dead_letter_reason, 'ttl_expired');
});

test('implicit lease acknowledgement only affects the current epoch', () => {
  store.enqueue({
    sender: 'Lead',
    recipient: 'Coder',
    messageId: 'msg-implicit',
  });
  const leased = store.claim({ agent: 'Coder', epoch: 'epoch-2', limit: 10 })
    .find((delivery) => delivery.message_id === 'msg-implicit');
  assert(leased);
  const acked = store.ackLeases({
    agent: 'Coder',
    epoch: 'epoch-2',
    deliveryIds: [leased.id],
  });
  assert.deepStrictEqual(acked.map((item) => item.id), [leased.id]);
});

test('state survives a new store instance', () => {
  const reloaded = makeStore();
  const delivery = reloaded.getDeliveries({ messageId: 'msg-implicit' })[0];
  assert.strictEqual(delivery.status, 'acked');
  const session = reloaded.assertSession('Coder', 'epoch-2');
  assert.strictEqual(session.ready, true);
});

test('corrupt delivery state fails closed', () => {
  const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-delivery-corrupt-'));
  fs.writeFileSync(path.join(corruptRoot, 'deliveries.json'), '{broken');
  const corruptStore = createDurableDeliveryStore({ dataDir: corruptRoot });
  expectCode('DELIVERY_STATE_CORRUPT', () => corruptStore.getDeliveries());
  fs.rmSync(corruptRoot, { recursive: true, force: true });
});

process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
});

if (!process.exitCode) {
  process.stdout.write(`1..${passed}\n`);
}
