'use strict';

// Stop a PTY-launched agent's detached owner (+ CLI) before registry purge.
// Detached owners survive "Terminal End" and previously survived DELETE
// /api/agents when only on-disk rows were removed.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * @param {string} dataDir
 * @param {string} agentName
 * @param {object|null} entry - agents.json row (needs pty_owner / pty_owner_pid)
 * @param {object} [opts]
 * @param {number} [opts.graceMs=1500]
 * @param {number} [opts.forceMs=750]
 * @param {(pid:number, signal:string)=>void} [opts.killFn] - injectable for tests
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] - injectable for tests
 * @param {(socketPath:string)=>Promise<boolean>} [opts.requestTerminateFn]
 * @param {(pid:number,agentName:string)=>boolean} [opts.verifyOwnerFn]
 * @returns {{ attempted: boolean, killed: Array<object>, errors: Array<object>, sock_unlinked: boolean }}
 */
async function stopPtyOwnerProcesses(dataDir, agentName, entry, opts = {}) {
  const result = {
    attempted: false, graceful: false, forced: false, stopped: false,
    owner_alive: false, cli_alive: false, killed: [], errors: [], sock_unlinked: false,
  };
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(String(agentName || ''))) {
    result.errors.push({ label: 'invalid-agent-name', error: 'Invalid agent name' });
    return result;
  }
  if (!entry || entry.pty_owner !== true) return result;
  result.attempted = true;

  const graceMs = typeof opts.graceMs === 'number' ? opts.graceMs : 1500;
  const forceMs = typeof opts.forceMs === 'number' ? opts.forceMs : 750;
  const killFn = typeof opts.killFn === 'function' ? opts.killFn : defaultKill;
  const sleepFn = typeof opts.sleepFn === 'function' ? opts.sleepFn : sleep;
  const aliveFn = typeof opts.aliveFn === 'function' ? opts.aliveFn : isProcessAlive;
  const requestTerminateFn = typeof opts.requestTerminateFn === 'function' ? opts.requestTerminateFn : requestTerminate;
  const verifyOwnerFn = typeof opts.verifyOwnerFn === 'function' ? opts.verifyOwnerFn : verifyOwnerIdentity;

  const ownerPid = entry.pty_owner_pid || null;
  const cliPid = entry.cli_pid || (entry.pid && entry.pid !== ownerPid ? entry.pid : null);
  const socketPath = path.join(dataDir, `pty-${agentName}.sock`);

  function tryKill(pid, signal, label) {
    if (!aliveFn(pid)) return;
    try {
      killFn(pid, signal);
      result.killed.push({ pid, signal, label });
    } catch (e) {
      result.errors.push({ pid, signal, label, error: e.message });
    }
  }

  try {
    result.graceful = await requestTerminateFn(socketPath);
  } catch (e) {
    result.errors.push({ label: 'terminate-socket', error: e.message });
  }

  let deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const ownerAlive = ownerPid && aliveFn(ownerPid);
    const cliAlive = cliPid && aliveFn(cliPid);
    if (!ownerAlive && !cliAlive) break;
    await sleepFn(50);
  }

  if ((ownerPid && aliveFn(ownerPid)) || (cliPid && aliveFn(cliPid))) {
    // Never signal a PID from a stale/reused registry entry. The socket path is
    // preferred; signals are only a bounded fallback after identity validation.
    if (ownerPid && verifyOwnerFn(ownerPid, agentName)) {
      tryKill(ownerPid, 'SIGTERM', 'owner');
    } else if (!ownerPid && cliPid) {
      result.errors.push({ pid: cliPid, label: 'identity-check', error: 'PTY owner PID unavailable; refusing to signal CLI directly' });
    } else {
      result.errors.push({ pid: ownerPid, label: 'identity-check', error: 'PTY owner identity could not be verified' });
    }
  }

  deadline = Date.now() + forceMs;
  while (Date.now() < deadline && ((ownerPid && aliveFn(ownerPid)) || (cliPid && aliveFn(cliPid)))) {
    await sleepFn(50);
  }
  if (ownerPid && aliveFn(ownerPid) && verifyOwnerFn(ownerPid, agentName)) {
    result.forced = true;
    tryKill(ownerPid, 'SIGKILL', 'owner');
    const reapDeadline = Date.now() + forceMs;
    while (Date.now() < reapDeadline && ((ownerPid && aliveFn(ownerPid)) || (cliPid && aliveFn(cliPid)))) {
      await sleepFn(25);
    }
  }
  result.owner_alive = !!(ownerPid && aliveFn(ownerPid));
  result.cli_alive = !!(cliPid && aliveFn(cliPid));
  result.stopped = !result.owner_alive && !result.cli_alive;

  try {
    // A failed stop must not make a still-live owner unreachable.
    if (result.stopped && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
      result.sock_unlinked = true;
    }
  } catch (e) {
    result.errors.push({ label: 'unlink-sock', error: e.message });
  }

  return result;
}

function defaultKill(pid, signal) {
  try { process.kill(-pid, signal); }
  catch { process.kill(pid, signal); }
}

function verifyOwnerIdentity(pid, agentName) {
  if (!isProcessAlive(pid)) return false;
  let cmdline = '';
  try {
    if (process.platform === 'linux') {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } else {
      cmdline = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 1000 }).toString();
    }
  } catch {
    return false;
  }
  return cmdline.includes('pty-owner.js') && cmdline.includes(`"agentName":"${agentName}"`);
}

function requestTerminate(socketPath, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(socketPath)) return resolve(false);
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = '';
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(false, new Error('terminate acknowledgement timed out')), timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'terminate' }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) {
        try {
          const frame = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          finish(frame.type === 'terminate_ack');
        } catch {
          finish(false, new Error('invalid terminate acknowledgement'));
        }
      }
    });
    socket.on('error', (error) => finish(false, error));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  isProcessAlive,
  verifyOwnerIdentity,
  requestTerminate,
  stopPtyOwnerProcesses,
};
