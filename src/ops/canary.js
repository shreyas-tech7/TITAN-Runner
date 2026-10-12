/**
 * @file The nightly provider canary (RO2).
 *
 * Each night one tiny task goes to every provider adapter and every provider sub-server of this repo. The task has a
 * known answer and a fixed format. The canary marks each provider with one of the four statuses of contract v1:
 *
 *   healthy         the answer is right, the JSON is valid, and the call is fast
 *   degraded        the call worked, but it was slow, or the answer or the format was wrong, or it failed once and then worked
 *   down            the call failed twice, or the key was rejected, or the quota is gone
 *   not_configured  no key
 *
 * A Hermes agent can act on its own host, so it gets no prompt. The canary lists its models only, the same rule as
 * `src/providers/selftest.js`. The result holds a provider name, a model name, a status, a latency, a time, and an error
 * class. It never holds a key or an answer text.
 */
import { classifyFailure } from '../reliability/failures.js';
import { redactString } from '../lib/redact.js';

export const CANARY_PROMPT = 'Add 17 and 25. Reply with only this JSON and nothing else: {"sum": <the number>}';
export const CANARY_EXPECTED_SUM = 42;
export const CANARY_MAX_TOKENS = 64;
/** A call slower than this counts as degraded. */
export const SLOW_MS = 8_000;
export const RETRY_DELAY_MS = 2_000;

/**
 * Judge the text of an answer.
 * @param {string} text
 * @returns {{ ok: boolean, errorClass: 'bad_format'|'wrong_answer'|null }}
 */
export function judgeAnswer(text) {
  const raw = String(text ?? '').trim();
  // The answer may sit in a code fence, or after a thinking block. Take the first object that parses.
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);
  for (const m of raw.matchAll(/\{[^{}]*\}/g)) candidates.push(m[0]);
  for (const c of candidates) {
    try {
      const value = JSON.parse(c);
      if (value && typeof value === 'object' && !Array.isArray(value) && 'sum' in value) {
        return Number(value.sum) === CANARY_EXPECTED_SUM && typeof value.sum !== 'boolean'
          ? { ok: true, errorClass: null }
          : { ok: false, errorClass: 'wrong_answer' };
      }
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, errorClass: 'bad_format' };
}

/** A short error text for the workflow log. Secrets are cut out, and so are line breaks. It is never stored. */
export function describeError(err) {
  const text = String(err?.message ?? err ?? '').replace(/\s+/g, ' ').trim();
  return String(redactString(text)).slice(0, 160) || null;
}

/** Map a thrown error to the status and the error class of the canary. */
export function judgeError(err) {
  const f = classifyFailure(err);
  if (f.class === 'rate_limited') return { status: 'degraded', errorClass: 'rate_limited' };
  if (f.class === 'budget_exhausted') return { status: 'down', errorClass: 'quota' };
  // A 403 that names the model is a limit of that model, not a bad key. OpenRouter said "only available on agentic
  // harnesses" for a free model that discovery had chosen, and the canary called it a key problem.
  if (f.status === 403 && /only available|not available|terms acceptance|do(es)? not have access to (this|the) model|not allowed for this model/i.test(String(err?.message ?? ''))) return { status: 'down', errorClass: 'model_invalid' };
  if (f.status === 401 || f.status === 403 || err?.code === 'UNAUTHORIZED') return { status: 'down', errorClass: 'auth' };
  if (f.class === 'timeout') return { status: 'down', errorClass: 'timeout' };
  if (f.status === 404 || /model[_ -]?not[_ -]?found|does not exist/i.test(String(err?.message ?? ''))) return { status: 'down', errorClass: 'model_invalid' };
  return { status: 'down', errorClass: f.class === 'provider_down' ? 'provider_down' : 'error' };
}

/**
 * @typedef {object} CanaryTarget
 * @property {string} id The provider id, such as `groq` or `hermes_1`.
 * @property {string|null} model The model that the adapter will use, if known.
 * @property {'chat'|'list'|'none'} kind `chat` sends the fixed task. `list` only lists models. `none` calls nothing.
 * @property {string|null} [skip] For kind `none`: `no_key` or `no_public_api`.
 * @property {() => Promise<{ text?: string, model?: string|null, tokensIn?: number|null, tokensOut?: number|null, rate?: object|null }>} [call]
 */

