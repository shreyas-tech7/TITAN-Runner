#!/usr/bin/env node
/**
 * @file Runs the whole push gate in one command, one step at a time (Wave 12, backlog X4).
 *
 *   node scripts/check-all.mjs           static checks, then every test suite
 *   node scripts/check-all.mjs --fast    static checks only
 *   node scripts/check-all.mjs --e2e     also the browser tests (build the dashboard export first)
 *
 * It runs one heavy process at a time and sets the memory limit for each. It stops at the first failure and prints its tail.
 */
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const base = process.env.TITAN_BASE_REF || 'origin/main';
const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=1536' };

/** @type {Array<{ name: string, cmd: string, args: string[], cwd?: string, heavy?: boolean, optional?: boolean }>} */
const steps = [
  { name: 'workflow checks', cmd: 'node', args: ['scripts/check-workflows.mjs'] },
  { name: 'provider catalog', cmd: 'node', args: ['scripts/check-provider-catalog.mjs'] },
  { name: 'worker migrations', cmd: 'node', args: ['scripts/gen-worker-migrations.mjs', '--check'] },
  { name: 'test mode flag', cmd: 'node', args: ['scripts/check-test-mode.mjs'] },
  { name: 'data contract', cmd: 'node', args: ['scripts/export-schemas.mjs', '--check'] },
  { name: 'secret scan of state/', cmd: 'node', args: ['scripts/check-secrets-in-state.mjs'] },
  { name: 'documentation standard', cmd: 'node', args: ['scripts/check-ste.mjs', '--base', base, '--worktree', '--quiet'] },
  { name: 'denylist gate', cmd: 'node', args: ['scripts/check-denylist.mjs', base, 'HEAD'] },
  { name: 'secret scan of the diff', cmd: 'node', args: ['scripts/check-secrets-in-diff.mjs', base, 'HEAD'] },
];

if (!args.has('--fast')) {
  steps.push(
    { name: 'root tests', cmd: 'npm', args: ['test', '--silent'], heavy: true },
    { name: 'worker tests', cmd: 'npm', args: ['run', 'test:worker', '--silent'], heavy: true },
    { name: 'dashboard typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], cwd: 'dashboard', heavy: true },
    { name: 'dashboard tests', cmd: 'npm', args: ['test', '--silent'], cwd: 'dashboard', heavy: true },
  );
}
if (args.has('--e2e')) steps.push({ name: 'browser tests', cmd: 'npm', args: ['run', 'e2e', '--silent'], cwd: 'dashboard', heavy: true });

let failed = false;
for (const step of steps) {
  const started = Date.now();
  const res = spawnSync(step.cmd, step.args, { cwd: step.cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = res.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.name} (${seconds}s)`);
  if (!ok) {
    failed = true;
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
    console.log(out);
    break;
  }
}
if (failed) process.exit(1);
console.log('check-all: every step passed.');
