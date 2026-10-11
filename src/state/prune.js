/**
 * @file Retention for `state/runs/` (RT7). A run record is a JSON file. Without a limit the folder grows for ever.
 * The newest 10 records always stay as files. Of the rest, a record that is older than `keepDays`, or beyond the newest
 * `maxFiles` records, moves into the compressed monthly archive `state/archive/runs-YYYY-MM.jsonl.gz` and the file is deleted.
 *
 * The archive holds the whole record, so a run is never lost. The dashboard reads a recent run from its file
 * (`state/runs/<id>.json`). An older run is in the archive.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUNS_DIR } from './io.js';
import { rollOldFiles } from './archive.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('state:prune');

/**
 * @param {{ maxFiles?: number, keepDays?: number, now?: Date, runsDir?: string, archiveDir?: string }} [opts]
 *   `runsDir` and `archiveDir` default to the paths of `state/`. A test can point them at a scratch folder.
 * @returns {{ prunedCount: number, prunedIds: string[] }}
 */
export function pruneRuns(opts = {}) {
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const archiveDir = opts.archiveDir ?? join(dirname(runsDir), 'archive');
  const maxFiles = opts.maxFiles ?? 60;
  const keepDays = opts.keepDays ?? 14;
  try {
    const res = rollOldFiles({
      dir: runsDir,
      archiveDir,
      name: 'runs',
      keepDays,
      keepNewest: Math.min(10, maxFiles),
      maxFiles,
      now: opts.now,
      accept: (f) => f.endsWith('.json'),
      read: (path) => JSON.parse(readFileSync(path, 'utf8')),
      dateOf: (run, _file, mtimeMs) => run.createdAt ?? mtimeMs,
      idOf: (run) => String(run.runId),
    });
    const ids = res.files.map((f) => f.replace(/\.json$/, ''));
    if (res.archived > 0) log.info('rolled old run records into the monthly archive', { count: res.archived });
    return { prunedCount: res.archived, prunedIds: ids };
  } catch (err) {
    log.warn('prune: could not roll old run records, so they stay in place', { error: String(err).slice(0, 200) });
    return { prunedCount: 0, prunedIds: [] };
  }
}

export default { pruneRuns };
