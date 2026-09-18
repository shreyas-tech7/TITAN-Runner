/**
 * @file The failure taxonomy. Every error the engine sees — a provider
 * rejection, a hung call, a model that answered nonsense, a tool that broke,
 * a gate that said no — is mapped to exactly one class here, and every
 * retry, park, breaker, and dead-letter decision keys off that class rather
 * than off string-matching at the call site.
 *
 *   transient        unknown but plausibly momentary; one same-provider retry
 *   rate_limited     429 / RATE_LIMITED; honour Retry-After, else another provider
 *   provider_down    5xx, connection faults, unreachable; another provider, or park
 *   timeout          the engine's own deadline fired; another provider
 *   malformed_output the model answered but not in the contract; bounded repair
 *   tool_error       a tool call failed; per-tool policy
 *   policy_blocked   the reviewer gate / policy engine refused; never retried
 *   budget_exhausted 402, quota, credits, or an internal budget; park or give up
 *   permanent        4xx we caused (400/401/403/404, NOT_CONFIGURED, NO_PUBLIC_API);
 *                    never the same provider again, another provider once
 *   poisoned         the same failure keeps recurring; dead-letter
 *   cancelled        a human or the engine stopped it; never retried
 */

export const FAILURE_CLASSES = Object.freeze([
  'transient', 'rate_limited', 'provider_down', 'timeout', 'malformed_output', 'tool_error',
  'policy_blocked', 'budget_exhausted', 'permanent', 'poisoned', 'cancelled',
]);

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function statusOf(err) {
  const candidates = [err?.status, err?.statusCode, err?.response?.status];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  return null;
}

/**
 * @param {unknown} err An Error, a `{code, status, message}` object, or a string.
 * @returns {{ class: string, code: string|null, status: number|null, message: string, retryAfterMs: number|null }}
 */
export function classifyFailure(err) {
  const e = err && typeof err === 'object' ? err : { message: String(err ?? 'unknown error') };
  const code = typeof e.code === 'string' ? e.code : null;
  const status = statusOf(e);
  const message = typeof e.message === 'string' ? e.message : String(e.message ?? '');
  const retryAfterMs = Number.isFinite(e.retryAfterMs) ? Number(e.retryAfterMs) : null;
  const explicit = typeof e.class === 'string' && FAILURE_CLASSES.includes(e.class) ? e.class : null;
  const cls = explicit ?? classify(code, status, message, e);
  return { class: cls, code, status, message: message.slice(0, 500), retryAfterMs };
}

function classify(code, status, message, e) {
  const msg = message.toLowerCase();
  if (code === 'CANCELLED' || e?.name === 'AbortError' && !/deadline/i.test(message)) return 'cancelled';
  if (code === 'POLICY_BLOCKED' || code === 'GATE_BLOCK') return 'policy_blocked';
  if (code === 'LOOP_DETECTED' || code === 'NO_PROGRESS') return 'poisoned';
  if (code === 'TASK_TIMEOUT' || /deadline of \d+ms exceeded/i.test(message) || e?.name === 'TimeoutError') return 'timeout';
  if (code === 'MALFORMED_OUTPUT' || code === 'EMPTY_OUTPUT' || code === 'REFUSAL') return 'malformed_output';
  if (code === 'TOOL_ERROR' || (typeof code === 'string' && code.startsWith('TOOL_'))) return 'tool_error';
  if (code === 'TASK_BUDGET' || code === 'PULSE_BUDGET') return 'budget_exhausted';
  if (status === 429 || code === 'RATE_LIMITED') return 'rate_limited';
  if (status === 402 || /quota|insufficient[_ -]?(balance|credit)|out of credits|credit balance/i.test(msg)) return 'budget_exhausted';
  if (status === 401 || status === 403 || code === 'UNAUTHORIZED') return 'permanent';
  if (status === 404 || /model[_ -]?not[_ -]?found|does not exist|unknown model|invalid model/i.test(msg)) return 'permanent';
  if (code === 'NOT_CONFIGURED' || code === 'NO_PUBLIC_API' || code === 'NO_CANDIDATE') return 'permanent';
  if (status != null && status >= 500) return 'provider_down';
  if (code && NETWORK_CODES.has(code)) return 'provider_down';
  if (/unreachable|socket hang up|network failure|fetch failed/i.test(msg)) return 'provider_down';
  if (status != null && status >= 400) return 'permanent';
  if (code === 'ALL_PROVIDERS_FAILED') return e?.failureClass ?? 'provider_down';
  return 'transient';
}

/**
 * The class of "every provider we tried failed", from the per-provider
 * classes: a limit anywhere means waiting works; every one permanent means
 * nothing will; nothing tried at all means nothing was callable.
 * @param {string[]} classes
 * @param {{ skipped?: number }} [ctx]
 */
export function aggregateClass(classes, ctx = {}) {
  if (classes.length === 0) return ctx.skipped ? 'provider_down' : 'permanent';
  if (classes.every((c) => c === 'permanent' || c === 'policy_blocked')) return 'permanent';
  if (classes.every((c) => c === 'budget_exhausted' || c === 'permanent')) return 'budget_exhausted';
  if (classes.includes('rate_limited')) return 'rate_limited';
  if (classes.includes('provider_down') || classes.includes('timeout')) return 'provider_down';
  if (classes.every((c) => c === 'malformed_output')) return 'malformed_output';
  return 'transient';
}

/** Classes the engine parks a task on (waits and tries again on a later pulse) rather than fails. */
export const PARKABLE = Object.freeze({ rate_limited: 'provider', provider_down: 'provider', budget_exhausted: 'quota' });

export default { FAILURE_CLASSES, classifyFailure, aggregateClass, PARKABLE };
