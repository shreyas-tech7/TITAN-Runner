/**
 * @file Reviewer Gate verdict persistence — one JSONL file per calendar day
 * under `state/reviews/`, committed by the pulse like every other state
 * file. Simplified from TITAN's original `backend/lib/reviewer/store.js`:
 * that version shared a generic day-sharded-store module with a triage
 * queue this repo doesn't have, so the (small) sharding logic is inlined
 * here instead of carrying a shared abstraction for a single caller.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

export const REVIEWS_DIR = join(process.cwd(), 'state', 'reviews');
const FILE_PREFIX = 'reviews-';

function dayStamp(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {Record<string, unknown>} row
 * @param {{ dir?: string, maxFiles?: number, now?: Date }} [opts]
 */
export function appendReview(row, opts = {}) {
  const dir = opts.dir ?? REVIEWS_DIR;
  const maxFiles = opts.maxFiles ?? config.retention.maxReviewLines > 0 ? 30 : 30;
  const now = opts.now ?? new Date();

  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${FILE_PREFIX}${dayStamp(now)}.jsonl`);
    appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
    pruneOldFiles(dir, maxFiles);
  } catch {
    // Persistence is best-effort — a write failure must never break the
    // reviewer's verdict, only its audit trail.
  }
}

function pruneOldFiles(dir, maxFiles) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX)).sort();
  while (files.length > maxFiles) {
    const oldest = files.shift();
    try {
      unlinkSync(join(dir, oldest));
    } catch {
      break;
    }
  }
}

/** @param {string} [dir] @returns {string[]} */
export function listReviewFiles(dir = REVIEWS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(FILE_PREFIX)).sort();
}

export default { appendReview, listReviewFiles, REVIEWS_DIR };
