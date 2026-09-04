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
/**
 * Task states that are safe to archive out of `state/tasks.json`. Deliberately
 * narrower than "every terminal state": a `failed` or `blocked` task still has
 * an OPEN issue (only a completed task closes its issue, and the Reviewer Gate
 * leaves a blocked task's issue open), and `issueSync.js` relies on the task id
 * still being present in `tasks.json` to avoid re-importing that same open
 * issue as a brand-new task next pulse. Archiving those would loop them
 * forever. `complete` and `cancelled` have closed issues, so forgetting them
 * is safe — and if a human reopens one, it simply re-enters as a fresh task.
 */
const ARCHIVABLE_TASK_STATUSES = new Set(['complete', 'cancelled']);

/** How many recent terminal tasks to keep in the live queue file by default.
 *  Well above the dashboard's 30-entry history strip, so a default run never
 *  loses anything visible; the cap only bites once the repo has grown a long
 *  tail of finished tasks. */
export const DEFAULT_MAX_TERMINAL_TASKS = 100;

/**
 * Bound `state/tasks.json`: archive the OLDEST archivable terminal tasks
 * (`complete`/`cancelled`) beyond `maxTasks` into a dated digest under
 * `state/digests/` and remove them from the live queue. Pending, running,
 * `pr-open`, `failed`, and `blocked` tasks are never archived.
 *
 * Mirrors `pruneRuns`'s contract: history is compacted, never silently lost —
 * every archived task leaves a one-line summary in the digest before it is
 * removed. `tasksState.tasks` is assumed to be in arrival order (every writer
 * in this repo appends), so "oldest" is the front of the list.
 *
 * @param {{ tasks: Array<object> }} tasksState Mutated in place (archived tasks removed).
 * @param {{ maxTasks?: number, now?: Date, digestsDir?: string }} [opts]
 * @returns {{ archivedCount: number, archivedIds: string[] }}
 */
export function pruneTasks(tasksState, opts = {}) {
  const maxTasks = opts.maxTasks ?? DEFAULT_MAX_TERMINAL_TASKS;
  const now = opts.now ?? new Date();
  const digestsDir = opts.digestsDir ?? DIGESTS_DIR;

  const tasks = Array.isArray(tasksState?.tasks) ? tasksState.tasks : [];
  const archivable = tasks.filter((t) => t && ARCHIVABLE_TASK_STATUSES.has(t.status));
  if (archivable.length <= maxTasks) return { archivedCount: 0, archivedIds: [] };

  const toArchive = archivable.slice(0, archivable.length - maxTasks);
  const archiveIds = new Set(toArchive.map((t) => t.id));
  const archivedIds = [];

  mkdirSync(digestsDir, { recursive: true });
  const digestPath = join(digestsDir, `tasks-${now.toISOString().slice(0, 10)}-archive.md`);
  for (const task of toArchive) {
    try {
      const line =
        `- \`${task.id}\` — ${task.title ?? 'untitled'} — ${task.status}` +
        `${task.completedAt ? ` — completed ${task.completedAt}` : ''}\n`;
      if (!existsSync(digestPath)) {
        appendFileSync(
          digestPath,
          `# Task archive — ${now.toISOString().slice(0, 10)}\n\n` +
            `Older finished tasks pruned from \`state/tasks.json\` on this date, summarized here.\n\n`,
          'utf8',
        );
      }
      appendFileSync(digestPath, line, 'utf8');
      archivedIds.push(task.id);
    } catch (err) {
      log.warn('pruneTasks: failed to archive a task — leaving it in place', { id: task.id, error: String(err) });
      archiveIds.delete(task.id);
    }
  }

  if (archivedIds.length > 0) {
    tasksState.tasks = tasks.filter((t) => !archiveIds.has(t?.id));
  }

  return { archivedCount: archivedIds.length, archivedIds };
}

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
