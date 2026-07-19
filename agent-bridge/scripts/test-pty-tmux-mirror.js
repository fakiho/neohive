#!/usr/bin/env node
'use strict';

// Focused tests for Story 1.5: Optional tmux display surface (opt-in).
// Governs FR-9, AD-4. See _bmad-output/planning-artifacts/epics-node-pty-launcher.md.
//
// Requires a real `tmux` binary (used to create/inspect/tear down throwaway
// sessions). Skips tmux-dependent tests gracefully if tmux is unavailable —
// the AD-4 "no tmux dependency" tests still run either way.
//
// Run: node scripts/test-pty-tmux-mirror.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let passed = 0;
let failed = 0;
let skipped = 0;
async function testAsync(name, fn) {
  try { await fn(); console.log('  PASS:', name); passed++; }
  catch (e) {
    if (e && e.__skip__) { console.log('  SKIP:', name, '-', e.message); skipped++; return; }
    console.error('  FAIL:', name); console.error('   ', e.message); failed++;
  }
}
function skip(reason) { const e = new Error(reason); e.__skip__ = true; throw e; }

function hasTmux() {
  try { execFileSync('tmux', ['-V'], { timeout: 3000 }); return true; }
  catch { return false; }
}
const TMUX_AVAILABLE = hasTmux();

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-pty-mirror-'));
}

function freshOwnerModule() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge', 'lib', 'pty-owner')) || k.includes(path.join('agent-bridge', 'lib', 'pty-tmux-mirror'))) delete require.cache[k];
  }
  return require('../lib/pty-owner');
}

function freshMirrorModule() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('agent-bridge', 'lib', 'pty-tmux-mirror'))) delete require.cache[k];
  }
  return require('../lib/pty-tmux-mirror');
}

function killSession(name) {
  try { execFileSync('tmux', ['kill-session', '-t', name], { timeout: 3000 }); } catch { /* already gone */ }
}

