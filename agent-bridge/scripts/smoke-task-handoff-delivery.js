#!/usr/bin/env node
'use strict';

// Real end-to-end proof (two separate server.js MCP stdio processes sharing a
// .neohive data dir) that:
//  1. create_task(assignee) durably backs the assignment — existing
//     get_briefing/task_reminder behavior is unchanged (no new visible message).
//  2. The assignee can claim + ack that durable record.
//  3. If the assignee's process crashes BEFORE claiming, a freshly restarted
//     process for the same agent name (new registration/session epoch) can
//     still claim_deliveries() and receive the exact same pending record —
//     durable delivery survives a recipient restart.
//  4. Nothing is duplicated: exactly one delivery exists per task assignment.
//  5. Full fencing lifecycle, not just queued pickup: an agent CLAIMS a lease
//     under epoch e1, its session is superseded by a re-registration (e1b) —
//     an ack attempt reusing the e1 lease token is rejected (STALE_LEASE) even
//     though the session itself is still active. Then that leased-but-unacked
//     delivery is abandoned (process dies), its lease expires, and a freshly
//     restarted process (epoch e2) reclaims and acks it successfully.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-smoke-handoff-'));
const serverPath = path.join(__dirname, '..', 'server.js');
// Test-only short lease so the expiry-driven reclaim (scenario 5) doesn't
// need to wait out the 30s production default. See tools/delivery.js.
const testEnv = { ...process.env, NEOHIVE_DATA_DIR: testDir, NEOHIVE_DELIVERY_LEASE_MS: '1200' };

function makeClient() {
  const proc = spawn('node', [serverPath], {
    env: testEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });
  proc.stderr.on('data', () => {});

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`Timed out waiting for ${method}`)); }
      }, 10000);
    });
  }

  async function callTool(name, args) {
    const result = await request('tools/call', { name, arguments: args || {} });
    const text = result && result.content && result.content[0] && result.content[0].text;
    return text ? JSON.parse(text) : result;
  }

  async function init() {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  }

  return { proc, request, callTool, init };
}

