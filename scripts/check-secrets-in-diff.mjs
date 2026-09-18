#!/usr/bin/env node
/**
 * CI gate: scans the ADDED lines of a diff for anything key-shaped, using
 * the same pattern list `src/lib/redact.js` scrubs with. `check-secrets-in-
 * state.mjs` covers what the pulse writes; this covers what a human or the
 * self-improve flow commits as code, docs, or fixtures.
 *
 * Usage: node scripts/check-secrets-in-diff.mjs <base-ref> <head-ref>
 *        node scripts/check-secrets-in-diff.mjs --staged
 *
 * Deliberate exclusions, each a place that must contain key-shaped strings:
 *   - src/lib/redact.js and scripts/check-secrets-*.mjs (the patterns themselves)
 *   - test/ and bench/ (canary secrets that prove redaction works — every
 *     canary is built by string concatenation in source so the literal never
 *     appears, but the exclusion keeps the gate from arguing with the tests)
 *   - package-lock.json integrity hashes (sha512 base64 runs)
 */
import { execFileSync } from 'node:child_process';
import { SECRET_PATTERNS } from '../src/lib/redact.js';

const EXCLUDED_PATHS = [/^src\/lib\/redact\.js$/, /^scripts\/check-secrets-in-(diff|state)\.mjs$/, /^test\//, /^bench\//, /package-lock\.json$/];
// The generic base64/hex catch-alls (the last two patterns) fire on every
// lockfile hash and SHA-pinned action; a real key of an unknown provider
// still trips the issuer-specific and header/URL patterns above them.
const DIFF_PATTERNS = SECRET_PATTERNS.slice(0, -2);

const args = process.argv.slice(2);
let diff;
try {
  diff = args[0] === '--staged'
    ? execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : execFileSync('git', ['diff', '-U0', '--no-color', `${args[0]}...${args[1]}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  console.error(`check-secrets-in-diff: cannot compute the diff: ${err.message}`);
  process.exit(2);
}

let file = null;
let findings = 0;
let scanned = 0;
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ ')) {
    file = line.replace(/^\+\+\+ b\//, '');
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (!file || EXCLUDED_PATHS.some((re) => re.test(file))) continue;
  scanned += 1;
  for (const pattern of DIFF_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      findings += 1;
      console.error(`Possible secret-shaped string added in ${file} (matched ${pattern})`);
      break;
    }
  }
}

if (findings > 0) {
  console.error(`\n${findings} finding(s) in added lines — refusing. Rotate the credential; a push is a publication.`);
  process.exit(1);
}
console.log(`check-secrets-in-diff: clean (${scanned} added line(s) scanned).`);
