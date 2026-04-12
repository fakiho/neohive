/**
 * ACP dual-node router — Neohive as ClientSideConnection to a headless ACP worker.
 * Spawns worker subprocess, forwards sessionUpdate + requestPermission to Zed (upstream).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hub = require('./core/hub.js');
const neohiveConfig = require('./lib/config.js');

export function isCwdAllowed(candidate, allowedRoots) {
  if (!allowedRoots || allowedRoots.length === 0) return true;
  const resolved = path.resolve(candidate);
  return allowedRoots.some(
    (root) =>
      resolved === path.resolve(root) ||
      resolved.startsWith(path.resolve(root) + path.sep),
  );
}

export function resolveWorkersConfigPath() {
  return path.join(neohiveConfig.DATA_DIR, 'acp-workers.json');
}

export function loadWorkerDefinition(workerId) {
  if (!workerId || typeof workerId !== 'string') return null;
  const p = resolveWorkersConfigPath();
  if (!fs.existsSync(p)) return null;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  const workers = Array.isArray(j.workers) ? j.workers : [];
  return workers.find((w) => w && w.id === workerId) || null;
}

/** Merge worker env with process.env; only simple ${VAR} whole-value substitution allowed. */
export function expandWorkerEnv(specEnv) {
  const out = { ...process.env };
  for (const [k, v] of Object.entries(specEnv || {})) {
    if (typeof v !== 'string') {
      if (v != null) out[k] = String(v);
      continue;
    }
    if (/\$\{[^}]+\}/.test(v)) {
      const full = v.match(/^\$\{([^}]+)\}$/);
      if (full) {
        const envKey = full[1];
        if (process.env[envKey] === undefined) {
          throw new Error(`Worker env "${k}": missing host environment variable "${envKey}"`);
        }
        out[k] = process.env[envKey];
      } else {
        throw new Error(`Worker env "${k}": unsupported placeholder (use whole value like "\${VAR}" only)`);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function workerHubName(workerId, sessionId) {
  const wid = String(workerId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const sid = String(sessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 11);
  let n = `w${wid}${sid}`;
  if (n.length > 20) n = n.slice(0, 20);
  return n;
}

export class WorkerSession {
  /**
   * @param {object} opts
   * @param {string} opts.command
   * @param {string[]} opts.args
   * @param {string} opts.hubName
   * @param {object} opts.upstreamConn AgentSideConnection to Zed
   * @param {string} opts.upstreamSessionId
   * @param {string} [opts.spawnCwd]
   * @param {NodeJS.ProcessEnv} [opts.spawnEnv]
   */
  constructor({ command, args, hubName, upstreamConn, upstreamSessionId, spawnCwd, spawnEnv }) {
    this.hubName = hubName;
    this.upstreamConn = upstreamConn;
    this.upstreamSessionId = upstreamSessionId;
    this.downstreamSessionId = null;
    this._pollTimeout = null;
    this._stopped = false;
    this._destroyed = false;
    this._polling = false;

    const spawnArgs = Array.isArray(args) ? args : [];
    this._process = spawn(command, spawnArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: spawnCwd || process.cwd(),
      env: spawnEnv || process.env,
      windowsHide: true,
    });

    const input = Writable.toWeb(this._process.stdin);
    const output = Readable.toWeb(this._process.stdout);
    const stream = acp.ndJsonStream(input, output);

    const self = this;
    this.conn = new acp.ClientSideConnection(() => self._makeClientHandler(), stream);

    this._process.on('exit', () => {
      if (!this._stopped && !this._destroyed) {
        try {
          hub.unregister(this.hubName);
        } catch {
          /* best-effort */
        }
      }
    });
  }

  _makeClientHandler() {
    const self = this;
    return {
      async requestPermission(params) {
        try {
          return await self.upstreamConn.requestPermission(params);
        } catch {
          const opts = params?.options || [];
          if (opts.length > 0) {
            return { outcome: { outcome: 'selected', optionId: opts[0].optionId } };
          }
          return { outcome: { outcome: 'cancelled' } };
        }
      },
      async sessionUpdate(params) {
        await self.upstreamConn.sessionUpdate({
          sessionId: self.upstreamSessionId,
          update: params.update,
        });
      },
      async readTextFile(params) {
        try {
          return await self.upstreamConn.readTextFile(params);
        } catch {
          return { content: '' };
        }
      },
      async writeTextFile(params) {
        try {
          return await self.upstreamConn.writeTextFile(params);
        } catch {
          return {};
        }
      },
    };
  }

  async init(sessionCwd) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('worker subprocess spawn timeout')), 10000);
      this._process.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
      this._process.once('spawn', () => {
        clearTimeout(t);
        resolve();
      });
    });

    await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const ns = await this.conn.newSession({ cwd: sessionCwd, mcpServers: [] });
    this.downstreamSessionId = ns.sessionId;

    const reg = hub.register(this.hubName, 'ACP-worker', ['worker', 'acp']);
    if (reg.error) {
      throw new Error(reg.error);
    }
  }

  async prompt(text) {
    return this.conn.prompt({
      sessionId: this.downstreamSessionId,
      prompt: [{ type: 'text', text: text || '' }],
    });
  }

  async cancel() {
    if (this.downstreamSessionId) {
      await this.conn.cancel({ sessionId: this.downstreamSessionId });
    }
  }

  startHubPoll(intervalMs = 2000) {
    const tick = async () => {
      if (this._stopped || this._destroyed) return;
      if (!this._polling) {
        this._polling = true;
        try {
          const result = hub.listen(this.hubName);
          if (!result?.error && result?.message) {
            const m = result.message;
            const line = `[hub message from ${m.from}]: ${m.content}`;
            await this.prompt(line);
          }
        } catch {
          /* ignore poll errors */
        } finally {
          this._polling = false;
        }
      }
      if (!this._stopped && !this._destroyed) {
        this._pollTimeout = setTimeout(tick, intervalMs);
      }
    };
    this._pollTimeout = setTimeout(tick, intervalMs);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stopped = true;
    if (this._pollTimeout) {
      clearTimeout(this._pollTimeout);
      this._pollTimeout = null;
    }
    try {
      hub.unregister(this.hubName);
    } catch {
      /* best-effort */
    }
    try {
      this._process.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

/** @param {string} workerId @param {string} upstreamSessionId */
export function buildWorkerSessionFromConfig(workerId, upstreamSessionId, upstreamConn, options) {
  const def = loadWorkerDefinition(workerId);
  if (!def || typeof def.command !== 'string') {
    return { error: `Unknown worker id "${workerId}" or missing command (see .neohive/acp-workers.json)` };
  }
  let spawnEnv;
  try {
    spawnEnv = expandWorkerEnv(def.env);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const hubName = workerHubName(workerId, upstreamSessionId);
  const args = Array.isArray(def.args) ? def.args : [];
  const ws = new WorkerSession({
    command: def.command,
    args,
    hubName,
    upstreamConn,
    upstreamSessionId,
    spawnCwd: options?.spawnCwd,
    spawnEnv,
  });
  return { workerSession: ws, hubName };
}
