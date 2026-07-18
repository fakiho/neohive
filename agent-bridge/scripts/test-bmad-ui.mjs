import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-bmad-ui-'));
const dataDir = path.join(projectDir, '.neohive');
fs.mkdirSync(path.join(projectDir, '_bmad', '_config'), { recursive: true });
fs.mkdirSync(path.join(projectDir, '_bmad-output', 'planning-artifacts'), { recursive: true });
fs.mkdirSync(path.join(projectDir, '_bmad-output', 'implementation-artifacts'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, '_bmad', '_config', 'manifest.yaml'), 'version: 6.10.0\nmodules:\n  - name: bmm\n    version: 6.10.0\n');
fs.writeFileSync(path.join(projectDir, '_bmad-output', 'planning-artifacts', 'prd.md'), '# PRD\n');
fs.writeFileSync(path.join(projectDir, '_bmad-output', 'planning-artifacts', 'ARCHITECTURE-SPINE.md'), '# Architecture\n');
fs.writeFileSync(path.join(projectDir, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'), 'development_status:\n  login-story: ready-for-dev\n');
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  methodologies: { bmad: { enabled: true, mode: 'full', workflow: 'auto', installed_tools: ['claude'] } },
}));
const port = 33000 + (process.pid % 1000);

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dashboard start timeout')), 10000);
    const inspect = chunk => {
      if (/localhost|listening|dashboard/i.test(String(chunk))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`dashboard exited early (${code})`));
    });
  });
}

const child = spawn(process.execPath, ['dashboard.js'], {
  cwd: packageDir,
  env: { ...process.env, NEOHIVE_PORT: String(port), NEOHIVE_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await waitForServer(child);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.click('.nav-item[data-view="launch"]');
  await page.waitForSelector('#launch-methodology');
  assert.strictEqual(await page.inputValue('#launch-methodology'), 'bmad');
  assert.strictEqual(await page.inputValue('#launch-methodology-mode'), 'full');
  assert.match(await page.textContent('#bmad-lifecycle'), /login story/i);
  assert.match(await page.textContent('#bmad-lifecycle'), /BMad files authoritative/i);
  assert.strictEqual(await page.isDisabled('#launch-runtime option[value="ollama-responder"]'), true);
  assert.match(await page.textContent('#launch-bmad-setup'), /Compatible with BMad Method v6/);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileColumns = await page.$eval('.methodology-grid', element =>
    getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length);
  assert.strictEqual(mobileColumns, 2);
  console.log('BMAD dashboard UI smoke passed');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(projectDir, { recursive: true, force: true });
}
