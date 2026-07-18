#!/usr/bin/env node
'use strict';

// End-to-end smoke test: spawns the real server.js as two separate MCP
// stdio processes (simulating two agents sharing a .neohive data dir) and
// drives the new durable-delivery tools through the actual JSON-RPC
// tools/list and tools/call surface, exercising the server.js dispatch
// wiring (not just the tools/delivery.js module in isolation).

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-smoke-delivery-'));
const serverPath = path.join(__dirname, '..', 'server.js');

function makeClient(env) {
  const proc = spawn('node', [serverPath], {
    env: { ...process.env, NEOHIVE_DATA_DIR: testDir, ...env },
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
  proc.stderr.on('data', () => {}); // swallow log noise

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, 10000);
    });
  }

  async function callTool(name, args) {
    const result = await request('tools/call', { name, arguments: args || {} });
    const text = result && result.content && result.content[0] && result.content[0].text;
    return text ? JSON.parse(text) : result;
  }

  return { proc, request, callTool };
}

async function main() {
  const lead = makeClient({});
  const coder = makeClient({});

  await lead.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  await coder.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });

  const toolsList = await lead.request('tools/list', {});
  const names = toolsList.tools.map((t) => t.name);
  const expected = ['enqueue_delivery', 'claim_deliveries', 'ack_delivery', 'fail_delivery', 'redrive_delivery', 'list_deliveries', 'list_dead_letters'];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`tools/list missing "${name}"`);
  }
  console.log('ok 1 - tools/list exposes all new durable-delivery tools');

  const reg1 = await lead.callTool('register', { name: 'SmokeLead', provider: 'test' });
  if (!reg1.success && reg1.error) throw new Error(`Lead register failed: ${reg1.error}`);
  console.log('ok 2 - Lead registered');

  const reg2 = await coder.callTool('register', { name: 'SmokeCoder', provider: 'test' });
  if (!reg2.success && reg2.error) throw new Error(`Coder register failed: ${reg2.error}`);
  console.log('ok 3 - Coder registered');

  const enqueued = await lead.callTool('enqueue_delivery', {
    recipient: 'SmokeCoder',
    payload: { instruction: 'deploy service X' },
    kind: 'command',
    idempotency_key: 'deploy:x:1',
  });
  if (!enqueued.success) throw new Error(`enqueue_delivery failed: ${JSON.stringify(enqueued)}`);
  console.log('ok 4 - Lead enqueued a durable delivery for Coder');

  const claimed = await coder.callTool('claim_deliveries', { limit: 5 });
  if (claimed.count !== 1 || claimed.deliveries[0].delivery_id !== enqueued.delivery_id) {
    throw new Error(`claim_deliveries did not return the expected delivery: ${JSON.stringify(claimed)}`);
  }
  if (claimed.deliveries[0].payload.instruction !== 'deploy service X') {
    throw new Error('claimed payload did not round-trip correctly');
  }
  console.log('ok 5 - Coder claimed the delivery with correct payload');

  const acked = await coder.callTool('ack_delivery', {
    delivery_id: claimed.deliveries[0].delivery_id,
    lease_token: claimed.deliveries[0].lease_token,
  });
  if (!acked.success || acked.status !== 'acked') throw new Error(`ack_delivery failed: ${JSON.stringify(acked)}`);
  console.log('ok 6 - Coder acked the delivery');

  const listed = await lead.callTool('list_deliveries', { recipient: 'SmokeCoder' });
  if (listed.count !== 1 || listed.deliveries[0].status !== 'acked') {
    throw new Error(`list_deliveries did not reflect acked state: ${JSON.stringify(listed)}`);
  }
  console.log('ok 7 - list_deliveries reflects acked state across processes');

  // Existing tools must be unaffected by the addition.
  const briefing = await lead.callTool('get_briefing', {});
  if (!briefing || briefing.error) throw new Error(`get_briefing regressed: ${JSON.stringify(briefing)}`);
  console.log('ok 8 - pre-existing get_briefing tool still works (no regression)');

  console.log('1..8');
  console.log('ALL SMOKE TESTS PASSED');

  lead.proc.kill();
  coder.proc.kill();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
