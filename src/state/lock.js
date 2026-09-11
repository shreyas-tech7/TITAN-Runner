/**
 * @file `state/lock.json` — an application-level lock, in addition to (not
 * instead of) `titan-pulse.yml`'s own `concurrency: { group: titan-pulse }`.
 *
 * The workflow-level concurrency group already serializes pulses triggered
 * by that one workflow. This file is defense in depth for the case the
 * brief (Track B) actually names: "overlapping pulses no-op instead of
 * double-running" — e.g. a maintainer runs `npm run pulse` locally against
 * a real checkout while a scheduled pulse is also mid-run, or a future
 * second entrypoint is added that the concurrency group does not cover.
 * Atomic write-to-temp-then-rename, same as every other file under
 * `state/` (`src/state/io.js`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, writeJsonAtomic } from './io.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('state:lock');

export const LOCK_PATH = join(STATE_DIR, 'lock.json');

/** A lock older than this is presumed abandoned (the holder crashed, or the
 *  job hit its own timeout without releasing) and is reclaimable by the
 *  next pulse rather than blocking forever. Comfortably longer than
 *  titan-pulse.yml's own 10-minute job timeout. */
export const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * @param {string} [path] Injectable for tests; defaults to the real state file.
 * @returns {{runId:string, holder:string, acquiredAt:string, expiresAt:string}|null}
 */
export function readLock(path = LOCK_PATH) {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.expiresAt !== 'string') return null;
    return raw;
  } catch (err) {
    log.warn('lock.json unreadable — treating as unlocked', { error: String(err) });
    return null;
  }
}

/**
 * @param {{runId?:string} & object} lock
 * @param {Date} [now]
 * @returns {boolean}
 */
function isExpired(lock, now = new Date()) {
  const expires = Date.parse(lock.expiresAt);
  return !Number.isFinite(expires) || expires <= now.getTime();
}

/**
 * Try to acquire the pulse lock. Fails (returns `{ok:false}`) if a live,
 * unexpired lock held by a different run id is present — the caller's job
 * is to no-op cleanly in that case, not to error the pulse out.
 * @param {{runId: string, holder: string, ttlMs?: number, path?: string, now?: Date}} opts
 * @returns {{ ok: true } | { ok: false, heldBy: object }}
 */
export function acquireLock({ runId, holder, ttlMs = DEFAULT_TTL_MS, path = LOCK_PATH, now = new Date() }) {
  const existing = readLock(path);
  if (existing && existing.runId !== runId && !isExpired(existing, now)) {
    return { ok: false, heldBy: existing };
  }
  if (existing && existing.runId !== null && existing.runId !== runId && isExpired(existing, now)) {
    // existing.runId === null is the ordinary "cleanly released" marker
    // releaseLock() writes — not a stale/abandoned lock, so it doesn't earn
    // this warning.
    log.warn('reclaiming a stale lock', { staleRunId: existing.runId, staleHolder: existing.holder, expiredAt: existing.expiresAt });
  }
  writeJsonAtomic(path, {
    runId,
    holder,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  return { ok: true };
}

/**
 * Release the lock — but only if it's still this run's own lock. A lock
 * that has already been reclaimed by a later run (this run overran its TTL
 * and got treated as stale) must not be clobbered by a late release.
 * @param {string} runId
 * @param {string} [path]
 */
export function releaseLock(runId, path = LOCK_PATH) {
  const existing = readLock(path);
  if (!existing || existing.runId !== runId) return;
  try {
    writeJsonAtomic(path, { runId: null, holder: null, acquiredAt: null, expiresAt: new Date(0).toISOString() });
  } catch (err) {
    log.warn('failed to release lock (harmless — it will expire on its own)', { error: String(err) });
  }
}

export default { acquireLock, releaseLock, readLock, LOCK_PATH, DEFAULT_TTL_MS };
