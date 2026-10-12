/**
 * @file Monthly compressed archives for state files that pile up (RT7).
 *
 * The repo is the database, so a file that is never removed makes the repo grow without limit. These helpers move
 * old files into one compressed file for each month: `state/archive/<name>-YYYY-MM.jsonl.gz`. Each line of the file
 * is one record. The archive holds the whole record, so nothing is lost.
 *
 * The output is deterministic: the same records always give the same bytes. A repeat run changes no file, so it adds
 * no commit. A record that is already in the archive (same id) is not added twice.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/** `YYYY-MM` of an ISO date or a timestamp. Returns null for a value that is not a date. */
export function monthOf(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 7);
}

export function archivePath(archiveDir, name, month) {
  return join(archiveDir, `${name}-${month}.jsonl.gz`);
}

/** Read the records of one archive file. A missing file gives an empty list. */
export function readArchive(path) {
  if (!existsSync(path)) return [];
  const text = gunzipSync(readFileSync(path)).toString('utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Merge records into one monthly archive. Records are keyed by `idOf`. A new record replaces an old one with the same id.
 * @param {{ archiveDir: string, name: string, month: string, records: object[], idOf: (r: object) => string, sortKey?: (r: object) => string }} opts
 * @returns {{ path: string, total: number, added: number, changed: boolean }}
 */
export function writeMonthlyArchive(opts) {
  const path = archivePath(opts.archiveDir, opts.name, opts.month);
  const merged = new Map(readArchive(path).map((r) => [opts.idOf(r), r]));
  const before = merged.size;
  for (const r of opts.records) merged.set(opts.idOf(r), r);
  const sortKey = opts.sortKey ?? ((r) => opts.idOf(r));
  const lines = [...merged.values()].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)).map((r) => JSON.stringify(r));
  const bytes = gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), { level: 9 });
  mkdirSync(opts.archiveDir, { recursive: true });
  const same = existsSync(path) && Buffer.compare(readFileSync(path), bytes) === 0;
  if (!same) writeFileSync(path, bytes);
  return { path, total: merged.size, added: merged.size - before, changed: !same };
}

/**
 * Roll the old files of one directory into monthly archives, then delete them.
 * A file whose record cannot be read or dated stays where it is.
 * @param {{
 *   dir: string, archiveDir: string, name: string, keepDays: number, now?: Date,
 *   accept?: (file: string) => boolean,
 *   read: (path: string, file: string) => object|null,
 *   dateOf: (record: object, file: string, mtimeMs: number) => string|number|null,
 *   idOf: (record: object, file: string) => string,
 *   keepNewest?: number, maxFiles?: number,
 * }} opts
 * @returns {{ archived: number, kept: number, files: string[] }}
 */
export function rollOldFiles(opts) {
  const now = opts.now ?? new Date();
  if (!existsSync(opts.dir)) return { archived: 0, kept: 0, files: [] };
  const cutoff = now.getTime() - opts.keepDays * 24 * 3600_000;
  const entries = readdirSync(opts.dir).filter((f) => (opts.accept ? opts.accept(f) : true)).map((file) => {
    const path = join(opts.dir, file);
    const st = statSync(path);
    if (!st.isFile()) return null;
    let record = null;
    try {
      record = opts.read(path, file);
    } catch {
      record = null;
    }
    if (!record) return null;
    const date = opts.dateOf(record, file, st.mtimeMs);
    const ms = typeof date === 'number' ? date : Date.parse(String(date ?? ''));
    return Number.isFinite(ms) ? { file, path, record, ms } : null;
  }).filter(Boolean).sort((a, b) => b.ms - a.ms);

  // The newest `keepNewest` files always stay. Of the rest, a file goes when it is older than the cutoff,
  // or when it is beyond the newest `maxFiles` files.
  const keepNewest = opts.keepNewest ?? 0;
  const maxFiles = opts.maxFiles ?? Infinity;
  const old = entries.filter((e, i) => i >= keepNewest && (e.ms < cutoff || i >= maxFiles));
  const byMonth = new Map();
  for (const e of old) {
    const month = monthOf(e.ms);
    if (!month) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(e);
  }
  const archived = [];
  for (const [month, list] of byMonth) {
    writeMonthlyArchive({ archiveDir: opts.archiveDir, name: opts.name, month, records: list.map((e) => e.record), idOf: (r) => opts.idOf(r, '') });
    for (const e of list) {
      unlinkSync(e.path);
      archived.push(e.file);
    }
  }
  return { archived: archived.length, kept: entries.length - archived.length, files: archived };
}

export default { monthOf, archivePath, readArchive, writeMonthlyArchive, rollOldFiles };
