/**
 * @file The quota ledger — `state/quota.json`. Free-tier limits are the
 * scarcest resource Runner has, and until now nothing counted them: a
 * provider was only avoided *after* it answered 429. The ledger tracks each
 * provider's per-minute and per-day windows itself, so the registry can
 * skip a provider that is about to run dry and the scheduler can spend
 * what is left on purpose, keeping a reserve for high-priority work.
 *
 * Limits are conservative documented defaults for each free tier (they
 * churn; override with `TITAN_QUOTA_<PROVIDER>_PER_MINUTE` /
 * `_PER_DAY`). They are a scheduling input, not a guarantee: a 429 still
 * puts the provider in cooldown through `providers/health.js`.
 *
 * Windows are anchored on the wall clock (UTC minute / UTC day) so a count
 * survives across pulses and across the state commit that carries it.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Conservative per-provider free-tier ceilings. */
export const DEFAULT_LIMITS = Object.freeze({
  groq: { perMinute: 25, perDay: 12_000 },
  together: { perMinute: 50, perDay: 4_000 },
  openrouter: { perMinute: 15, perDay: 180 },
  gemini: { perMinute: 12, perDay: 1_200 },
  huggingface: { perMinute: 25, perDay: 800 },
  opencode: { perMinute: 20, perDay: 500 },
  omniroute: { perMinute: 60, perDay: 10_000 },
});

const FALLBACK_LIMIT = Object.freeze({ perMinute: 20, perDay: 500 });

/** Share of the daily ceiling held back for high/urgent work. */
export const DEFAULT_RESERVE_FRACTION = 0.15;

export class QuotaLedger {
  /**
   * @param {{ path?: string|null, now?: () => Date, limits?: Record<string, {perMinute: number, perDay: number}>, reserveFraction?: number, env?: NodeJS.ProcessEnv, writeJson?: (path: string, data: object) => void }} [init]
   */
  constructor(init = {}) {
    this.path = init.path ?? null;
    this.now = init.now ?? (() => new Date());
    this.reserveFraction = init.reserveFraction ?? DEFAULT_RESERVE_FRACTION;
    this.limits = { ...DEFAULT_LIMITS, ...(init.limits ?? {}), ...limitsFromEnv(init.env ?? process.env) };
    this.writeJson = init.writeJson ?? null;
    /** @type {Record<string, { minute: { start: string, count: number }, day: { start: string, count: number }, tokens: number, last429At: string|null }>} */
    this.providers = {};
    this.dirty = false;
    if (this.path && existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8'));
        if (raw && typeof raw.providers === 'object') this.providers = raw.providers;
      } catch {
        this.providers = {};
      }
    }
  }

  limitFor(id) {
    return this.limits[id] ?? FALLBACK_LIMIT;
  }

  #windows(id) {
    const now = this.now();
    const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const rec = this.providers[id] ?? { minute: { start: minuteStart, count: 0 }, day: { start: dayStart, count: 0 }, tokens: 0, last429At: null };
    if (rec.minute.start !== minuteStart) rec.minute = { start: minuteStart, count: 0 };
    if (rec.day.start !== dayStart) {
      rec.day = { start: dayStart, count: 0 };
      rec.tokens = 0;
    }
    this.providers[id] = rec;
    return rec;
  }

  /**
   * @param {string} id
   * @param {{ priority?: string }} [opts]
   * @returns {{ ok: boolean, reason: string|null, minuteLeft: number, dayLeft: number }}
   */
  canSpend(id, opts = {}) {
    const limit = this.limitFor(id);
    const rec = this.#windows(id);
    const minuteLeft = Math.max(0, limit.perMinute - rec.minute.count);
    const dayLeft = Math.max(0, limit.perDay - rec.day.count);
    const highPriority = opts.priority === 'high' || opts.priority === 'urgent';
    const reserve = highPriority ? 0 : Math.ceil(limit.perDay * this.reserveFraction);
    if (minuteLeft <= 0) return { ok: false, reason: 'per-minute quota spent', minuteLeft, dayLeft };
    if (dayLeft <= reserve) return { ok: false, reason: highPriority ? 'daily quota spent' : 'daily quota down to the high-priority reserve', minuteLeft, dayLeft };
    return { ok: true, reason: null, minuteLeft, dayLeft };
  }

  /** @param {string} id @param {{ tokens?: number|null, status?: number|null }} [outcome] */
  record(id, outcome = {}) {
    const rec = this.#windows(id);
    rec.minute.count += 1;
    rec.day.count += 1;
    if (Number.isFinite(outcome.tokens)) rec.tokens += Number(outcome.tokens);
    if (outcome.status === 429) rec.last429At = this.now().toISOString();
    this.dirty = true;
  }

  /** When the per-minute window resets (the soonest a spent provider is worth trying again). */
  nextMinuteResetMs() {
    const now = this.now().getTime();
    return Math.floor(now / 60_000) * 60_000 + 60_000 - now;
  }

  snapshot() {
    const out = {};
    for (const id of new Set([...Object.keys(this.limits), ...Object.keys(this.providers)])) {
      const limit = this.limitFor(id);
      const rec = this.#windows(id);
      out[id] = { perMinute: limit.perMinute, perDay: limit.perDay, usedMinute: rec.minute.count, usedDay: rec.day.count, tokensToday: rec.tokens, dayLeft: Math.max(0, limit.perDay - rec.day.count), last429At: rec.last429At };
    }
    return out;
  }

  toJSON() {
    return { version: 1, updatedAt: this.now().toISOString(), reserveFraction: this.reserveFraction, providers: this.providers };
  }

  /** Persist through the injected writer (the state store), if any. */
  save() {
    if (!this.path || !this.writeJson || !this.dirty) return false;
    this.writeJson(this.path, this.toJSON());
    this.dirty = false;
    return true;
  }
}

function limitsFromEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const m = key.match(/^TITAN_QUOTA_([A-Z0-9]+)_PER_(MINUTE|DAY)$/);
    if (!m) continue;
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = m[1].toLowerCase();
    out[id] = { ...(DEFAULT_LIMITS[id] ?? FALLBACK_LIMIT), ...(out[id] ?? {}), [m[2] === 'MINUTE' ? 'perMinute' : 'perDay']: n };
  }
  return out;
}

export default QuotaLedger;
