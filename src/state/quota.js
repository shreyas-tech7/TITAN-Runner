/**
 * @file `state/quota.json` — per-provider daily call ledger, checked before
 * a pulse burns a retry on a provider that is almost certainly about to
 * hit its free-tier daily cap. This is deliberately separate from
 * `src/providers/health.js`'s cooldown/circuit-breaker (which reacts to a
 * REAL 429/402 the provider already returned) — a ledger is a proactive
 * "don't even try" check based on a count this process has itself kept,
 * so a provider can be skipped before it ever answers with a rate-limit
 * error at all.
 *
 * See docs/DECISIONS.md D-3 for why the limits below are conservative,
 * documented estimates rather than scraped live values — no provider
 * exposes its free-tier daily cap through a stable, documented API.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, writeJsonAtomic } from './io.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('state:quota');

export const QUOTA_PATH = join(STATE_DIR, 'quota.json');

/**
 * Conservative daily request-count floors, one provider a pulse could
 * plausibly exhaust in a single day of retries. Deliberately on the low
 * side of each provider's own published free-tier page as of this build —
 * an early, wrong skip costs nothing (the next provider in the failover
 * ladder just gets tried instead); a late one means a pulse burns real
 * retries against a provider about to 429 it anyway. A maintainer who
 * knows their actual current limit can override via `<PROVIDER>_DAILY_LIMIT`
 * (e.g. `GROQ_DAILY_LIMIT=500`).
 * @type {Record<string, number>}
 */
export const FREE_TIER_DAILY_LIMITS = Object.freeze({
  groq: 1000, // Groq's free dev tier is request-per-day capped per model; 1000 is a conservative floor.
  together: 200, // Together's free trial credit is small; this is a request-count proxy, not a $ figure.
  openrouter: 50, // OpenRouter's `:free` model variants cap unauthenticated/free usage per day around this order.
  gemini: 250, // Google AI Studio's free tier for the flash-class models this repo targets.
  huggingface: 300, // HF Inference API's free-tier rate limits are hourly in practice; this is a same-order daily proxy.
});

function envOverride(id) {
  const raw = process.env[`${id.toUpperCase()}_DAILY_LIMIT`];
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @param {string} id @returns {number|null} null means "no known limit — never block on quota". */
export function dailyLimitFor(id) {
  return envOverride(id) ?? FREE_TIER_DAILY_LIMITS[id] ?? null;
}

function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export class QuotaLedger {
  /** @type {Record<string, {date:string, count:number}>} */
  #usage = {};
  #loaded = false;
  #path;

  constructor(path = QUOTA_PATH) {
    this.#path = path;
  }

  load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      if (existsSync(this.#path)) {
        const raw = JSON.parse(readFileSync(this.#path, 'utf8'));
        if (raw && typeof raw === 'object' && raw.usage && typeof raw.usage === 'object') {
          this.#usage = raw.usage;
        }
      }
    } catch (err) {
      log.warn('quota.json unreadable — starting from an empty ledger', { error: String(err) });
    }
  }

  /**
   * Today's count for a provider, resetting to 0 if the stored date is not
   * today (UTC midnight rollover — task brief: "resets at UTC midnight").
   * @param {string} id
   * @param {Date} [now]
   */
  countToday(id, now = new Date()) {
    this.load();
    const entry = this.#usage[id];
    return entry && entry.date === todayUtc(now) ? entry.count : 0;
  }

  /**
   * Would the NEXT call push this provider over its known daily limit?
   * A provider with no known limit (`dailyLimitFor` returns null) never
   * blocks here — the router's health/cooldown gate is still the real
   * safety net for those.
   * @param {string} id
   * @param {Date} [now]
   * @returns {boolean}
   */
  wouldExceed(id, now = new Date()) {
    const limit = dailyLimitFor(id);
    if (limit === null) return false;
    return this.countToday(id, now) >= limit;
  }

  /**
   * Record one real call against a provider's daily count.
   * @param {string} id
   * @param {Date} [now]
   */
  recordCall(id, now = new Date()) {
    this.load();
    const date = todayUtc(now);
    const entry = this.#usage[id];
    const count = entry && entry.date === date ? entry.count + 1 : 1;
    this.#usage[id] = { date, count };
  }

  /** @returns {Array<{id:string, date:string, count:number, limit:number|null}>} */
  list() {
    this.load();
    const ids = new Set([...Object.keys(this.#usage), ...Object.keys(FREE_TIER_DAILY_LIMITS)]);
    return [...ids].map((id) => ({
      id,
      date: this.#usage[id]?.date ?? null,
      count: this.#usage[id]?.date === todayUtc() ? this.#usage[id].count : 0,
      limit: dailyLimitFor(id),
    }));
  }

  save() {
    try {
      writeJsonAtomic(this.#path, { version: 1, updatedAt: new Date().toISOString(), usage: this.#usage });
    } catch (err) {
      log.warn('quota.json write failed — continuing in-memory only', { error: String(err) });
    }
  }
}

export const quotaLedger = new QuotaLedger();
export default quotaLedger;
