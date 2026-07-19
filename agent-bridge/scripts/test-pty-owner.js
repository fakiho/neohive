#!/usr/bin/env node
'use strict';

// Focused tests for lib/pty-owner.js — Story 1.1 (node-pty Agent Launcher).
// Governs FR-1, FR-3, FR-7, FR-8; NFR-1, NFR-3, NFR-4, NFR-5; AD-1, AD-2,
// AD-6, AD-7. See _bmad-output/planning-artifacts/epics-node-pty-launcher.md.
//
// Run: node scripts/test-pty-owner.js

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-pty-owner-'));
}

function freshOwnerModule() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge', 'lib', 'pty-owner'))) delete require.cache[k];
  }
  return require('../lib/pty-owner');
}

// --- 1. Redaction (AD-7, NFR-5) ---
console.log('\n[1] Secret redaction (AD-7, NFR-5)');
{
  const { __test__ } = freshOwnerModule();
  test('redacts AWS access key IDs', () => {
    const out = __test__.redact('config: key=AKIAABCDEFGHIJKLMNOP done');
    if (out.includes('AKIA')) throw new Error('AWS key not redacted: ' + out);
  });
  test('redacts Bearer tokens', () => {
    const out = __test__.redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    if (out.includes('abcdefghijklmnopqrstuvwxyz')) throw new Error('bearer token not redacted: ' + out);
    if (!out.includes('[REDACTED]')) throw new Error('missing redaction marker');
  });
  test('redacts key=value style secrets (api_key/secret/token/password)', () => {
    const out = __test__.redact('api_key="sk-abcdefghijklmnop1234567890"');
    if (out.includes('sk-abcdefghijklmnop')) throw new Error('secret value leaked: ' + out);
  });
  test('redacts PEM private key blocks', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----';
    const out = __test__.redact(`before ${pem} after`);
    if (out.includes('MIIEvQIBADAN')) throw new Error('private key contents leaked: ' + out);
  });
  test('leaves ordinary output untouched', () => {
    const text = 'hello world, this is normal agent output with no secrets\n';
    if (__test__.redact(text) !== text) throw new Error('unexpected mutation of clean text');
  });
}

// --- 2. Naming / path helpers ---
console.log('\n[2] Naming and path helpers');
{
  const mod = freshOwnerModule();
  test('sanitizeAgentName accepts valid names', () => {
    if (mod.sanitizeAgentName('Agent-1_test') !== 'Agent-1_test') throw new Error('valid name mutated');
  });
  test('sanitizeAgentName strips unsafe characters', () => {
    const out = mod.sanitizeAgentName('../../etc/passwd');
    if (out.includes('/') || out.includes('.')) throw new Error('path traversal chars survived: ' + out);
  });
  test('sanitizeAgentName rejects empty/all-unsafe names', () => {
    let threw = false;
    try { mod.sanitizeAgentName('///'); } catch { threw = true; }
    if (!threw) throw new Error('expected throw for all-unsafe name');
  });
  test('agentLogPath / agentSocketPath / agentsJsonPath are namespaced under dataDir', () => {
    const dataDir = '/tmp/example-datadir';
    if (mod.agentLogPath(dataDir, 'Foo') !== path.join(dataDir, 'agent-log-Foo.jsonl')) throw new Error('unexpected log path');
    if (mod.agentSocketPath(dataDir, 'Foo') !== path.join(dataDir, 'pty-Foo.sock')) throw new Error('unexpected socket path');
    if (mod.agentsJsonPath(dataDir) !== path.join(dataDir, 'agents.json')) throw new Error('unexpected agents.json path');
  });
}

// --- 3. resolveCommandPath / BIN_NOT_FOUND (FR-3) ---
console.log('\n[3] Executable resolution and BIN_NOT_FOUND (FR-3)');
{
  const { __test__, startOwner } = freshOwnerModule();
  const dataDir = freshTmpDir();

  test('resolveCommandPath finds a real PATH binary (bash)', () => {
    const resolved = __test__.resolveCommandPath('bash');
    if (!resolved || !fs.existsSync(resolved)) throw new Error('did not resolve bash on PATH');
  });

  test('resolveCommandPath returns null for a nonexistent bare name', () => {
    if (__test__.resolveCommandPath('definitely-not-a-real-command-xyz') !== null) throw new Error('expected null');
  });

  test('resolveCommandPath returns null for a nonexistent absolute path', () => {
    if (__test__.resolveCommandPath('/nonexistent/binary/xyz123') !== null) throw new Error('expected null');
  });

  test('startOwner throws BIN_NOT_FOUND for an absolute path that does not exist', () => {
    let err = null;
    try { startOwner({ dataDir, agentName: 'X', command: '/nonexistent/binary/xyz123' }); }
    catch (e) { err = e; }
    if (!err || err.code !== 'BIN_NOT_FOUND') throw new Error('expected BIN_NOT_FOUND, got ' + (err && err.code));
  });

  test('startOwner throws BIN_NOT_FOUND for a bare name not on PATH', () => {
    let err = null;
    try { startOwner({ dataDir, agentName: 'X', command: 'definitely-not-a-real-command-xyz' }); }
    catch (e) { err = e; }
    if (!err || err.code !== 'BIN_NOT_FOUND') throw new Error('expected BIN_NOT_FOUND, got ' + (err && err.code));
  });

  test('startOwner does NOT leave an agents.json entry behind after a BIN_NOT_FOUND throw', () => {
    try { startOwner({ dataDir, agentName: 'NeverRegistered', command: '/nonexistent/xyz' }); } catch { /* expected */ }
    const agents = fs.existsSync(mod_agentsJsonPath(dataDir)) ? JSON.parse(fs.readFileSync(mod_agentsJsonPath(dataDir), 'utf8')) : {};
    if (agents.NeverRegistered) throw new Error('agent was registered despite spawn failure');
  });
  function mod_agentsJsonPath(dd) { return path.join(dd, 'agents.json'); }
}

