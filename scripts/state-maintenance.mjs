#!/usr/bin/env node
/**
 * @file Runs the daily state maintenance (RT7). See `src/state/maintenance.js`.
 * Usage: node scripts/state-maintenance.mjs [--dir state]
 * Exit code 1 when a state file fails its schema. The workflow still commits the archives first.
 */
import { runMaintenance } from '../src/state/maintenance.js';

const args = process.argv.slice(2);
const i = args.indexOf('--dir');
const stateDir = i >= 0 ? args[i + 1] : 'state';
const { maintenance, problems } = runMaintenance({ stateDir });
console.log(`state-maintenance: ${JSON.stringify(maintenance.archived)} archived, ${maintenance.stateFiles} file(s), ${maintenance.stateBytes} bytes.`);
if (problems.length > 0) {
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
  console.error(`state-maintenance: ${problems.length} problem(s). Run node scripts/check-state.mjs for the list.`);
  process.exit(1);
}
