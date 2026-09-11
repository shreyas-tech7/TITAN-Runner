/**
 * @file `state/archive/YYYY-MM.ndjson.gz` — the full JSON of every pruned
 * run record, one per line, gzipped by month (task brief, Track C
 * compaction). Additive alongside the existing `state/digests/*.md`
 * human-readable rollup `src/state/prune.js` already wrote before this
 * change — the digest stays the fast, readable summary; this is the
 * lossless archive a maintainer (or the private TITAN repo, per the shared
 * contract) could actually parse back out.
 *
 * gzip has no cheap streaming-append primitive worth reaching for at this
 * repo's scale (a handful of pruned runs per week at most) — each write
 * decompresses the existing month file (if any), appends the new line(s),
 * and re-gzips the whole thing. Fine here; would not be at real volume.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { STATE_DIR } from './io.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('state:archive');

export const ARCHIVE_DIR = join(STATE_DIR, 'archive');

/** @param {string} isoDate @returns {string} "YYYY-MM" */
function monthOf(isoDate) {
  const parsed = typeof isoDate === 'string' ? isoDate.slice(0, 7) : '';
  return /^\d{4}-\d{2}$/.test(parsed) ? parsed : new Date().toISOString().slice(0, 7);
}

/**
 * Append one run record's full JSON as an ndjson line into its month's
 * gzip archive.
 * @param {object} record A full run record (same shape as state/runs/*.json).
 * @param {{ archiveDir?: string }} [opts] Injectable for tests.
 */
export function archiveRun(record, opts = {}) {
  const archiveDir = opts.archiveDir ?? ARCHIVE_DIR;
  mkdirSync(archiveDir, { recursive: true });
  const month = monthOf(record.createdAt ?? record.updatedAt ?? '');
  const path = join(archiveDir, `${month}.ndjson.gz`);

  let existingLines = '';
  if (existsSync(path)) {
    try {
      existingLines = gunzipSync(readFileSync(path)).toString('utf8');
    } catch (err) {
      log.warn('archive month file unreadable — starting a fresh one for this month (existing bytes left on disk under a .bak suffix would be overkill here; this is a compaction artifact, not the source of truth)', {
        path, error: String(err),
      });
      existingLines = '';
    }
  }
  const line = `${JSON.stringify(record)}\n`;
  writeFileSync(path, gzipSync(existingLines + line));
}

/**
 * @param {{ archiveDir?: string }} [opts]
 * @returns {string[]} Month keys ("YYYY-MM") with an archive file, sorted ascending.
 */
export function listArchivedMonths(opts = {}) {
  const archiveDir = opts.archiveDir ?? ARCHIVE_DIR;
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir)
    .filter((f) => f.endsWith('.ndjson.gz'))
    .map((f) => f.replace(/\.ndjson\.gz$/, ''))
    .sort();
}

/**
 * Read every record back out of one month's archive (e.g. for the RUNBOOK's
 * "restore from archive" procedure, or a local audit).
 * @param {string} month "YYYY-MM"
 * @param {{ archiveDir?: string }} [opts]
 * @returns {object[]}
 */
export function readArchiveMonth(month, opts = {}) {
  const archiveDir = opts.archiveDir ?? ARCHIVE_DIR;
  const path = join(archiveDir, `${month}.ndjson.gz`);
  if (!existsSync(path)) return [];
  const text = gunzipSync(readFileSync(path)).toString('utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export default { archiveRun, listArchivedMonths, readArchiveMonth, ARCHIVE_DIR };
