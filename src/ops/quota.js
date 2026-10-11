/**
 * @file Free quota maths for the usage ledger (RO1). Pure. The runner and the Worker both use it.
 *
 * `config/quotas.json` holds the limits. A usage record says what was spent. This file answers: how much is used,
 * how much is left, when does it reset, and is the provider exhausted. A limit that is not known stays `null`.
 * Runner never guesses a limit. If a provider sends rate-limit headers, the usage record carries `remaining_requests`,
 * and for a provider whose headers count a whole day (Groq) that value shows the real daily limit. Such a limit has
 * the confidence `observed`.
 */
import quotasJson from '../../config/quotas.json' with { type: 'json' };

export const QUOTAS = quotasJson;
/** `exhausted` turns true at this share of a known limit (the contract says 95%). */
export const EXHAUSTED_AT = 0.95;
export const CONFIDENCES = Object.freeze(['official', 'observed', 'unknown']);

/** The quota key of a provider id. `hermes_1` and `custom_2` use the entries `hermes` and `custom`. */
export function providerKey(provider) {
  return String(provider).replace(/_\d+$/, '');
}

/**
 * Find the limit entry for a provider and a model. An exact model id wins, then a `*suffix` pattern, then `*`.
 * @returns {{ provider: object, entry: object, matched: string } | null}
 */
export function resolveLimit(provider, model, quotas = QUOTAS) {
  const p = quotas.providers[providerKey(provider)];
  if (!p) return null;
  const models = p.models;
  if (models[model]) return { provider: p, entry: models[model], matched: model };
  const patterns = Object.keys(models).filter((k) => k.startsWith('*') && k.length > 1).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) if (String(model).endsWith(pattern.slice(1))) return { provider: p, entry: models[pattern], matched: pattern };
  if (models['*']) return { provider: p, entry: models['*'], matched: '*' };
  return null;
}

// ---------------------------------------------------------------------
// Resets
// ---------------------------------------------------------------------

const LA = 'America/Los_Angeles';

/** The local clock fields of an instant in a time zone. */
function localParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** The instant (ms) when the clock of `timeZone` shows 00:00 on the given local date. */
function midnightOf(y, m, d, timeZone) {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (const offsetHours of [7, 8, 6, 9, 5, 4]) {
    const candidate = guess + offsetHours * 3_600_000;
    const l = localParts(candidate, timeZone);
    if (l.y === y && l.m === m && l.d === d && l.h === 0 && l.min === 0 && l.s === 0) return candidate;
  }
  return guess + 8 * 3_600_000;
}

/**
 * The start of the current day window and the time of the next reset.
 * @param {'utc-midnight'|'pacific-midnight'|string} rule
 * @param {Date} now
 * @returns {{ start: Date, next: Date }}
 */
export function dayWindow(rule, now) {
  const t = now.getTime();
  if (rule === 'pacific-midnight') {
    const l = localParts(t, LA);
    const start = midnightOf(l.y, l.m, l.d, LA);
    const tomorrow = new Date(Date.UTC(l.y, l.m - 1, l.d + 1));
    const next = midnightOf(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), LA);
    return { start: new Date(start), next: new Date(next) };
  }
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: new Date(start), next: new Date(start + 86_400_000) };
}

/** The start of the current UTC month. */
export function monthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------
// The answer for one provider and model
// ---------------------------------------------------------------------

/**
 * @typedef {object} UsageTotals
 * @property {number} day Requests since the day window began.
 * @property {number} month Requests since the month began.
 * @property {string|null} blockedUntil An ISO time. Set after a 429, until the reset.
 * @property {{ remainingRequests: number|null, remainingTokens: number|null, observedAt: string|null, usedDayAtObservation: number|null }} [observed]
 */

/**
 * @param {{ provider: string, model: string, usage: UsageTotals, now?: Date, quotas?: object }} input
 * @returns {{ limit_day: number|null, used_day: number, limit_month: number|null, used_month: number, remaining_pct: number|null, resets_at: string, exhausted: boolean, limit_source: string|null, limit_confidence: 'official'|'observed'|'unknown' }}
 */
export function computeQuota({ provider, model, usage, now = new Date(), quotas = QUOTAS }) {
  const found = resolveLimit(provider, model, quotas);
  const rule = found?.provider.reset ?? 'utc-midnight';
  const window = dayWindow(rule, now);
  let limitDay = found?.entry.limit_day ?? null;
  const limitMonth = found?.entry.limit_month ?? null;
  let confidence = found?.entry.limit_confidence ?? 'unknown';
  const source = found?.entry.limit_source ?? null;

  // An observed daily limit: the provider's own header said how many requests were left, and that header counts a day.
  const obs = usage.observed;
  if (limitDay === null && found?.provider.remainingSemantics?.requests === 'day' && obs?.remainingRequests != null && obs.observedAt && Date.parse(obs.observedAt) >= window.start.getTime()) {
    limitDay = (obs.usedDayAtObservation ?? 0) + obs.remainingRequests;
    confidence = 'observed';
  }

  const usedDay = usage.day;
  const usedMonth = usage.month;
  const shares = [];
  if (limitDay) shares.push(usedDay / limitDay);
  if (limitMonth) shares.push(usedMonth / limitMonth);
  const worst = shares.length ? Math.max(...shares) : null;
  const blocked = usage.blockedUntil ? Date.parse(usage.blockedUntil) > now.getTime() : false;
  const exhausted = blocked || (worst !== null && worst >= EXHAUSTED_AT);
  const remainingPct = worst === null ? null : Math.max(0, Math.round((1 - worst) * 1000) / 10);
  return {
    limit_day: limitDay,
    used_day: usedDay,
    limit_month: limitMonth,
    used_month: usedMonth,
    remaining_pct: remainingPct,
    resets_at: window.next.toISOString(),
    exhausted,
    limit_source: source,
    limit_confidence: limitDay === null && limitMonth === null ? 'unknown' : confidence,
  };
}

/** The reset time that a 429 holds a provider until. */
export function blockedUntilAfter429(provider, now = new Date(), quotas = QUOTAS) {
  const rule = quotas.providers[providerKey(provider)]?.reset ?? 'utc-midnight';
  return dayWindow(rule, now).next.toISOString();
}

export default { QUOTAS, resolveLimit, dayWindow, monthStart, computeQuota, blockedUntilAfter429, providerKey, EXHAUSTED_AT };