// --- 4. PTY_UNAVAILABLE (AD-5 trigger condition) ---
console.log('\n[4] PTY_UNAVAILABLE surfaces cleanly when node-pty cannot load');
{
  test('startOwner throws PTY_UNAVAILABLE when node-pty require() fails', () => {
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'node-pty') { const e = new Error('simulated missing native module'); e.code = 'MODULE_NOT_FOUND'; throw e; }
      return origResolve.apply(this, [request, ...rest]);
    };
    try {
      for (const k of Object.keys(require.cache)) {
        if (k.includes(path.join('agent-bridge', 'lib', 'pty-owner')) || k.includes(`${path.sep}node-pty${path.sep}`)) delete require.cache[k];
      }
      const { startOwner, isPtyAvailable } = require('../lib/pty-owner');
      if (isPtyAvailable()) throw new Error('isPtyAvailable() should be false when require() fails');
      let err = null;
      try { startOwner({ dataDir: '/tmp', agentName: 'X', command: 'bash' }); }
      catch (e) { err = e; }
      if (!err || err.code !== 'PTY_UNAVAILABLE') throw new Error('expected PTY_UNAVAILABLE, got ' + (err && err.code));
    } finally {
      Module._resolveFilename = origResolve;
      for (const k of Object.keys(require.cache)) {
        if (k.includes(path.join('agent-bridge', 'lib', 'pty-owner'))) delete require.cache[k];
      }
    }
  });
}

// --- 5. End-to-end: spawn, capture, register, exit cleanup ---
console.log('\n[5] End-to-end owner lifecycle (FR-1, FR-7, FR-8, AD-2, AD-6)');

