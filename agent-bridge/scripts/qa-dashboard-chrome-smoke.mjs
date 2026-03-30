#!/usr/bin/env node
/**
 * Chrome/Chromium smoke QA for the Neohive dashboard UI.
 *
 * This is intentionally lightweight (no Playwright test runner): it spins up the
 * dashboard against a temporary fixture `.neohive/` dir and asserts key views render.
 *
 * Run from repo:
 *   cd agent-bridge
 *   npx --yes playwright install chromium
 *   node scripts/qa-dashboard-chrome-smoke.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nh-qa-ui-')), '.neohive');
const PORT = 9890 + Math.floor(Math.random() * 200);

function writeFixture() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Minimal files to satisfy dashboard reads.
  fs.writeFileSync(path.join(DATA_DIR, 'agents.json'), '{}');
  fs.writeFileSync(path.join(DATA_DIR, 'profiles.json'), '{}');
  fs.writeFileSync(path.join(DATA_DIR, 'rules.json'), JSON.stringify([
    {
      id: 'rule_fixture_1',
      text: 'If marking a task done, a review must be approved when a reviewer is online.',
      category: 'workflow',
      priority: 'critical',
      scope_role: null,
      scope_provider: null,
      scope_agent: null,
      created_by: 'Fixture',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      active: true,
    },
  ], null, 2));

  fs.writeFileSync(path.join(DATA_DIR, 'tasks.json'), JSON.stringify([
    {
      id: 'task_fixture_1',
      title: 'QA: Enforcement system smoke',
      description: 'Fixture task to validate dashboard Tasks view renders.',
      status: 'in_progress',
      assignee: 'Victor',
      created_by: 'Fixture',
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      notes: [{ by: 'Fixture', text: 'seeded', at: new Date(Date.now() - 2 * 60_000).toISOString() }],
    },
  ], null, 2));

  const auditLine = JSON.stringify({
    id: 'audit_fixture_1',
    type: 'violation',
    agent: 'AgentX',
    description: 'Blocked: attempted to mark task done without approved review.',
    blocked: true,
    rule_id: 'rule_fixture_1',
    timestamp: new Date(Date.now() - 30_000).toISOString(),
  }) + '\n';
  fs.writeFileSync(path.join(DATA_DIR, 'audit_log.jsonl'), auditLine);

  const now = Date.now();
  const msgLines = [
    { id: 'msg_fixture_1', from: '__system__', to: '__group__', content: '[FIXTURE] Dashboard smoke test data loaded', timestamp: new Date(now - 90_000).toISOString(), system: true },
    { id: 'msg_fixture_2', from: '__user__', to: 'Victor', content: 'Hello from fixture', timestamp: new Date(now - 80_000).toISOString() },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(path.join(DATA_DIR, 'history.jsonl'), msgLines);
  fs.writeFileSync(path.join(DATA_DIR, 'messages.jsonl'), msgLines);
}

async function waitForDashboard(proc) {
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dashboard start timeout\n' + stderr)), 15_000);
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
}

async function main() {
  writeFixture();

  const env = { ...process.env, NEOHIVE_DATA_DIR: DATA_DIR, NEOHIVE_PORT: String(PORT) };
  const proc = spawn('node', ['dashboard.js'], {
    cwd: BRIDGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanup = async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(path.dirname(DATA_DIR), { recursive: true, force: true }); } catch {}
  };

  try {
    await waitForDashboard(proc);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.addInitScript(() => {
      try {
        localStorage.setItem('neohive_activeView', 'messages');
      } catch {}
    });

    // SSE keeps a long-lived connection — do not wait for networkidle
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => typeof switchView === 'function', null, { timeout: 15_000 });

    // Tasks (do not rely on top tabs visibility; use switchView directly)
    await page.evaluate(() => switchView('tasks'));
    await page.waitForSelector('#tasks-area.visible .task-title', { state: 'visible', timeout: 15_000 });
    const tasksText = await page.locator('#tasks-area').innerText();
    if (!tasksText.includes('QA: Enforcement system smoke')) throw new Error('Tasks view did not render fixture task');

    // Policies (rules)
    await page.evaluate(() => switchView('rules'));
    await page.waitForSelector('#rules-area.visible .rule-text', { state: 'visible', timeout: 15_000 });
    const rulesText = await page.locator('#rules-area').innerText();
    if (!rulesText.includes('If marking a task done')) throw new Error('Policies view did not render fixture rule');

    // Audit log
    await page.evaluate(() => switchView('audit-log'));
    await page.waitForSelector('#audit-log-area.visible', { state: 'visible', timeout: 15_000 });
    const auditText = await page.locator('#audit-log-area').innerText();
    if (!auditText.includes('Blocked: attempted to mark task done without approved review.')) {
      throw new Error('Audit Log view did not render fixture audit entry');
    }

    // New messages pill a11y + pluralization
    await page.evaluate(() => {
      if (typeof updateNewMsgPill !== 'function') throw new Error('updateNewMsgPill() not found');
      updateNewMsgPill(1);
    });
    const label1 = await page.locator('#new-msg-label').innerText();
    const aria1 = await page.locator('#scroll-bottom').getAttribute('aria-label');
    if (label1 !== 'new message') throw new Error('Expected singular "new message", got: ' + label1);
    if (!aria1 || !aria1.includes('1 new message')) throw new Error('Expected aria-label to include count (1), got: ' + String(aria1));

    await page.evaluate(() => updateNewMsgPill(2));
    const label2 = await page.locator('#new-msg-label').innerText();
    const aria2 = await page.locator('#scroll-bottom').getAttribute('aria-label');
    if (label2 !== 'new messages') throw new Error('Expected plural "new messages", got: ' + label2);
    if (!aria2 || !aria2.includes('2 new messages')) throw new Error('Expected aria-label to include count (2), got: ' + String(aria2));

    if (errors.length) throw new Error('Page errors: ' + errors.join('; '));

    console.log('OK dashboard smoke (chrome/chromium): tasks, policies, audit-log, new-messages pill');
    await browser.close();
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

