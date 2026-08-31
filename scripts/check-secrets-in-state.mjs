#!/usr/bin/env node
/**
 * CI gate + pre-commit step: scans every file under `state/` for anything
 * key-shaped, using the exact same pattern list `lib/redact.js` uses to
 * scrub state before it's written. Two independent passes catch the same
 * class of mistake in different places: `scrubForState()` runs inline as
 * the pulse builds each state file (task H), and this script re-checks the
 * files actually on disk before they are committed/pushed, and again in CI
 * on every PR — so a secret that slipped past the inline scrub (a bug in
 * the pulse itself, say) still cannot reach a merged commit silently.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_PATTERNS } from '../src/lib/redact.js';

const STATE_DIR = join(process.cwd(), 'state');

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let findings = 0;
for (const file of walk(STATE_DIR)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      console.error(`Possible secret-shaped string in ${file} (matched ${pattern})`);
      findings += 1;
    }
  }
}

if (findings > 0) {
  console.error(`\n${findings} finding(s) — refusing to let this land in state/. See src/lib/redact.js.`);
  process.exit(1);
}

console.log(`check-secrets-in-state: clean (${walk(STATE_DIR).length} file(s) scanned under state/).`);
