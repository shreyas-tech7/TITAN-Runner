#!/usr/bin/env node
/**
 * Coverage gate (task brief, Track F: "Coverage gate that fails on a drop
 * from the new baseline"). Runs `node --test --experimental-test-coverage`
 * (Node's own built-in coverage — no new dependency, consistent with
 * docs/DECISIONS.md D-2's zero-dependency stance), parses the "all files"
 * line-coverage percentage out of its report, and compares it against
 * `coverage-baseline.json` at the repo root.
 *
 * A drop of more than COVERAGE_TOLERANCE_POINTS percentage points below the
 * committed baseline fails the job. The baseline is never auto-raised by a
 * passing run — that would let coverage silently ratchet in either
 * direction without a human choosing to. Run with `--update-baseline` to
 * intentionally record a new baseline (e.g. after adding real new code with
 * its own tests that changes the overall percentage).
 *
 * Usage: node scripts/check-coverage.mjs [--update-baseline]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BASELINE_PATH = join(ROOT, 'coverage-baseline.json');
const COVERAGE_TOLERANCE_POINTS = 1.0;

const updateBaseline = process.argv.includes('--update-baseline');

const run = spawnSync(process.execPath, ['--test', '--experimental-test-coverage'], {
  cwd: ROOT,
  encoding: 'utf8',
});

if (run.error) {
  console.error(`Failed to run the test suite for coverage: ${run.error.message}`);
  process.exit(1);
}

const output = `${run.stdout}\n${run.stderr}`;
const match = output.match(/^#?\s*all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/m);

if (!match) {
  console.error('Could not find an "all files" coverage line in the test runner output — printing it for debugging:');
  console.error(output);
  process.exit(1);
}

const [, lineCoverage, branchCoverage, funcCoverage] = match.map((s, i) => (i === 0 ? s : Number.parseFloat(s)));
console.log(`Coverage — lines: ${lineCoverage}%, branches: ${branchCoverage}%, functions: ${funcCoverage}%`);

if (updateBaseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ lineCoverage, branchCoverage, funcCoverage, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Baseline updated: coverage-baseline.json now records ${lineCoverage}% line coverage.`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ lineCoverage, branchCoverage, funcCoverage, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`No coverage-baseline.json existed — recorded this run (${lineCoverage}% lines) as the new baseline.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const drop = baseline.lineCoverage - lineCoverage;

if (drop > COVERAGE_TOLERANCE_POINTS) {
  console.error(
    `Line coverage dropped ${drop.toFixed(2)} points below the committed baseline ` +
      `(${baseline.lineCoverage}% -> ${lineCoverage}%, tolerance ${COVERAGE_TOLERANCE_POINTS} point(s)). ` +
      `Add tests for the new/changed code, or run with --update-baseline if this drop is deliberate and reviewed.`,
  );
  process.exit(1);
}

console.log(`Coverage OK — ${lineCoverage}% lines vs baseline ${baseline.lineCoverage}% (tolerance ${COVERAGE_TOLERANCE_POINTS} point(s)).`);