async function main() {
  const lead = makeClient();
  await lead.init();
  await lead.callTool('register', { name: 'HLead', provider: 'test' });

  const coderV1 = makeClient();
  await coderV1.init();
  await coderV1.callTool('register', { name: 'HCoder', provider: 'test' });
  console.log('ok 1 - Lead and Coder (v1) registered');

  // --- Assignment #1: claimed normally before any crash ---
  const created1 = await lead.callTool('create_task', { title: 'Deploy service X', description: 'Ship it', assignee: 'HCoder' });
  if (!created1.success) throw new Error(`create_task failed: ${JSON.stringify(created1)}`);
  if (Object.keys(created1).sort().join(',') !== 'assignee,next_action,success,task_id') {
    throw new Error(`create_task response shape changed unexpectedly: ${JSON.stringify(created1)}`);
  }
  console.log('ok 2 - create_task response shape is unchanged (no new visible fields)');

  // getTasks() has a pre-existing 2s in-memory read cache per process (unrelated
  // to this change) — wait past it so get_briefing reflects the fresh write.
  await new Promise((r) => setTimeout(r, 2100));
  const briefing1 = await coderV1.callTool('get_briefing', {});
  const seenInBriefing = (briefing1.your_tasks || []).some((t) => t.id === created1.task_id);
  if (!seenInBriefing) throw new Error(`task assignment not visible via existing get_briefing/your_tasks path: ${JSON.stringify(briefing1.your_tasks)}`);
  console.log('ok 3 - existing task_reminder/your_tasks visibility is unaffected');

  const claim1 = await coderV1.callTool('claim_deliveries', { limit: 5 });
  const match1 = claim1.deliveries.find((d) => d.payload && d.payload.task_id === created1.task_id);
  if (!match1) throw new Error(`durable delivery for task 1 not claimable: ${JSON.stringify(claim1)}`);
  const ack1 = await coderV1.callTool('ack_delivery', { delivery_id: match1.delivery_id, lease_token: match1.lease_token });
  if (!ack1.success) throw new Error(`ack_delivery failed: ${JSON.stringify(ack1)}`);
  console.log('ok 4 - Coder (v1) claimed and acked the durable record for task 1');

  // --- Assignment #2: created, then Coder crashes BEFORE claiming it ---
  const created2 = await lead.callTool('create_task', { title: 'Deploy service Y', description: 'Ship it too', assignee: 'HCoder' });
  if (!created2.success) throw new Error(`create_task #2 failed: ${JSON.stringify(created2)}`);
  console.log('ok 5 - second task created for HCoder, left unclaimed');

  coderV1.proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  // --- A brand-new process re-registers as the SAME agent (new session epoch) ---
  const coderV2 = makeClient();
  await coderV2.init();
  const reReg = await coderV2.callTool('register', { name: 'HCoder', provider: 'test' });
  if (reReg.error) throw new Error(`Coder restart re-registration failed: ${reReg.error}`);
  console.log('ok 6 - Coder restarted as a fresh process and re-registered (new session epoch)');

  const claim2 = await coderV2.callTool('claim_deliveries', { limit: 10 });
  const match2 = claim2.deliveries.find((d) => d.payload && d.payload.task_id === created2.task_id);
  if (!match2) throw new Error(`restarted Coder could not claim the pre-crash delivery: ${JSON.stringify(claim2)}`);
  console.log('ok 7 - restarted Coder (v2) claimed the pending delivery left over from before the crash');

  // Confirm no duplicate: exactly one non-acked delivery should have existed for task 2.
  const pendingForTask2 = claim2.deliveries.filter((d) => d.payload && d.payload.task_id === created2.task_id);
  if (pendingForTask2.length !== 1) throw new Error(`expected exactly 1 delivery for task 2, got ${pendingForTask2.length}`);
  console.log('ok 8 - exactly one delivery existed for task 2 (no duplication across the crash/restart)');

  const ack2 = await coderV2.callTool('ack_delivery', { delivery_id: match2.delivery_id, lease_token: match2.lease_token });
  if (!ack2.success) throw new Error(`ack_delivery after restart failed: ${JSON.stringify(ack2)}`);
  console.log('ok 9 - restarted Coder acked the recovered delivery successfully');

  const finalList = await lead.callTool('list_deliveries', { recipient: 'HCoder' });
  if (finalList.count !== 2 || !finalList.deliveries.every((d) => d.status === 'acked')) {
    throw new Error(`expected exactly 2 acked deliveries total, got: ${JSON.stringify(finalList)}`);
  }
  console.log('ok 10 - exactly 2 deliveries total across both tasks, both acked, none duplicated or lost');

  // --- Assignment #3: full fencing lifecycle (claim -> session superseded ->
  // stale-token ack rejected -> lease expires -> restart reclaims -> acks) ---
  const created3 = await lead.callTool('create_task', { title: 'Deploy service W', description: 'Ship it thrice', assignee: 'HCoder' });
  if (!created3.success) throw new Error(`create_task #3 failed: ${JSON.stringify(created3)}`);

  const claim3 = await coderV2.callTool('claim_deliveries', { limit: 10 });
  const match3 = claim3.deliveries.find((d) => d.payload && d.payload.task_id === created3.task_id);
  if (!match3) throw new Error(`could not claim delivery for task 3: ${JSON.stringify(claim3)}`);
  const staleLeaseToken = match3.lease_token;
  console.log('ok 11 - coderV2 (epoch e1) claimed task 3, leasing it under its current session');

  // Same live process re-registers, rotating its session epoch to e1b. The
  // session itself is still perfectly valid — but the lease token above now
  // belongs to a stale epoch.
  const reReg3 = await coderV2.callTool('register', { name: 'HCoder', provider: 'test' });
  if (reReg3.error) throw new Error(`coderV2 self re-registration failed: ${JSON.stringify(reReg3)}`);
  // The durable-delivery session is refreshed lazily on the next
  // claim_deliveries() call (that's what actually calls registerSession() for
  // the new epoch) — this mirrors how a real reconnecting agent behaves.
  await coderV2.callTool('claim_deliveries', { limit: 1 });
  console.log('ok 12 - coderV2 re-registered itself, rotating to a new session epoch (e1b)');

  const staleAck = await coderV2.callTool('ack_delivery', { delivery_id: match3.delivery_id, lease_token: staleLeaseToken });
  if (staleAck.success) throw new Error(`ack with a stale-epoch lease token should have been rejected, got: ${JSON.stringify(staleAck)}`);
  if (staleAck.code !== 'STALE_LEASE') throw new Error(`expected STALE_LEASE, got: ${JSON.stringify(staleAck)}`);
  console.log('ok 13 - ack with the pre-rotation lease token was rejected as STALE_LEASE despite an otherwise-valid current session');

  // Now the process truly dies with the lease still outstanding and unacked.
  coderV2.proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 1600)); // past the 1200ms test lease TTL

  const coderV3 = makeClient();
  await coderV3.init();
  const reReg4 = await coderV3.callTool('register', { name: 'HCoder', provider: 'test' });
  if (reReg4.error) throw new Error(`coderV3 restart re-registration failed: ${JSON.stringify(reReg4)}`);
  console.log('ok 14 - coderV3 restarted fresh after the crash (new session epoch e2)');

  const claim4 = await coderV3.callTool('claim_deliveries', { limit: 10 });
  const match4 = claim4.deliveries.find((d) => d.payload && d.payload.task_id === created3.task_id);
  if (!match4) throw new Error(`coderV3 could not reclaim the expired-lease delivery: ${JSON.stringify(claim4)}`);
  console.log('ok 15 - coderV3 reclaimed the same delivery once its lease expired (no data loss across the crash)');

  const ack4 = await coderV3.callTool('ack_delivery', { delivery_id: match4.delivery_id, lease_token: match4.lease_token });
  if (!ack4.success) throw new Error(`final ack after reclaim failed: ${JSON.stringify(ack4)}`);
  console.log('ok 16 - coderV3 acked the reclaimed delivery under its own fresh epoch');

  const finalList2 = await lead.callTool('list_deliveries', { recipient: 'HCoder' });
  if (finalList2.count !== 3 || !finalList2.deliveries.every((d) => d.status === 'acked')) {
    throw new Error(`expected exactly 3 acked deliveries total, got: ${JSON.stringify(finalList2)}`);
  }
  console.log('ok 17 - exactly 3 deliveries total across all three tasks, all acked, none duplicated or lost');

  console.log('1..17');
  console.log('ALL SMOKE TESTS PASSED');

  lead.proc.kill();
  coderV3.proc.kill();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
