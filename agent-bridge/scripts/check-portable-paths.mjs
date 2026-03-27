#!/usr/bin/env node
/**
 * Fail if the repo contains obvious machine-specific absolute paths
 * (macOS home, Linux /home/<user>/, Windows profile).
 * Run from repo root: npm run check-paths (in agent-bridge/)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Avoid spelling "/Users/" as a contiguous literal in this file or the self-scan will match it.
const U = 'Users';
const PATTERNS = [
  { re: new RegExp('/' + U + '/[^/\\s]+'), name: 'macOS home absolute path' },
  { re: /\/home\/[a-z][a-z0-9-]*\//i, name: 'Linux home absolute path' },
  { re: /C:\\Users\\/i, name: 'Windows profile path' },
];

const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.neohive',
  // Local CLI configs (often contain absolute paths; gitignored)
  '.claude', '.codex', '.gemini',
]);

const EXT = /\.(js|mjs|cjs|json|html|md|yml|yaml|toml)$/i;

function walk(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      walk(p, files);
    } else if (EXT.test(ent.name)) {
      if (ent.name === 'check-portable-paths.mjs') continue;
      files.push(p);
    }
  }
  return files;
}

const hits = [];
for (const file of walk(REPO_ROOT)) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const { re, name } of PATTERNS) {
    if (re.test(text)) {
      hits.push({ file, kind: name });
      break;
    }
  }
}

if (hits.length) {
  process.stderr.write('Portable-path check failed — machine-specific paths found:\n');
  for (const h of hits) {
    process.stderr.write(`  ${h.kind}: ${path.relative(REPO_ROOT, h.file)}\n`);
  }
  process.exit(1);
}

process.stdout.write('check-portable-paths: OK (no /Users, /home/<user>, or C:\\\\Users paths in source).\n');
