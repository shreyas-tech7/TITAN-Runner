/**
 * @file Retention for `state/runs/` — capped and pruned so the repo does not
 * grow without bound. When the run count exceeds `maxFiles`, the oldest
 * runs are rolled into that day's dated summary file under
 * `state/digests/` (one compact line each: id, title, state, task count,
 * duration) and the original per-run JSON files are deleted.
 *
 * This is the only thing in this repo that deletes a committed file — and
 * it only ever deletes a run record after folding its summary into a
 * digest, so history is compacted, never silently lost.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, DIGESTS_DIR } from './io.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('state:prune');

/**
 * @param {{ maxFiles?: number, now?: Date, runsDir?: string, digestsDir?: string }} [opts]
 *   `runsDir`/`digestsDir` default to the real, cwd-derived paths from
 *   `state/io.js`; overridable so a test can point this at a scratch
 *   directory without needing to `process.chdir()` (which a module-level
 *   `const` computed at import time — like `RUNS_DIR` itself — would not
 *   observe after the fact anyway).
 * @returns {{ prunedCount: number, prunedIds: string[] }}
 */
export function pruneRuns(opts = {}) {
  const maxFiles = opts.maxFiles ?? 60;
  const now = opts.now ?? new Date();
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const digestsDir = opts.digestsDir ?? DIGESTS_DIR;

  if (!existsSync(runsDir)) return { prunedCount: 0, prunedIds: [] };
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, path: join(runsDir, f), mtime: statSync(join(runsDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime); // oldest first

  if (files.length <= maxFiles) return { prunedCount: 0, prunedIds: [] };

  const toPrune = files.slice(0, files.length - maxFiles);
  const prunedIds = [];
  mkdirSync(digestsDir, { recursive: true });
  const digestPath = join(digestsDir, `${now.toISOString().slice(0, 10)}-rollup.md`);

  for (const entry of toPrune) {
    try {
      const run = JSON.parse(readFileSync(entry.path, 'utf8'));
      const line = `- \`${run.runId ?? entry.file}\` — ${run.taskTitle ?? 'untitled'} — ${run.state ?? 'unknown'} — ${run.tasks?.length ?? 0} subtask(s)${run.durationMs ? ` — ${Math.round(run.durationMs / 1000)}s` : ''}\n`;
      if (!existsSync(digestPath)) {
        appendFileSync(digestPath, `# Run rollup — ${now.toISOString().slice(0, 10)}\n\nOlder runs pruned from \`state/runs/\` on this date, summarized here.\n\n`, 'utf8');
      }
      appendFileSync(digestPath, line, 'utf8');
      unlinkSync(entry.path);
      prunedIds.push(run.runId ?? entry.file);
    } catch (err) {
      log.warn('prune: failed to roll up a run file — leaving it in place', { file: entry.file, error: String(err) });
    }
  }

  return { prunedCount: prunedIds.length, prunedIds };
}

export default { pruneRuns };
