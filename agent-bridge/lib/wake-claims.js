'use strict';

// Recipient-scoped wake claim file for safe coalesced wake delivery (AD-4, AD-5).
//
// Each recipient gets at most one pending wake claim in wake-claims.json.
// Callers: wake module (claim/release) and listen/register lifecycle (clear).
// All mutations are atomic under withFileLock. Readers tolerate absent file.

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./file-io');

const WAKE_CLAIMS_FILENAME = 'wake-claims.json';

function claimsFile(dataDir) {
  return path.join(dataDir, WAKE_CLAIMS_FILENAME);
}

// Returns parsed claims object on success.
// ENOENT (absent file) → {} (no pending claims, safe to initialize).
// Any other error (malformed JSON, permission denied, …) → null (fail closed — NFR-4).
function readClaims(dataDir) {
  try { return JSON.parse(fs.readFileSync(claimsFile(dataDir), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    return null;
  }
}

function writeClaims(dataDir, claims) {
  fs.writeFileSync(claimsFile(dataDir), JSON.stringify(claims, null, 2));
}

// Sentinel: returned by the fn inside withFileLock to distinguish
//   CLAIM_DONE  → lock acquired, fn ran, result updated inside fn
//   null        → withFileLock contention timeout, fn never called (fail closed)
const CLAIM_DONE = Symbol('claim-done');

// Attempt to atomically claim a pending wake slot for recipient.
// sessionToken identifies this agent session (e.g. "${pid}:${registered_at}").
// Returns { claimed: true } or { claimed: false, reason: 'coalesced'|'suppressed' }.
// Fails closed on any uncertainty: malformed file, read error, lock contention.
function claimWake(dataDir, recipient, sessionToken) {
  let result = { claimed: false, reason: 'suppressed' };

  const lockReturn = withFileLock(claimsFile(dataDir), () => {
    const claims = readClaims(dataDir);
    // Fail closed on read error: treat uncertain state as coalesced (NFR-4, AD-4).
    if (claims === null) { result = { claimed: false, reason: 'suppressed' }; return CLAIM_DONE; }
    if (claims[recipient] && claims[recipient].pending) {
      result = { claimed: false, reason: 'coalesced' };
      return CLAIM_DONE;
    }
    claims[recipient] = {
      pending: true,
      session_token: String(sessionToken || ''),
      claimed_at: new Date().toISOString(),
    };
    try { writeClaims(dataDir, claims); result = { claimed: true }; }
    catch { result = { claimed: false, reason: 'suppressed' }; }
    return CLAIM_DONE;
  });

  // withFileLock returns null when lock contention prevented fn from running.
  // result stays at its initial suppressed value — that's correct fail-closed behavior,
  // but make it explicit so the intent is clear.
  if (lockReturn === null) result = { claimed: false, reason: 'suppressed' };

  return result;
}

// Release a claim only when the session token matches (definite send failure).
// Never releases an unrelated session's claim.
function releaseWakeClaim(dataDir, recipient, sessionToken) {
  withFileLock(claimsFile(dataDir), () => {
    const claims = readClaims(dataDir);
    if (!claims || !claims[recipient]) return;
    if (claims[recipient].session_token === String(sessionToken || '')) {
      delete claims[recipient];
      try { writeClaims(dataDir, claims); } catch {}
    }
  });
}

// Clear any pending claim for recipient unconditionally.
// Called from listen() (the ack point, AD-5) and from register() for new sessions.
function clearWakeClaim(dataDir, recipient) {
  withFileLock(claimsFile(dataDir), () => {
    const claims = readClaims(dataDir);
    if (!claims || !claims[recipient]) return;
    delete claims[recipient];
    try { writeClaims(dataDir, claims); } catch {}
  });
}

module.exports = { claimWake, releaseWakeClaim, clearWakeClaim };
