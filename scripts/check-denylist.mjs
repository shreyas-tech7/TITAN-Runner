#!/usr/bin/env node
/**
 * CI gate: fails if a pull request's diff touches a denylisted path (see
 * `src/denylist.js`). Run by `.github/workflows/ci.yml` on every PR — this
 * is the second, independent backstop behind `src/selfImprove.js` refusing
 * to open such a PR in the first place; this script protects every PR,
 * self-authored or human-authored, not just the ones that went through
 * that code path.
 *
 * Usage: node scripts/check-denylist.mjs <base-ref> <head-ref>
 * In CI, base/head come from the PR event; see ci.yml for the exact git
 * commands used to compute the changed-file list.
 */
import { execFileSync } from 'node:child_process';
import { findDenylistViolations } from '../src/denylist.js';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: check-denylist.mjs <base-ref> <head-ref>');
  process.exit(2);
}

let changed;
try {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
  changed = out.split('\n').map((l) => l.trim()).filter(Boolean);
} catch (err) {
  console.error(`Failed to diff ${base}...${head}: ${err.message}`);
  process.exit(2);
}

const violations = findDenylistViolations(changed);
if (violations.length > 0) {
  console.error('Denylist violation — this PR touches protected paths it must never change:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nThese paths (.github/workflows/, the reviewer gate, the secret-handling code, and ' +
      'the denylist itself) are off-limits to automated self-improvement PRs. If this is a ' +
      'deliberate, human-authored change, it still needs a maintainer to review and merge it ' +
      'directly rather than through the self-improve flow.',
  );
  process.exit(1);
}

console.log(`Denylist check passed — ${changed.length} file(s) changed, none protected.`);
