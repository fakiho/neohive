#!/usr/bin/env node
/**
 * E2E: after scrolling up in #messages, a poll that full-re-renders must preserve
 * viewport anchor (data-msg-id + delta), not jump to scrollTop 0.
 *
 * Run from repo: cd agent-bridge && npx --yes playwright install chromium && node scripts/test-message-scroll-anchor.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nh-scroll-')), '.neohive');
const PORT = 9877 + Math.floor(Math.random() * 200);

function writeFixture() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'agents.json'), '{}');
  const lines = [];
  const t0 = Date.now() - 120_000;
  for (let i = 0; i < 35; i++) {
    lines.push(
      JSON.stringify({
        id: `msg-${i}`,
        from: 'AgentA',
        to: 'AgentB',
        content: `Message body ${i} with enough text to grow row height slightly for scroll testing.`,
        timestamp: new Date(t0 + i * 2000).toISOString(),
      })
    );
  }
  fs.writeFileSync(path.join(DATA_DIR, 'history.jsonl'), lines.join('\n') + '\n');
}

function readAnchorFromPage(page) {
  return page.evaluate(() => {
    const el = document.getElementById('messages');
    if (!el) return null;
    const st = el.scrollTop;
    const nodes = el.querySelectorAll('.nh-msg-card[data-msg-id]');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const id = n.getAttribute('data-msg-id');
      if (!id) continue;
      if (n.offsetTop + n.offsetHeight > st + 0.5) {
        return { scrollTop: st, anchorId: id, delta: n.offsetTop - st, scrollHeight: el.scrollHeight };
      }
    }
    return { scrollTop: st, anchorId: null, delta: null, scrollHeight: el.scrollHeight };
  });
}

/** Scroll then read anchor in one CDP round-trip (avoids flaky page-closed between calls). */
function scrollUpAndReadAnchor(page) {
  return page.evaluate(() => {
    const el = document.getElementById('messages');
    if (!el) return null;
    el.scrollTop = Math.max(80, el.scrollHeight * 0.15);
    el.dispatchEvent(new Event('scroll'));
    const st = el.scrollTop;
    const nodes = el.querySelectorAll('.nh-msg-card[data-msg-id]');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const id = n.getAttribute('data-msg-id');
      if (!id) continue;
      if (n.offsetTop + n.offsetHeight > st + 0.5) {
        return { scrollTop: st, anchorId: id, delta: n.offsetTop - st, scrollHeight: el.scrollHeight };
      }
    }
    return { scrollTop: st, anchorId: null, delta: null, scrollHeight: el.scrollHeight };
  });
}

async function main() {
  writeFixture();

  const env = { ...process.env, NEOHIVE_DATA_DIR: DATA_DIR, NEOHIVE_PORT: String(PORT) };
  const proc = spawn('node', ['dashboard.js'], {
    cwd: BRIDGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += c.toString();
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dashboard start timeout')), 15000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('Dashboard:')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error('dashboard exited ' + code + '\n' + stderr));
    });
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('neohive_activeView', 'messages');
    } catch {}
  });

  try {
    // SSE keeps a long-lived connection — do not wait for networkidle
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('#messages .nh-msg-card[data-msg-id]', { state: 'visible', timeout: 15_000 });

    const before = await scrollUpAndReadAnchor(page);
    if (!before || !before.anchorId) {
      throw new Error('No anchor found after scroll (missing data-msg-id on cards?) ' + JSON.stringify(before));
    }

    const respWait = page.waitForResponse(
      (r) => r.url().includes('/api/history') && r.request().method() === 'GET',
      { timeout: 15_000 }
    );
    await page.evaluate(() => {
      if (typeof poll !== 'function') throw new Error('poll() not on window');
      poll();
    });
    await respWait;

    await new Promise((r) => setTimeout(r, 400));

    const after = await readAnchorFromPage(page);
    const deltaDiff =
      before.anchorId === after.anchorId && before.delta != null && after.delta != null
        ? Math.abs(after.delta - before.delta)
        : Infinity;

    if (after.scrollTop < 5 && before.scrollTop > 40) {
      throw new Error(
        `Scroll jumped toward top: before.scrollTop=${before.scrollTop} after.scrollTop=${after.scrollTop}`
      );
    }

    if (before.anchorId !== after.anchorId) {
      throw new Error(
        `Anchor message changed: before=${before.anchorId} after=${after.anchorId} after.scrollTop=${after.scrollTop}`
      );
    }

    if (deltaDiff > 8) {
      throw new Error(
        `Anchor delta drift too large: before.delta=${before.delta} after.delta=${after.delta} (diff ${deltaDiff})`
      );
    }

    if (errors.length) {
      throw new Error('Page errors: ' + errors.join('; '));
    }

    console.log('OK message scroll anchor: poll + full re-render preserved anchor', {
      anchorId: before.anchorId,
      scrollTopBefore: before.scrollTop,
      scrollTopAfter: after.scrollTop,
      deltaBefore: before.delta,
      deltaAfter: after.delta,
    });
  } finally {
    await browser.close();
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(path.dirname(DATA_DIR), { recursive: true, force: true });
    } catch {}
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
