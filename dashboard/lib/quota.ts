/**
 * The free-tier quota view, built from `state/quota.json` (Wave 11).
 *
 * The ceilings are the Runner's own conservative defaults (`src/reliability/quota.js`), kept here as a copy
 * so a static page can show a number to compare against. They are a scheduling input and not a promise from
 * the provider: a 429 still puts a provider in cooldown. The ledger counts windows by UTC minute and UTC day,
 * so a count from an earlier day is shown as "none today" instead of being passed off as today's use.
 */

export interface QuotaWindow {
  start: string;
  count: number;
}

export interface QuotaProviderRecord {
  minute: QuotaWindow;
  day: QuotaWindow;
  tokens: number;
  last429At: string | null;
}

export interface QuotaState {
  version?: number;
  updatedAt?: string;
  reserveFraction?: number;
  providers?: Record<string, QuotaProviderRecord>;
}

/** Mirrors DEFAULT_LIMITS in the runner's src/reliability/quota.js. */
export const DEFAULT_LIMITS: Readonly<Record<string, { perMinute: number; perDay: number }>> = Object.freeze({
  groq: { perMinute: 25, perDay: 12_000 },
  together: { perMinute: 50, perDay: 4_000 },
  openrouter: { perMinute: 15, perDay: 180 },
  gemini: { perMinute: 12, perDay: 1_200 },
  huggingface: { perMinute: 25, perDay: 800 },
  opencode: { perMinute: 20, perDay: 500 },
  omniroute: { perMinute: 60, perDay: 10_000 },
});

export const FALLBACK_LIMIT = Object.freeze({ perMinute: 20, perDay: 500 });
export const DEFAULT_RESERVE = 0.15;

export interface QuotaRow {
  id: string;
  dayUsed: number;
  dayLimit: number;
  dayPct: number;
  /** Calls the scheduler will not spend on routine work, so urgent work still has room. */
  reserve: number;
  minuteUsed: number;
  minuteLimit: number;
  tokens: number;
  last429At: string | null;
  /** True when the ledger has a record, but none for the current UTC day. */
  staleDay: boolean;
  /** True when the ledger has never counted a call for this provider. */
  noRecord: boolean;
  /** The UTC day the counts belong to, `YYYY-MM-DD`, or null. */
  countedDay: string | null;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One row per provider: every provider with a default ceiling, plus any the ledger knows that has none.
 * @param nowMs The current time. A parameter so it can be tested.
 */
export function quotaRows(state: QuotaState | null | undefined, nowMs: number): QuotaRow[] {
  const reserveFraction = typeof state?.reserveFraction === "number" && state.reserveFraction >= 0 && state.reserveFraction < 1 ? state.reserveFraction : DEFAULT_RESERVE;
  const ids = [...new Set([...Object.keys(DEFAULT_LIMITS), ...Object.keys(state?.providers ?? {})])];
  const today = utcDay(nowMs);
  const thisMinute = new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString();
  return ids.map((id) => {
    const limit = DEFAULT_LIMITS[id] ?? FALLBACK_LIMIT;
    const rec = state?.providers?.[id];
    const countedDay = rec?.day?.start ? rec.day.start.slice(0, 10) : null;
    const sameDay = countedDay === today;
    const dayUsed = rec && sameDay ? Math.max(0, Number(rec.day.count) || 0) : 0;
    const minuteUsed = rec && rec.minute?.start === thisMinute ? Math.max(0, Number(rec.minute.count) || 0) : 0;
    return {
      id,
      dayUsed,
      dayLimit: limit.perDay,
      dayPct: Math.min(100, Math.round((dayUsed / limit.perDay) * 1000) / 10),
      reserve: Math.round(limit.perDay * reserveFraction),
      minuteUsed,
      minuteLimit: limit.perMinute,
      tokens: rec && sameDay ? Math.max(0, Number(rec.tokens) || 0) : 0,
      last429At: rec?.last429At ?? null,
      staleDay: Boolean(rec) && !sameDay,
      noRecord: !rec,
      countedDay,
    };
  });
}