async function run() {
  console.log('\n[1] isConfigured() — reads terminal.tmux_session from config.json (AD-4 gate)');
  {
    const mod = freshMirrorModule();
    await testAsync('returns false when config.json is absent', async () => {
      const dir = freshTmpDir();
      if (mod.isConfigured(dir) !== false) throw new Error('expected false');
    });
    await testAsync('returns false when terminal.tmux_session is absent', async () => {
      const dir = freshTmpDir();
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ terminal: {} }));
      if (mod.isConfigured(dir) !== false) throw new Error('expected false');
    });
    await testAsync('returns false for an invalid session name (path traversal guard)', async () => {
      const dir = freshTmpDir();
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ terminal: { tmux_session: '../../etc' } }));
      if (mod.isConfigured(dir) !== false) throw new Error('expected false for unsafe session name');
    });
    await testAsync('returns true for a valid configured session name', async () => {
      const dir = freshTmpDir();
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ terminal: { tmux_session: 'my-session-1' } }));
      if (mod.isConfigured(dir) !== true) throw new Error('expected true');
    });
  }

  console.log('\n[2] startMirror() — disabled path (AD-4: never a hard dependency)');
  {
    await testAsync('write() before/without configuration silently no-ops, never throws', async () => {
      const mod = freshMirrorModule();
      const dir = freshTmpDir(); // no config.json
      const mirror = mod.startMirror({ dataDir: dir, projectDir: dir, agentName: 'Unconfigured' });
      mirror.write('should be dropped\n');
      await new Promise((r) => setTimeout(r, 400));
      if (fs.existsSync(mod.mirrorFilePath(dir, 'Unconfigured'))) throw new Error('mirror file should not have been created');
      mirror.stop(); // must not throw
    });
  }

  console.log('\n[3] startMirror() — active path (requires real tmux)');
  {
    if (!TMUX_AVAILABLE) {
      console.log('  SKIP: tmux not available in this environment — skipping active-mirror tests');
      skipped += 3;
    } else {
      const sessionName = 'neohive-test-mirror-' + Date.now();

      await testAsync('creates the mirror file and a tmux window when configured + tmux available', async () => {
        const mod = freshMirrorModule();
        const dir = freshTmpDir();
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ terminal: { tmux_session: sessionName } }));
        const mirror = mod.startMirror({ dataDir: dir, projectDir: dir, agentName: 'Active1' });
        mirror.write('hello ');
        mirror.write('active mirror\n');
        await new Promise((r) => setTimeout(r, 1200));
        const mirrorPath = mod.mirrorFilePath(dir, 'Active1');
        if (!fs.existsSync(mirrorPath)) throw new Error('mirror file was not created');
        const content = fs.readFileSync(mirrorPath, 'utf8');
        if (content !== 'hello active mirror\n') throw new Error('unexpected mirror content: ' + JSON.stringify(content));
        mirror.stop();
      });

      await testAsync('reuses an existing window rather than creating duplicates on a second mirror for the same agent', async () => {
        const mod = freshMirrorModule();
        const dir = freshTmpDir();
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ terminal: { tmux_session: sessionName } }));
        const m1 = mod.startMirror({ dataDir: dir, projectDir: dir, agentName: 'Reused' });
        await new Promise((r) => setTimeout(r, 800));
        m1.stop();
        const before = execFileSync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_name}']).toString('utf8').trim().split('\n');
        const m2 = mod.startMirror({ dataDir: dir, projectDir: dir, agentName: 'Reused' });
        await new Promise((r) => setTimeout(r, 800));
        m2.stop();
        const after = execFileSync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_name}']).toString('utf8').trim().split('\n');
        const beforeCount = before.filter((w) => w.includes('Reused')).length;
        const afterCount = after.filter((w) => w.includes('Reused')).length;
        if (afterCount > beforeCount) throw new Error(`expected window reuse, got ${beforeCount} -> ${afterCount} windows named *Reused*`);
      });

      await testAsync('buffers writes that occur before setup completes, then flushes them once ready', async () => {
        const mod = freshMirrorModule();
        const dir = freshTmpDir();
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ terminal: { tmux_session: sessionName } }));
        const mirror = mod.startMirror({ dataDir: dir, projectDir: dir, agentName: 'Buffered' });
        // Write immediately — setup (async tmux calls) hasn't completed yet.
        mirror.write('buffered-before-ready\n');
        await new Promise((r) => setTimeout(r, 1200));
        const content = fs.readFileSync(mod.mirrorFilePath(dir, 'Buffered'), 'utf8');
        if (!content.includes('buffered-before-ready')) throw new Error('buffered write was lost: ' + JSON.stringify(content));
        mirror.stop();
      });

      killSession(sessionName);
    }
  }

  console.log('\n[4] lib/pty-owner.js integration — additive, never affects core PTY lifecycle (AD-4)');
  {
    await testAsync('startOwner works identically with no tmux_session configured (core path unaffected)', async () => {
      const { startOwner } = freshOwnerModule();
      const dir = freshTmpDir(); // no config.json
      const owner = startOwner({ dataDir: dir, agentName: 'CoreUnaffected', command: 'bash', args: ['-c', 'echo core-still-works; exit 0'] });
      await new Promise((resolve) => owner.onExit(resolve));
      const lines = fs.readFileSync(owner.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      if (!lines.some((l) => l.data && l.data.includes('core-still-works'))) throw new Error('core log capture broken');
      if (fs.existsSync(owner.mirrorPath)) throw new Error('mirror file should not exist when unconfigured');
    });

    if (!TMUX_AVAILABLE) {
      console.log('  SKIP: tmux not available — skipping active owner+mirror integration test');
      skipped += 1;
    } else {
      const sessionName = 'neohive-test-owner-mirror-' + Date.now();
      await testAsync('startOwner mirrors redacted output to the tmux display file end-to-end (FR-9)', async () => {
        const { startOwner } = freshOwnerModule();
        const dir = freshTmpDir();
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ terminal: { tmux_session: sessionName } }));
        const owner = startOwner({
          dataDir: dir, agentName: 'OwnerMirrorE2E', command: 'bash',
          args: ['-c', 'echo "api_key=\\"sk-abcdefghijklmnop1234567890\\""; echo plain-line; exit 0'],
        });
        await new Promise((resolve) => owner.onExit(resolve));
        await new Promise((r) => setTimeout(r, 500));
        if (!fs.existsSync(owner.mirrorPath)) throw new Error('mirror file was not created');
        const mirrorContent = fs.readFileSync(owner.mirrorPath, 'utf8');
        if (!mirrorContent.includes('plain-line')) throw new Error('mirror missing expected output: ' + JSON.stringify(mirrorContent));
        if (mirrorContent.includes('sk-abcdefghijklmnop1234567890')) throw new Error('SECRET LEAKED into tmux mirror — redaction not applied consistently');
        if (!mirrorContent.includes('[REDACTED]')) throw new Error('expected redaction marker in mirror content');
      });
      killSession(sessionName);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
