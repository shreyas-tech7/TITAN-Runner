#!/usr/bin/env node
/**
 * @file Check all connector manifests and run the fixture tests (Wave 12, C10).
 *
 * Usage:
 *   npm run connectors:check
 */
import { spawnSync } from 'node:child_process';

const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=1536' };

const steps = [
  { name: 'manifest schema and generated bundle', args: ['scripts/gen-connectors.mjs', '--check'] },
  { name: 'connector fixture tests', args: ['--test', 'worker/test/connectors-fixtures.test.mjs'] },
];

for (const step of steps) {
  const res = spawnSync(process.execPath, step.args, { env, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`connectors:check: failed at ${step.name}.`);
    process.exit(res.status ?? 1);
  }
}

console.log('connectors:check: all manifests and fixtures passed.');
