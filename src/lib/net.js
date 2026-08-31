/**
 * @file Guarded fetch — every outbound provider call in this repo goes
 * through here instead of the global `fetch` directly.
 *
 * TITAN-Runner has no SQLite egress ledger (there is no database at all —
 * see docs/RUNTIME.md on why the repo itself is the database, as flat JSON
 * only), so this is a much smaller module than the original TITAN backend's
 * `utils/net.js`: it keeps only the one guarantee that actually matters
 * here — `TITAN_DRY_RUN=1` (or config.dryRun) makes every attempted network
 * call throw instead of silently reaching a real provider, which is what
 * lets `npm run pulse:dry` and the test suite exercise the whole pipeline
 * with zero credentials and zero network access.
 */
import { config } from '../config.js';

export class DryRunViolationError extends Error {
  constructor(url) {
    super(`Dry-run violation: attempted network request to ${url}`);
    this.name = 'DryRunViolationError';
    this.url = url;
  }
}

/** Default hard deadline for a call that does not set its own — see `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {string|URL} url
 * @param {RequestInit & { timeoutMs?: number }} [init] `timeoutMs` (default
 *   30s) enforces a hard per-call deadline merged with any caller-supplied
 *   `signal` — every caller through this function gets one, whether or not
 *   it built its own `AbortController` (`providers/base.js`'s callers
 *   already do and can pass `timeoutMs: 0` to skip the extra one; the agent
 *   adapters, which had no deadline at all before this, cannot hang past
 *   this ceiling any more).
 * @returns {Promise<Response>}
 */
export async function guardedFetch(url, init = {}) {
  if (config.dryRun) {
    throw new DryRunViolationError(String(url));
  }
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
  if (!timeoutMs || timeoutMs <= 0) {
    return globalThis.fetch(url, { ...rest, signal: callerSignal });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`deadline of ${timeoutMs}ms exceeded`)), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  try {
    return await globalThis.fetch(url, { ...rest, signal });
  } finally {
    clearTimeout(timer);
  }
}

export default guardedFetch;
