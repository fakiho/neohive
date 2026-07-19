'use strict';

// Focused tests for lib/pty-cli-launcher.js (Story 1.2).
// Covers the non-trivial pure logic (env/arg splitting) and availability
// detection. The full owner-spawn + agents.json readiness handshake is
// validated against the real owner in scripts/test-pty-owner.js and manual
// integration; here we keep to deterministic, dependency-free units.

const assert = require('assert');
const path = require('path');
const launcher = require('../lib/pty-cli-launcher');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n[1] splitEnvArgs — separates env pairs from command + args');

test('splits leading KEY=value env pairs from the command', () => {
  const { env, command, args } = launcher.splitEnvArgs([
    'NEOHIVE_DATA_DIR=/data', 'NEOHIVE_PROJECT_ROOT=/proj', '/usr/bin/claude', '--model', 'x', 'hello',
  ]);
  assert.deepStrictEqual(env, { NEOHIVE_DATA_DIR: '/data', NEOHIVE_PROJECT_ROOT: '/proj' });
  assert.strictEqual(command, '/usr/bin/claude');
  assert.deepStrictEqual(args, ['--model', 'x', 'hello']);
});

test('handles a command with no args', () => {
  const { env, command, args } = launcher.splitEnvArgs(['VAR=1', '/bin/gemini']);
  assert.deepStrictEqual(env, { VAR: '1' });
  assert.strictEqual(command, '/bin/gemini');
  assert.deepStrictEqual(args, []);
});

test('handles no env pairs (command first)', () => {
  const { env, command, args } = launcher.splitEnvArgs(['/bin/codex', 'run']);
  assert.deepStrictEqual(env, {});
  assert.strictEqual(command, '/bin/codex');
  assert.deepStrictEqual(args, ['run']);
});

test('does not treat a path-bearing token as an env pair', () => {
  // A token like "/opt/foo=bar/cli" must be the command, not an env pair.
  const { env, command } = launcher.splitEnvArgs(['A=b', '/opt/we=ird/cli', '--flag']);
  assert.deepStrictEqual(env, { A: 'b' });
  assert.strictEqual(command, '/opt/we=ird/cli');
});

test('stops env parsing at the first non KEY=value token', () => {
  // An arg that contains "=" AFTER the command must stay an arg, not an env pair.
  const { env, command, args } = launcher.splitEnvArgs(['X=1', '/bin/cli', '--set', 'k=v']);
  assert.deepStrictEqual(env, { X: '1' });
  assert.strictEqual(command, '/bin/cli');
  assert.deepStrictEqual(args, ['--set', 'k=v']);
});

console.log('\n[2] isPtyAvailable / module surface');

test('exports the expected surface', () => {
  assert.strictEqual(typeof launcher.launchNativeCli, 'function');
  assert.strictEqual(typeof launcher.isPtyAvailable, 'function');
  assert.strictEqual(typeof launcher.splitEnvArgs, 'function');
  assert.ok(launcher.OWNER_SCRIPT.endsWith(path.join('lib', 'pty-owner.js')));
  assert.ok(launcher.CLI_BINS && launcher.CLI_BINS.claude);
});

test('isPtyAvailable returns a boolean', () => {
  assert.strictEqual(typeof launcher.isPtyAvailable(), 'boolean');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
