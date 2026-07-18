'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const bmad = require('../lib/bmad-provider');
const { findExecutable } = require('../lib/tmux-cli-launcher');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-bmad-real-'));
const dataDir = path.join(projectDir, '.neohive');
fs.mkdirSync(dataDir, { recursive: true });

function runNpx(args) {
  const npx = findExecutable(process.platform === 'win32' ? 'npx.cmd' : 'npx');
  if (!npx) throw new Error('npx is required');
  return execFileSync(npx, args, {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

try {
  runNpx(['--yes', 'bmad-method@^6', 'install', '--yes', '--directory', projectDir, '--action', 'install', '--modules', 'bmm', '--tools', 'claude-code']);
  let status = bmad.inspectProject(projectDir, dataDir, { preflight: false });
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.compatible, true);

  const helpCandidates = [
    path.join(projectDir, '.claude', 'skills', 'bmad-help', 'SKILL.md'),
    path.join(projectDir, '_bmad', 'core', 'skills', 'bmad-help', 'SKILL.md'),
  ];
  assert.ok(helpCandidates.some(file => fs.existsSync(file)), 'bmad-help skill was not installed');

  const sentinel = path.join(projectDir, '_bmad-output', 'neohive-preservation-smoke.md');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, '# preserve me\n');
  runNpx(['--yes', 'bmad-method@^6', 'install', '--yes', '--directory', projectDir, '--action', 'quick-update']);
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), '# preserve me\n');

  status = bmad.inspectProject(projectDir, dataDir, { preflight: false });
  assert.ok(status.workflows.some(item => item.id === 'bmad-quick-dev'));
  assert.ok(status.workflows.some(item => item.id === 'bmad-dev-story'));
  assert.ok(status.workflows.some(item => item.id === 'bmad-code-review'));
  console.log(`Real BMad smoke passed (${status.version || 'v6'}, bmad-help installed, output preserved)`);
} finally {
  fs.rmSync(projectDir, { recursive: true, force: true });
}
