#!/usr/bin/env node
'use strict';

// Focused test for the persistent-charter fix: every listen() response
// (both the single-message shape from buildMessageResponse and the
// multi-message shape from buildBatchMessageResponse) must carry a
// `charter` object with { role, responsibilities, active_rules } so agents
// don't forget their role/responsibilities as context fills.
// Mirrors the stdio-spawn pattern in scripts/smoke-delivery-mcp.js.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-test-charter-'));
const serverPath = path.join(__dirname, '..', 'server.js');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

function makeClient(env) {
  const proc = spawn('node', [serverPath], {
    // Isolate the global registry to the test dir so register() never pollutes
    // the real ~/.neohive/registry.json.
    env: { ...process.env, NEOHIVE_DATA_DIR: testDir, NEOHIVE_REGISTRY_FILE: path.join(testDir, 'registry.json'), ...env },
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

function assertCharterShape(charter, label) {
  assert(!!charter, `${label}: charter field present`);
  if (!charter) return;
  assert(typeof charter.role === 'string' && charter.role.length > 0, `${label}: charter.role is a non-empty string`);
  assert(Array.isArray(charter.responsibilities) && charter.responsibilities.length >= 5, `${label}: charter.responsibilities is a populated array`);
  assert(Array.isArray(charter.active_rules), `${label}: charter.active_rules is an array`);
  const respText = charter.responsibilities.join(' ');
  assert(/send_message/.test(respText), `${label}: responsibilities mention send_message reporting`);
  assert(/artifacts/.test(respText), `${label}: responsibilities mention artifacts convention`);
  assert(/listen\(\)/.test(respText), `${label}: responsibilities mention listen() as last call`);
}

async function main() {
  const lead = makeClient({});
  const coder = makeClient({});

  await lead.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await coder.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  const reg1 = await lead.callTool('register', { name: 'CharterLead', provider: 'test' });
  if (!reg1.success && reg1.error) throw new Error(`Lead register failed: ${reg1.error}`);
  const reg2 = await coder.callTool('register', { name: 'CharterCoder', provider: 'test' });
  if (!reg2.success && reg2.error) throw new Error(`Coder register failed: ${reg2.error}`);
  console.log('ok - both agents registered');

  // Single-message shape: buildMessageResponse
  await lead.callTool('send_message', { to: 'CharterCoder', content: 'hello single' });
  const single = await coder.callTool('listen', {});
  assert(single.success !== false, 'single listen() returned a message');
  assertCharterShape(single.charter, 'single-message listen()');

  // Multi-message shape: buildBatchMessageResponse (n > 1)
  await lead.callTool('send_message', { to: 'CharterCoder', content: 'hello batch 1' });
  await lead.callTool('send_message', { to: 'CharterCoder', content: 'hello batch 2' });
  const batch = await coder.callTool('listen', { n: 2 });
  assert(Array.isArray(batch.messages), 'batch listen() returned messages array');
  assertCharterShape(batch.charter, 'multi-message listen()');

  lead.proc.kill();
  coder.proc.kill();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
}).finally(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
});
