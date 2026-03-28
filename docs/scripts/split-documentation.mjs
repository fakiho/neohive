#!/usr/bin/env node
/**
 * Historical: this script was used once to create docs/reference/*.md from a monolithic
 * documentation.md. The hub is now short; **edit reference/*.md directly**.
 *
 * If you need to regenerate from a backup of the old monolith, restore it temporarily and
 * restore the previous version of this file from git history (commit before reference split).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docPath = path.join(__dirname, '..', 'documentation.md');
const text = fs.readFileSync(docPath, 'utf8');
const lineCount = text.split('\n').length;

if (lineCount < 400) {
  console.error(
    'docs/documentation.md is the hub file (< 400 lines). Reference lives in docs/reference/*.md — edit those files directly.\n' +
      'To use this splitter again, restore the pre-split monolith from git and restore this script from history.'
  );
  process.exit(1);
}

console.error('Unexpected: hub file looks like a monolith. Aborting to avoid overwriting reference/.');
process.exit(1);
