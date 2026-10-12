#!/usr/bin/env node
/**
 * @file Points git at the repo hooks in `.githooks/` (RT1).
 * Skips quietly in CI and outside a git checkout, so `npm ci` never changes a pipeline.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';

if (process.env.CI || process.env.TITAN_SKIP_HOOKS === '1') {
  process.exit(0);
}
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  process.exit(0);
}
if (!existsSync('.githooks/pre-commit')) process.exit(0);
chmodSync('.githooks/pre-commit', 0o755);
execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
console.log('install-hooks: git now runs .githooks/pre-commit (secret scan of staged changes).');
