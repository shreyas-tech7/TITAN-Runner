#!/usr/bin/env node
/**
 * CI gate: the second, independent backstop behind `src/selfImprove.js`
 * refusing to open a PR that touches a denylisted path (`src/denylist.js`).
 * Run by `.github/workflows/ci.yml` on every pull request.
 *
 * Two modes, decided by who opened the PR (both values arrive through env,
 * never interpolated into a shell):
 *
 *   - The bot's own PR (`TITAN_PR_HEAD_REF` starts with `self-improve/`, or
 *     `TITAN_PR_AUTHOR` is `github-actions[bot]`): any denylisted path is a
 *     hard failure. This is the case the gate exists for — the in-code
 *     denylist check was bypassed or is buggy.
 *   - A human's PR: the same paths are reported as `::warning::` annotations
 *     on the check and the step passes. Before this distinction existed the
 *     step was red on every human PR that touched a workflow, and those PRs
 *     were merged over the red check (#9, #12), which teaches everyone to
 *     ignore CI — see docs/runner-upgrade/DECISIONS.md D-5. The rule the
 *     annotation states still holds: a maintainer reviews these paths by hand.
 *
 * Usage: node scripts/check-denylist.mjs <base-ref> <head-ref>
 *        (refs may also come from TITAN_BASE_REF / TITAN_HEAD_REF)
 */
import { execFileSync } from 'node:child_process';
import { findDenylistViolations } from '../src/denylist.js';

const base = process.argv[2] ?? process.env.TITAN_BASE_REF;
const head = process.argv[3] ?? process.env.TITAN_HEAD_REF;
if (!base || !head) {
  console.error('Usage: check-denylist.mjs <base-ref> <head-ref>');
  process.exit(2);
}

const headRef = process.env.TITAN_PR_HEAD_REF ?? '';
const author = (process.env.TITAN_PR_AUTHOR ?? '').toLowerCase();
const isBotPr = headRef.startsWith('self-improve/') || author === 'github-actions[bot]';

let changed;
try {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
  changed = out.split('\n').map((l) => l.trim()).filter(Boolean);
} catch (err) {
  console.error(`Failed to diff ${base}...${head}: ${err.message}`);
  process.exit(2);
}

const violations = findDenylistViolations(changed);
if (violations.length === 0) {
  console.log(`Denylist check passed — ${changed.length} file(s) changed, none protected.`);
  process.exit(0);
}

if (isBotPr) {
  console.error('Denylist violation — an automated self-improvement PR touches protected paths it must never change:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error('\nsrc/selfImprove.js should have refused this before opening the PR; this gate is the backstop. Closing.');
  process.exit(1);
}

for (const v of violations) {
  console.log(`::warning file=${v}::Protected path changed by a human-authored PR — review by hand (the self-improve flow may never touch this).`);
}
console.log(`Denylist check: ${violations.length} protected path(s) touched by a human-authored PR (annotated, not failed): ${violations.join(', ')}`);
