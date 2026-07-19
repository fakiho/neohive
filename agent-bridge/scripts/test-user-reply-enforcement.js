#!/usr/bin/env node
'use strict';

// Focused tests for: "Fix: Agents answering in CLI instead of Neohive"
//
// Root cause investigated: dashboard-injected messages from the human
// (from: '__user__') were delivered correctly into messages.jsonl (Story 1.2
// queue-first boundary already covers this — see test-story-1-2.js), but the
// listen() tool's next_action guidance did not unambiguously tell the agent
// that a plain-text/terminal reply is invisible to the human and that
// send_message(to="__user__") is required — especially in the batched
// listen(n>1) path, which had no user-reply reminder at all. Combined with a
// WAKE_SIGNAL that didn't warn against replying in the terminal, some agents
// (depending on their own CLI harness/system prompt discipline) would answer
// in the pane instead of calling the tool.
//
// This uses the same static source-contract pattern as test-story-1-3.js,
// since listen()'s next_action logic lives deep inside the MCP
// CallToolRequestSchema handler and isn't independently invocable without a
// full MCP transport.
//
// Run: node scripts/test-user-reply-enforcement.js

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error('  FAIL:', label); failed++; }
}

const packageDir = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(packageDir, 'server.js'), 'utf8');
const tmuxStateSrc = fs.readFileSync(path.join(packageDir, 'lib', 'tmux-agent-state.js'), 'utf8');

console.log('\n[1] WAKE_SIGNAL warns against plain-text pane replies');
{
  const { WAKE_SIGNAL } = require('../lib/tmux-agent-state');
  assert(/listen\(\)/i.test(WAKE_SIGNAL), 'still instructs listen() (AD-2 compat)');
  assert(!WAKE_SIGNAL.includes('${') && !WAKE_SIGNAL.includes('%s'), 'still no template/printf placeholders (AD-2)');
  assert(!WAKE_SIGNAL.includes('WATCHDOG') && !WAKE_SIGNAL.includes('get_work'), 'still no watchdog/get_work leakage (Story 1.3 compat)');
  assert(/not.*(delivered|reply)/i.test(WAKE_SIGNAL), 'warns that a plain-text pane reply is not delivered');
}

console.log('\n[2] Single-message listen() next_action for __user__ messages');
{
  const marker = "msg.from === '__user__'";
  const idx = serverSrc.indexOf(marker);
  assert(idx !== -1, 'listen() single-message handler branches on __user__ sender');
  const window = serverSrc.slice(idx, idx + 1200);
  assert(/send_message\(to="__user__"/.test(window), 'instructs send_message(to="__user__") explicitly');
  assert(/plain terminal|plain-text/i.test(window), 'explicitly warns plain-text/terminal replies are not delivered');
  assert(/MUST call/i.test(window), 'uses directive "MUST call" language, not just a suggestion');
}

console.log('\n[3] Batched listen(n>1) next_action includes the same reminder');
{
  const marker = 'batchHasUserMsg';
  assert(serverSrc.includes(marker), 'batched listen() tracks whether the batch contains a __user__ message');
  const idx = serverSrc.indexOf('const batchNextAction');
  assert(idx !== -1, 'batched listen() computes a dedicated next_action for the batch');
  const window = serverSrc.slice(idx, idx + 800);
  assert(/send_message\(to="__user__"/.test(window), 'batched next_action instructs send_message(to="__user__") when a user message is present');
  assert(/plain terminal|plain-text/i.test(window), 'batched next_action warns plain-text/terminal replies are not delivered');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