/**
 * Probe one target.
 * @param {CanaryTarget} target
 * @param {{ now?: () => Date, sleep?: (ms: number) => Promise<void>, slowMs?: number, retryDelayMs?: number, usage?: { record: Function }|null, clock?: () => number }} [deps]
 * @returns {Promise<{ provider: string, model: string, status: string, latency_ms: number|null, checked_at: string, error_class: string|null }>}
 */
export async function probeTarget(target, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = deps.clock ?? (() => performance.now());
  const slowMs = deps.slowMs ?? SLOW_MS;
  const base = { provider: target.id, model: target.model || '*', checked_at: now().toISOString() };
  // `detail` is a short, redacted error text for the log of the workflow. It never goes to the mirror or to the Worker.
  const done = (status, latency, errorClass, model, detail = null) => ({ ...base, model: model || base.model, status, latency_ms: latency, error_class: errorClass, detail });

  if (target.kind === 'none') return done('not_configured', null, target.skip ?? 'no_key');

  const attempts = [];
  for (let i = 0; i < 2; i += 1) {
    const started = clock();
    try {
      const out = await target.call();
      const latency = Math.round(clock() - started);
      if (target.kind === 'chat') {
        deps.usage?.record({ provider: target.id, model: out.model ?? target.model, status: 'ok', tokensIn: out.tokensIn, tokensOut: out.tokensOut, remainingRequests: out.rate?.remainingRequests, remainingTokens: out.rate?.remainingTokens });
        const verdict = judgeAnswer(out.text);
        attempts.push({ ok: verdict.ok, latency, errorClass: verdict.errorClass, model: out.model ?? null, kind: 'answer' });
      } else {
        attempts.push({ ok: true, latency, errorClass: null, model: out.model ?? null, kind: 'list' });
      }
    } catch (err) {
      const latency = Math.round(clock() - started);
      const j = judgeError(err);
      if (target.kind === 'chat') deps.usage?.record({ provider: target.id, model: target.model, status: j.errorClass === 'rate_limited' ? 'rate_limited' : 'error' });
      attempts.push({ ok: false, latency, errorClass: j.errorClass, status: j.status, model: null, kind: 'error', detail: describeError(err) });
      // A key that was rejected, a spent quota, and a rate limit do not get better in two seconds. Do not retry them.
      if (['auth', 'quota', 'rate_limited', 'model_invalid'].includes(j.errorClass)) break;
    }
    if (attempts.at(-1).ok) break;
    if (i === 0) await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
  }

  const last = attempts.at(-1);
  const model = attempts.map((a) => a.model).filter(Boolean).at(-1) ?? null;
  if (last.ok) {
    // It worked. A first try that failed makes it flaky. A slow answer makes it degraded.
    if (attempts.length > 1) return done('degraded', last.latency, 'flaky', model);
    if (last.latency > slowMs) return done('degraded', last.latency, 'slow', model);
    return done('healthy', last.latency, null, model);
  }
  if (last.kind === 'answer') return done('degraded', last.latency, last.errorClass, model);
  if (last.status === 'degraded') return done('degraded', last.latency, last.errorClass, model, last.detail);
  return done('down', last.latency, last.errorClass, model, last.detail);
}

/**
 * Probe every target, one after the other, so the canary stays inside the limits of a provider.
 * @param {CanaryTarget[]} targets
 * @param {Parameters<typeof probeTarget>[1]} [deps]
 */
export async function runCanary(targets, deps = {}) {
  const results = [];
  for (const t of targets) results.push(await probeTarget(t, deps));
  return results;
}

/** The public mirror of the results: `state/ops/health.json`. */
export function healthMirror(results, now = new Date()) {
  const providers = {};
  for (const r of [...results].sort((a, b) => (a.provider + a.model).localeCompare(b.provider + b.model))) {
    (providers[r.provider] ??= {})[r.model] = { status: r.status, latency_ms: r.latency_ms, checked_at: r.checked_at, error_class: r.error_class };
  }
  return { contract: '1', generated_at: now.toISOString(), providers };
}

export default { CANARY_PROMPT, judgeAnswer, judgeError, probeTarget, runCanary, healthMirror };
