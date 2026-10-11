/**
 * @file The daily state maintenance (RT7).
 *
 * It does four things, in this order:
 *   1. It rolls old files into the compressed monthly archives in `state/archive/`: run records, event summaries,
 *      digests, and gate review logs. Recent files stay where they are.
 *   2. It validates every file under `state/` against its strict schema (`scripts/check-state.mjs`).
 *   3. It writes `state/maintenance.json` with what it did and how big `state/` is.
 *   4. The workflow commits the result.
 *
 * `maintenance.json` holds a time stamp, so each daily run makes one real commit. GitHub turns off the schedules of
 * a public repo after 60 days with no activity. This commit is the backstop that keeps them on.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkStateDir } from '../../scripts/check-state.mjs';
import { monthOf, rollOldFiles, writeMonthlyArchive } from './archive.js';
import { pruneRuns } from './prune.js';

export const MAINTENANCE_VERSION = 1;

/** Days that a file stays as a file before it moves into a monthly archive. */
export const KEEP_DAYS = Object.freeze({ runs: 14, eventSummaries: 90, digests: 60, reviews: 60 });

function dirStats(dir, root = dir) {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['workspaces', 'quarantine'].includes(entry.name)) continue;
      const sub = dirStats(path, root);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      // The record of the run does not count itself, so a repeat run on the same day changes nothing.
      if (dir === root && entry.name === 'maintenance.json') continue;
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

const dateInName = (file) => (file.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null;

/**
 * Roll the lines of dated jsonl files (gate reviews) into a monthly archive, one record per line.
 * A file goes only when every line is older than the cutoff, so a file that is still growing stays.
 */
function rollReviewFiles({ dir, archiveDir, keepDays, now }) {
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - keepDays * 24 * 3600_000;
  let archived = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const date = dateInName(file);
    if (!date || Date.parse(`${date}T23:59:59Z`) >= cutoff) continue;
    const path = join(dir, file);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (records.length !== lines.length) continue; // a file that cannot be read stays
    const byMonth = new Map();
    for (const r of records) {
      const month = monthOf(r.ts) ?? monthOf(`${date}T00:00:00Z`);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(r);
    }
    for (const [month, list] of byMonth) {
      writeMonthlyArchive({ archiveDir, name: 'reviews', month, records: list, idOf: (r) => `${r.ts}|${r.toolId}|${r.verdict}|${r.layer}`, sortKey: (r) => `${r.ts}|${r.toolId}` });
    }
    unlinkSync(path);
    archived += records.length;
  }
  return archived;
}


/**
 * @param {{ stateDir: string, now?: Date, keepDays?: Partial<typeof KEEP_DAYS>, validate?: boolean }} opts
 * @returns {{ maintenance: object, problems: string[] }}
 */
export function runMaintenance(opts) {
  const now = opts.now ?? new Date();
  const keep = { ...KEEP_DAYS, ...(opts.keepDays ?? {}) };
  const stateDir = opts.stateDir;
  const archiveDir = join(stateDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });

  const archived = {};
  archived.runs = pruneRuns({ runsDir: join(stateDir, 'runs'), archiveDir, keepDays: keep.runs, maxFiles: 60, now }).prunedCount;

  archived.eventSummaries = rollOldFiles({
    dir: join(stateDir, 'events', 'archive'),
    archiveDir, name: 'events-summary', keepDays: keep.eventSummaries, now,
    accept: (f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f),
    read: (path) => JSON.parse(readFileSync(path, 'utf8')),
    dateOf: (rec, file) => `${rec.date ?? dateInName(file)}T00:00:00Z`,
    idOf: (rec) => String(rec.date),
  }).archived;

  archived.digests = rollOldFiles({
    dir: join(stateDir, 'digests'),
    archiveDir, name: 'digests', keepDays: keep.digests, now,
    accept: (f) => f.endsWith('.md') && Boolean(dateInName(f)),
    read: (path, file) => ({ name: file, text: readFileSync(path, 'utf8') }),
    dateOf: (rec, file) => `${dateInName(file)}T00:00:00Z`,
    idOf: (rec) => rec.name,
  }).archived;

  archived.reviews = rollReviewFiles({ dir: join(stateDir, 'reviews'), archiveDir, keepDays: keep.reviews, now });

  const problems = opts.validate === false ? [] : checkStateDir(stateDir).problems;
  const stats = dirStats(stateDir);
  const maintenance = {
    version: MAINTENANCE_VERSION,
    lastRunAt: now.toISOString(),
    archived,
    stateFiles: stats.files,
    stateBytes: stats.bytes,
    validated: problems.length === 0,
    note: problems.length === 0 ? null : `${problems.length} file problem(s). Run node scripts/check-state.mjs.`,
  };
  writeFileSync(join(stateDir, 'maintenance.json'), `${JSON.stringify(maintenance, null, 2)}\n`);
  return { maintenance, problems };
}

export default { runMaintenance, KEEP_DAYS };
