#!/usr/bin/env node
/**
 * CLI wrapper around src/state/prune.js — runnable locally or in CI (task
 * brief, Track C: "A prune and a verify script, both runnable locally and
 * in CI"). `src/pulse.js` calls the same two functions itself every pulse;
 * this exists for a manual run (e.g. after manually editing `state/runs/`)
 * without waiting for the next scheduled tick.
 *
 * Usage: node scripts/prune-state.mjs [--max-files N]
 */
import { pruneRuns, writeStateIndex } from '../src/state/prune.js';

const args = process.argv.slice(2);
const maxFilesIdx = args.indexOf('--max-files');
const maxFiles = maxFilesIdx >= 0 ? Number.parseInt(args[maxFilesIdx + 1], 10) : 60;

const result = pruneRuns({ maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 60 });
console.log(
  result.prunedCount > 0
    ? `Pruned ${result.prunedCount} run(s) into a digest + archive: ${result.prunedIds.join(', ')}`
    : 'Nothing to prune — state/runs/ is at or under the cap.',
);

const index = writeStateIndex();
console.log(`state/index.json updated — ${index.hotRunCount} hot run(s), ${index.archivedMonths.length} archived month(s).`);
