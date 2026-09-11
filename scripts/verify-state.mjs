#!/usr/bin/env node
/**
 * CI gate + local script: validates every `state/runs/*.json` against the
 * shared contract (`src/state/contract.js`, `docs/CONTRACT.md`) and checks
 * the repo's on-disk size against the task brief's budget (Track C: "warn
 * in CI above 50 MB, fail above 100 MB"). Run this after
 * `scripts/check-secrets-in-state.mjs`, not instead of it — this checks
 * shape and size, that script checks for secrets.
 *
 * Usage: node scripts/verify-state.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunEnvelope } from '../src/state/contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RUNS_DIR = join(ROOT, 'state', 'runs');

const WARN_BYTES = 50 * 1024 * 1024;
const FAIL_BYTES = 100 * 1024 * 1024;

/** Directories excluded from the size budget — build/dependency output,
 *  never part of what actually gets committed. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.next', 'out']);

function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        // A file removed between readdir and stat (rare, harmless) — skip it.
      }
    }
  }
  return total;
}

function humanMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

let exitCode = 0;
const problems = [];

// 1. Contract validation of every run record.
let checked = 0;
let entries = [];
try {
  entries = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
} catch {
  entries = [];
}
for (const file of entries) {
  const path = join(RUNS_DIR, file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push(`${file}: not valid JSON (${err.message})`);
    exitCode = 1;
    continue;
  }
  if (parsed && typeof parsed === 'object' && parsed.contractVersion === undefined) {
    // Pre-dates the contract (every run record written before this change) —
    // not something to silently rewrite history for, and not a failure:
    // warn once so it's visible, then move on. A record that HAS a
    // contractVersion but the wrong major is a real problem and still fails
    // below, per validateRunEnvelope().
    console.warn(`::warning::${file}: no contractVersion — pre-dates the state contract, not re-validated`);
    continue;
  }
  checked += 1;
  const { ok, errors } = validateRunEnvelope(parsed);
  if (!ok) {
    exitCode = 1;
    for (const e of errors) problems.push(`${file}: ${e}`);
  }
}

if (problems.length > 0) {
  console.error(`state contract: ${problems.length} problem(s) across ${checked} run record(s):`);
  for (const p of problems) console.error(`  - ${p}`);
} else {
  console.log(`state contract: ${checked} run record(s) under state/runs/ all conform (contractVersion ${checked > 0 ? 'ok' : 'n/a — none to check'}).`);
}

// 2. Repo size budget.
const totalBytes = dirSizeBytes(ROOT);
const stateBytes = dirSizeBytes(join(ROOT, 'state'));
console.log(`repo size (excluding .git/node_modules/build output): ${humanMb(totalBytes)} (state/: ${humanMb(stateBytes)})`);
if (totalBytes > FAIL_BYTES) {
  console.error(`repo size ${humanMb(totalBytes)} exceeds the 100 MB fail budget.`);
  exitCode = 1;
} else if (totalBytes > WARN_BYTES) {
  console.warn(`::warning::repo size ${humanMb(totalBytes)} exceeds the 50 MB warn budget (fails at 100 MB).`);
}

process.exit(exitCode);
