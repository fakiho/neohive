'use strict';

// Watches a project's _bmad-output/ tree (read-only) and emits one coalesced
// narration event per new/changed BMad artifact. This makes BMad lifecycle
// progress (PRD written, architecture spine produced, story created, ...)
// structurally visible without relying on the agent to self-report it.
//
// API: start(projectRoot, onEvent) -> stops any previous watcher for that
// root and begins watching; onEvent(event) fires (debounced/coalesced) with:
//   { kind: 'bmad_artifact', path, artifactType, phase, projectRoot }
// stop(projectRoot) tears down the watcher for that root (or all, if omitted).

const fs = require('fs');
const path = require('path');
const bmadProvider = require('./bmad-provider');

const DEBOUNCE_MS = 1500;
const MAX_EVENTS_PER_TICK = 10; // cap burst size — never spam the feed

// One watcher context per project root, keyed by resolved path.
const watchers = new Map();

function outputDir(projectRoot) {
  return path.join(projectRoot, '_bmad-output');
}

function isNoise(relativePath) {
  // Ignore .memlog churn and other non-artifact bookkeeping files.
  return /\.memlog$/i.test(relativePath) || /(^|\/)\.[^/]+$/.test(relativePath);
}

function computePhase(artifacts) {
  const has = (kind) => artifacts.some((item) => item.kind === kind);
  if (artifacts.some((item) => item.kind === 'story') || has('architecture')) return 'implementation';
  if (has('prd')) return 'solutioning';
  if (has('brief') || has('research')) return 'planning';
  return 'analysis';
}

function snapshotArtifacts(projectRoot) {
  const map = new Map();
  let artifacts = [];
  try {
    artifacts = bmadProvider.listArtifacts(projectRoot, { hash: false }) || [];
  } catch {
    artifacts = [];
  }
  for (const artifact of artifacts) {
    if (isNoise(artifact.relative_path)) continue;
    map.set(artifact.relative_path, `${artifact.modified_at}:${artifact.size}`);
  }
  return { map, artifacts };
}

function start(projectRoot, onEvent) {
  if (!projectRoot || typeof onEvent !== 'function') return;
  const resolvedRoot = path.resolve(projectRoot);

  // Restarting for an already-watched root is a no-op beyond refreshing the
  // callback — stop the old one first to avoid leaking fs.watch handles.
  stop(resolvedRoot);

  const dir = outputDir(resolvedRoot);
  const ctx = {
    projectRoot: resolvedRoot,
    watcher: null,
    debounceTimer: null,
    known: new Map(),
  };
  watchers.set(resolvedRoot, ctx);

  if (!fs.existsSync(dir)) {
    // No BMad output yet (or non-BMad project) — no-op cleanly, no throw.
    return;
  }

  // Seed the known-artifact snapshot so we only narrate *new* changes from
  // this point forward, not everything already on disk at watcher start.
  try {
    ctx.known = snapshotArtifacts(resolvedRoot).map;
  } catch {
    ctx.known = new Map();
  }

  const scheduleScan = () => {
    if (ctx.debounceTimer) clearTimeout(ctx.debounceTimer);
    ctx.debounceTimer = setTimeout(() => runScan(ctx, onEvent), DEBOUNCE_MS);
  };

  try {
    ctx.watcher = fs.watch(dir, { recursive: true, persistent: false }, () => {
      scheduleScan();
    });
    ctx.watcher.on('error', () => {
      // Platform doesn't support recursive watch, or dir vanished — stop
      // quietly rather than crash the dashboard process.
      try { ctx.watcher.close(); } catch {}
      ctx.watcher = null;
    });
  } catch {
    // fs.watch is unavailable/unsupported for this path — no-op cleanly.
    ctx.watcher = null;
  }
}

function runScan(ctx, onEvent) {
  ctx.debounceTimer = null;
  let snapshot;
  try {
    snapshot = snapshotArtifacts(ctx.projectRoot);
  } catch {
    return;
  }
  const { map: current, artifacts } = snapshot;
  const changed = [];
  for (const [relativePath, signature] of current) {
    if (ctx.known.get(relativePath) !== signature) {
      changed.push(relativePath);
    }
  }
  if (!changed.length) { ctx.known = current; return; }

  const phase = computePhase(artifacts);
  const byPath = new Map(artifacts.map((a) => [a.relative_path, a]));

  // Coalesce: at most one event per changed artifact, and cap the total
  // burst so a mass-write can't flood the message feed.
  const capped = changed.slice(0, MAX_EVENTS_PER_TICK);
  // Mark only the artifacts we actually narrate as known; leave the overflow
  // "unknown" so they re-fire on a follow-up tick instead of being dropped.
  const cappedSet = new Set(capped);
  const prevKnown = ctx.known;
  ctx.known = new Map(current);
  let overflow = false;
  for (const p of changed) {
    if (cappedSet.has(p)) continue;
    overflow = true;
    if (prevKnown.has(p)) ctx.known.set(p, prevKnown.get(p));
    else ctx.known.delete(p);
  }
  // Re-arm a scan so overflow artifacts get narrated even without new fs events.
  if (overflow && !ctx.debounceTimer) {
    ctx.debounceTimer = setTimeout(() => runScan(ctx, onEvent), DEBOUNCE_MS);
  }
  for (const relativePath of capped) {
    const artifact = byPath.get(relativePath);
    if (!artifact) continue;
    try {
      onEvent({
        kind: 'bmad_artifact',
        path: artifact.path, // e.g. "_bmad-output/.../ARCHITECTURE-SPINE.md"
        artifactType: artifact.kind, // prd/architecture/ux/story/... via bmadProvider
        phase,
        projectRoot: ctx.projectRoot,
      });
    } catch {
      // Never let a bad consumer callback take down the watcher.
    }
  }
}

function stop(projectRoot) {
  if (projectRoot === undefined) {
    for (const key of Array.from(watchers.keys())) stop(key);
    return;
  }
  const resolvedRoot = path.resolve(projectRoot);
  const ctx = watchers.get(resolvedRoot);
  if (!ctx) return;
  if (ctx.debounceTimer) clearTimeout(ctx.debounceTimer);
  if (ctx.watcher) { try { ctx.watcher.close(); } catch {} }
  watchers.delete(resolvedRoot);
}

module.exports = { start, stop };
