'use strict';

// Shared direct-delivery boundary (AD-1).
//
// Accepts a fully-constructed message record, appends it exactly once to the
// recipient-visible message file and exactly once to history under locks,
// then requests an advisory wake. Queue failure is delivery failure; wake
// failure is not. Callers: send_message (Story 1.1), /api/inject (Story 1.2),
// and watchdog nudges (Story 1.3).

const fs = require('fs');
const { withFileLock: defaultWithFileLock } = require('./file-io');
const { requestAdvisoryWake } = require('./tmux-agent-state');

// Sentinel returned by the fn inside withFileLock to distinguish:
//   WROTE_OK → lock acquired, fn ran, append succeeded
//   null     → withFileLock contention timeout, fn never called (fail closed)
//   (throws) → lock acquired but appendFileSync threw
const WROTE_OK = Symbol('wrote-ok');

// Attempt a locked file append. Returns { ok: true } on confirmed write,
// { ok: false, error } on lock-contention (null return) or thrown exception.
// The _wfl parameter is for deterministic testing only; omit in production.
function lockedAppend(file, line, _wfl) {
  const wfl = _wfl || defaultWithFileLock;
  let r;
  try {
    r = wfl(file, () => {
      fs.appendFileSync(file, line);
      return WROTE_OK;
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // wfl returns null when lock contention prevented fn from running (file-io.js:168-180).
  if (r !== WROTE_OK) return { ok: false, error: 'lock-contention' };
  return { ok: true };
}

// directDeliver — queue-first delivery with advisory wake.
//
// Parameters:
//   msgFile        — absolute path to the recipient-visible message store
//   histFile       — absolute path to the history projection
//   msg            — complete message record (already validated by caller)
//   dataDir        — project-local .neohive/ data directory
//   to             — recipient name (wake target; null/group/channel → no wake)
//   _withFileLock  — optional withFileLock override for deterministic testing
//
// Returns { success: true, messageId, wake? } when both appends succeed.
// Returns { success: false, error } when either append fails (lock-contention,
// exception, or null return from withFileLock — all three are delivery failures).
async function directDeliver({ msgFile, histFile, msg, dataDir, to, _withFileLock }) {
  const line = JSON.stringify(msg) + '\n';

  // Queue write is authoritative — must succeed for delivery to succeed (FR-1, AD-1).
  // lockedAppend detects null return (contention) in addition to thrown exceptions.
  const msgResult = lockedAppend(msgFile, line, _withFileLock);
  if (!msgResult.ok) {
    return { success: false, error: 'queue-write-failed: ' + msgResult.error };
  }

  // History must be written exactly once before wake is evaluated (Story 1.1 AC, AD-1).
  // History lock-contention or exception is also a delivery failure.
  const histResult = lockedAppend(histFile, line, _withFileLock);
  if (!histResult.ok) {
    return { success: false, error: 'hist-write-failed: ' + histResult.error };
  }

  const result = { success: true, messageId: msg.id };

  // Advisory wake: only for direct 1:1 recipients with a mapped, idle pane (FR-6, AD-3).
  // Only reached after both queue and history writes are confirmed (Story 1.1 AC).
  if (to && to !== '__user__' && to !== '__all__' && to !== '__group__') {
    const wakeResult = await requestAdvisoryWake(dataDir, to).catch(() => ({ wake: 'suppressed', reason: 'wake-threw' }));
    result.wake = wakeResult.wake;
    result.wakeReason = wakeResult.reason;
  }

  return result;
}

module.exports = { directDeliver };