async function testLifecycle() {
  const { startOwner } = freshOwnerModule();
  const dataDir = freshTmpDir();

  await testAsync('registers PID in agents.json within the spawn call (FR-7, AD-6)', async () => {
    const owner = startOwner({ dataDir, agentName: 'LifecycleAgent', command: 'bash', args: ['-c', 'sleep 0.3; exit 0'] });
    const agents = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
    if (!agents.LifecycleAgent) throw new Error('agent not registered');
    if (agents.LifecycleAgent.pid !== owner.pid) throw new Error('registered pid mismatch');
    await new Promise((resolve) => owner.onExit(resolve));
  });

  await testAsync('captures stdout to the durable log file with correct schema (FR-1, AD-2)', async () => {
    const owner = startOwner({ dataDir, agentName: 'CaptureAgent', command: 'bash', args: ['-c', 'echo capture-test-marker; exit 0'] });
    await new Promise((resolve) => owner.onExit(resolve));
    const lines = fs.readFileSync(owner.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const dataLine = lines.find((l) => l.data && l.data.includes('capture-test-marker'));
    if (!dataLine) throw new Error('captured output missing marker: ' + JSON.stringify(lines));
    if (!dataLine.ts || !dataLine.agent) throw new Error('log line missing required ts/agent fields');
  });

  await testAsync('appends an agent_exit marker with exit code on completion (FR-8)', async () => {
    const owner = startOwner({ dataDir, agentName: 'ExitMarkerAgent', command: 'bash', args: ['-c', 'exit 5'] });
    const result = await new Promise((resolve) => owner.onExit(resolve));
    if (result.exitCode !== 5) throw new Error('unexpected exitCode: ' + result.exitCode);
    const lines = fs.readFileSync(owner.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const exitLine = lines.find((l) => l.event === 'agent_exit');
    if (!exitLine) throw new Error('no agent_exit marker in log');
    if (exitLine.exitCode !== 5) throw new Error('agent_exit marker exitCode mismatch');
  });

  await testAsync('removes the agent from agents.json on exit (FR-8, AD-6)', async () => {
    const owner = startOwner({ dataDir, agentName: 'CleanupAgent', command: 'bash', args: ['-c', 'exit 0'] });
    let agents = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
    if (!agents.CleanupAgent) throw new Error('agent should be registered before exit');
    await new Promise((resolve) => owner.onExit(resolve));
    agents = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
    if (agents.CleanupAgent) throw new Error('agent still present in agents.json after exit');
  });

  await testAsync('unlinks a pre-existing socket file on exit, without erroring if absent (FR-8, AD-3)', async () => {
    const owner = startOwner({ dataDir, agentName: 'SockAgent', command: 'bash', args: ['-c', 'exit 0'] });
    fs.writeFileSync(owner.socketPath, ''); // simulate Story 1.3 having created the socket
    await new Promise((resolve) => owner.onExit(resolve));
    if (fs.existsSync(owner.socketPath)) throw new Error('socket file was not unlinked on exit');

    // Also verify unlinking is a no-op (never throws) when no socket exists at all.
    const owner2 = startOwner({ dataDir, agentName: 'SockAgent2', command: 'bash', args: ['-c', 'exit 0'] });
    await new Promise((resolve) => owner2.onExit(resolve));
    if (fs.existsSync(owner2.socketPath)) throw new Error('unexpected socket file present');
  });

  await testAsync('respects a custom cwd', async () => {
    const workDir = freshTmpDir();
    const owner = startOwner({ dataDir, agentName: 'CwdAgent', command: 'bash', args: ['-c', 'pwd'], cwd: workDir });
    await new Promise((resolve) => owner.onExit(resolve));
    const lines = fs.readFileSync(owner.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const dataLine = lines.find((l) => l.data);
    if (!dataLine || !dataLine.data.includes(fs.realpathSync(workDir))) {
      throw new Error('cwd was not respected: ' + JSON.stringify(dataLine));
    }
  });

  await testAsync('passes custom env vars through to the spawned process', async () => {
    const owner = startOwner({
      dataDir, agentName: 'EnvAgent', command: 'bash', args: ['-c', 'echo "VAR_IS:$NEOHIVE_TEST_MARKER"'],
      env: { NEOHIVE_TEST_MARKER: 'unique-marker-12345' },
    });
    await new Promise((resolve) => owner.onExit(resolve));
    const lines = fs.readFileSync(owner.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const dataLine = lines.find((l) => l.data && l.data.includes('VAR_IS:'));
    if (!dataLine || !dataLine.data.includes('unique-marker-12345')) throw new Error('env var not passed through');
  });

  await testAsync('redacts secrets in real captured output end-to-end', async () => {
    const owner = startOwner({
      dataDir, agentName: 'RedactAgent', command: 'bash',
      args: ['-c', 'echo "api_key=\\"sk-abcdefghijklmnop1234567890\\""'],
    });
    await new Promise((resolve) => owner.onExit(resolve));
    const raw = fs.readFileSync(owner.logPath, 'utf8');
    if (raw.includes('sk-abcdefghijklmnop1234567890')) throw new Error('secret leaked into the log file');
    if (!raw.includes('[REDACTED]')) throw new Error('expected redaction marker in log');
  });

  await testAsync('log file inherits restrictive permissions (0o600) (AD-7)', async () => {
    const owner = startOwner({ dataDir, agentName: 'PermsAgent', command: 'bash', args: ['-c', 'echo hi; exit 0'] });
    await new Promise((resolve) => owner.onExit(resolve));
    const mode = fs.statSync(owner.logPath).mode & 0o777;
    if (mode & 0o077) throw new Error('log file is group/other accessible: ' + mode.toString(8));
  });

  await testAsync('no PTY fd leak after repeated spawn+exit cycles (NFR-4)', async () => {
    function countOpenFds() {
      try { return fs.readdirSync('/proc/self/fd').length; } catch { return -1; }
    }
    if (countOpenFds() === -1) return; // /proc not available on this platform — skip silently
    const before = countOpenFds();
    for (let i = 0; i < 10; i++) {
      const owner = startOwner({ dataDir, agentName: 'FdCycle' + i, command: 'bash', args: ['-c', 'exit 0'] });
      await new Promise((resolve) => owner.onExit(resolve));
    }
    await new Promise((r) => setTimeout(r, 100));
    const after = countOpenFds();
    if (after - before > 3) throw new Error(`fd leak suspected: before=${before} after=${after}`);
  });

  await testAsync('write()/resize()/kill() are safe no-ops after exit (defensive API surface for Story 1.3)', async () => {
    const owner = startOwner({ dataDir, agentName: 'ApiAgent', command: 'bash', args: ['-c', 'exit 0'] });
    await new Promise((resolve) => owner.onExit(resolve));
    if (!owner.isExited()) throw new Error('isExited() should be true after exit');
    owner.write('should be a no-op');
    owner.resize(100, 40);
    owner.kill();
    // No assertion beyond "did not throw" — these are defensive guards.
  });
}

testLifecycle().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}).catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
