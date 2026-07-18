'use strict';
// Focused test for the read-only Files browser endpoints:
// GET /api/files and GET /api/file. Verifies discovery under
// _bmad-output/ and .neohive/artifacts/, content retrieval, and that
// path traversal outside the project root is rejected.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const packageDir = path.resolve(__dirname, '..');
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-files-api-'));
const dataDir = path.join(projectDir, '.neohive');
fs.mkdirSync(dataDir, { recursive: true });
const port = 34000 + (process.pid % 1000);

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Dashboard did not start')), 10000);
    const inspect = (chunk) => {
      const output = String(chunk || '');
      if (/listening|localhost|dashboard/i.test(output)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dashboard exited early (${code})`));
    });
  });
}

async function get(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const body = await response.json();
  return { status: response.status, body };
}

let passed = 0;
let failed = 0;
function assertOk(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

async function run() {
  const child = spawn(process.execPath, ['dashboard.js'], {
    cwd: packageDir,
    env: Object.assign({}, process.env, {
      NEOHIVE_PORT: String(port),
      NEOHIVE_DATA_DIR: dataDir,
      NEOHIVE_PROJECT_ROOT: projectDir,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);

    // Seed one file under _bmad-output and one under .neohive/artifacts
    const bmadOutputDir = path.join(projectDir, '_bmad-output');
    fs.mkdirSync(bmadOutputDir, { recursive: true });
    fs.writeFileSync(path.join(bmadOutputDir, 'prd.md'), '# PRD\nHello from bmad-output.\n');

    const artifactsDir = path.join(dataDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'notes.txt'), 'artifact notes content');

    // --- (a) /api/files lists both seeded files ---
    console.log('\n--- Scenario a: file listing ---');
    const listing = await get('/api/files');
    assertOk(listing.status === 200, '/api/files returns 200');
    const paths = (listing.body.files || []).map((f) => f.path);
    assertOk(paths.includes('_bmad-output/prd.md'), 'lists file under _bmad-output/');
    assertOk(paths.includes('.neohive/artifacts/notes.txt'), 'lists file under .neohive/artifacts/');

    // --- (b) /api/file returns seeded content for an in-project path ---
    console.log('\n--- Scenario b: file content retrieval ---');
    const prd = await get('/api/file?path=' + encodeURIComponent('_bmad-output/prd.md'));
    assertOk(prd.status === 200, '/api/file returns 200 for valid in-project path');
    assertOk(prd.body.content === '# PRD\nHello from bmad-output.\n', 'returns exact seeded content');

    // --- (c) /api/file rejects traversal attempts ---
    console.log('\n--- Scenario c: path traversal rejected ---');
    const traversal = await get('/api/file?path=' + encodeURIComponent('../../../../etc/passwd'));
    assertOk(traversal.status >= 400 && traversal.status < 500, 'traversal attempt returns a 4xx status');
    assertOk(!traversal.body.content, 'traversal attempt returns no file content');

    const traversal2 = await get('/api/file?path=' + encodeURIComponent('/etc/passwd'));
    assertOk(traversal2.status >= 400 && traversal2.status < 500, 'absolute path escape returns a 4xx status');
    assertOk(!traversal2.body.content, 'absolute path escape returns no file content');

    // --- (d) symlink escape rejected (review finding: realpath check) ---
    console.log('\n--- Scenario d: symlink escape rejected ---');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-outside-'));
    const outsideSecret = path.join(outsideDir, 'outside-secret.txt');
    fs.writeFileSync(outsideSecret, 'SECRET OUTSIDE ROOT');
    fs.symlinkSync(outsideSecret, path.join(bmadOutputDir, 'leak.txt'));
    const symlink = await get('/api/file?path=' + encodeURIComponent('_bmad-output/leak.txt'));
    assertOk(symlink.status >= 400 && symlink.status < 500, 'symlink pointing outside root returns a 4xx status');
    assertOk(!symlink.body.content || symlink.body.content.indexOf('SECRET') === -1, 'symlink escape returns no leaked content');
  } finally {
    child.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error('Test run failed:', error);
  process.exitCode = 1;
});
