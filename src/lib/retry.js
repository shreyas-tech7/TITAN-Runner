/**
 * @file Retry with exponential backoff and full jitter.
 *
 * Free-tier providers rate-limit aggressively and fail transiently. The policy
 * here is deliberately conservative:
 *
 *   - 3 attempts total, not "until it works". A dashboard that hangs for a
 *     minute retrying is worse than one that says "degraded" in two seconds.
 *   - Retry only 429 / 5xx / network faults. A 400 or 401 means the request
 *     itself is wrong; replaying it three times just burns quota and, on a
 *     free tier, can trip an abuse heuristic.
 *   - **Full** jitter, not "exponential plus a bit". Every retry of every
 *     in-flight request otherwise re-collides at the same instant, which is
 *     precisely the thundering herd the backoff was meant to prevent.
 */

/**
 * An error that carries enough information for the retry policy to decide.
 * Providers should wrap their HTTP failures in this.
 */
export class RetryableError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status] Upstream HTTP status, when there was one.
   * @param {number} [options.retryAfterMs] Server-directed delay, already in ms.
   * @param {unknown} [options.cause] Original error.
   */
  constructor(message, { status, retryAfterMs, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RetryableError';
    /** @type {number|undefined} */
    this.status = status;
    /** @type {number|undefined} */
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Node/undici error codes that mean "the network misbehaved", i.e. the request
 * may well succeed if repeated.
 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Pull an HTTP status off whatever shape the error happens to be.
 * Octokit uses `status`, fetch wrappers tend to use `response.status`.
 * @param {any} err
 * @returns {number|undefined}
 */
function statusOf(err) {
  const candidates = [err?.status, err?.statusCode, err?.response?.status];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

/**
 * Should this failure be retried?
 *
 * @param {unknown} err
 * @returns {boolean} True for 429, 5xx, and network/timeout faults; false for
 *   every other 4xx and for a deliberate abort.
 */
export function isRetryableError(err) {
  if (!err || typeof err !== 'object') return false;
  const e = /** @type {any} */ (err);

  // An abort is a decision, not a fault. Retrying it would ignore the caller.
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return false;

  const status = statusOf(e);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500) return true;
    // Every other 4xx is the client's fault and will fail identically.
    if (status >= 400) return false;
    return false;
  }

  if (typeof e.code === 'string' && RETRYABLE_CODES.has(e.code)) return true;
  if (e.name === 'TimeoutError' || e.name === 'FetchError') return true;
  // A statusless RetryableError means the provider could not classify it
  // either — treat it as transient, which is what the type asserts.
  if (e instanceof RetryableError) return true;

  return false;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 * Accepts both documented forms: delta-seconds (`120`) and an HTTP-date
 * (`Wed, 21 Oct 2026 07:28:00 GMT`).
 *
 * @param {string|number|null|undefined} value
 * @returns {number|undefined} Milliseconds, or undefined when unparseable.
 */
export function parseRetryAfterMs(value) {
  if (value === null || value === undefined) return undefined;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber <= 0 ? 0 : Math.round(asNumber * 1000);
  }

  const asDate = Date.parse(String(value));
  if (Number.isFinite(asDate)) {
    // Clamp at 0: a server clock running ahead of ours must not yield a
    // negative delay that skips the wait entirely.
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

/**
 * Delay before the next attempt, using full jitter:
 * `random() * min(maxDelayMs, baseDelayMs * 2 ** attempt)`.
 *
 * @param {number} attempt Zero-based retry index — 0 is the wait after the first failure.
 * @param {object} [options]
 * @param {number} [options.baseDelayMs=300]
 * @param {number} [options.maxDelayMs=8000]
 * @param {number} [options.retryAfterMs] Server-directed delay. When present it
 *   wins outright: a provider telling us when to come back is better
 *   information than any local guess. It is bounded in practice by the
 *   caller's AbortSignal / request timeout, not by `maxDelayMs`.
 * @returns {number} Milliseconds to wait.
 */
export function computeBackoff(attempt, { baseDelayMs = 300, maxDelayMs = 8000, retryAfterMs } = {}) {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.round(retryAfterMs);
  }

  const n = Number.isFinite(attempt) && attempt > 0 ? Math.trunc(attempt) : 0;
  // 2 ** n is bounded by the min() below, so a large n cannot overflow into Infinity.
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(n, 30));
  return Math.round(Math.random() * ceiling);
}

/**
 * Sleep that can be cancelled.
 *
 * The timer is cleared and the listener removed on both paths — a dangling
 * `setTimeout` would hold the event loop open for up to 8 seconds after the
 * caller has already given up and moved on.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {AbortSignal} [signal]
 * @returns {Error}
 */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('Operation aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * @typedef {object} RetryOptions
 * @property {number} [attempts=3] Total tries, including the first.
 * @property {number} [baseDelayMs=300]
 * @property {number} [maxDelayMs=8000]
 * @property {AbortSignal} [signal] Cancels both the wait and any further attempts.
 * @property {(info: { attempt: number, delayMs: number, error: unknown }) => void} [onRetry]
 *   Called after a failure, before the wait. `attempt` is the 1-based number of the try that failed.
 * @property {(err: unknown) => boolean} [isRetryable] Override the default classifier.
 */

/**
 * Run `fn`, retrying transient failures.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>|T} fn Receives the 1-based attempt number.
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 * @throws The last error, unchanged — callers map it to a status themselves.
 */
export async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 8000,
    signal,
    onRetry,
    isRetryable = isRetryableError,
  } = options;

  const total = Math.max(1, Math.trunc(attempts));

  for (let attempt = 1; ; attempt += 1) {
    // Checked before every attempt, not just before the sleep: the caller may
    // have aborted while the previous attempt was in flight.
    if (signal?.aborted) throw abortError(signal);

    try {
      return await fn(attempt);
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      if (attempt >= total) throw err;
      if (!isRetryable(err)) throw err;

      const delayMs = computeBackoff(attempt - 1, {
        baseDelayMs,
        maxDelayMs,
        retryAfterMs: /** @type {any} */ (err)?.retryAfterMs,
      });

      if (onRetry) {
        try {
          onRetry({ attempt, delayMs, error: err });
        } catch {
          // An observer callback must not be able to break the retry loop.
        }
      }

      await sleep(delayMs, signal);
    }
  }
}

export default withRetry;
