/**
 * @file One retry policy per failure class. Pure: takes what happened and
 * what is left, returns what to do. The scheduler executes it.
 *
 *   retry-same   try the same model again after `delayMs` (exponential
 *                backoff with full jitter, or the server's Retry-After)
 *   retry-next   move to the next distinct candidate model now
 *   park         stop this pulse; the task waits (`park` names the reason)
 *                and a later pulse resumes from the checkpoint at `wakeAt`
 *   give-up      the step fails; the engine decides the task's fate
 *
 * Inline waits are capped (`maxInlineWaitMs`): a 429 asking for 30 s is
 * honoured by parking, never by sleeping a pulse's budget away.
 */
import { PARKABLE } from './failures.js';

/**
 * Per class: `sameMax` same-model retries, `nextMax` hops to a distinct
 * candidate (a hop is a fresh model, so a provider-side fault that is
 * still there after one hop is treated as widespread and parked rather
 * than swept across every provider), delays, and whether the server's
 * Retry-After is honoured.
 * @type {Readonly<Record<string, { sameMax: number, next: boolean, nextMax: number, baseDelayMs: number, maxDelayMs: number, honorRetryAfter: boolean, giveUp?: boolean }>>}
 */
export const POLICY = Object.freeze({
  transient: { sameMax: 1, next: true, nextMax: 2, baseDelayMs: 300, maxDelayMs: 4000, honorRetryAfter: false },
  rate_limited: { sameMax: 1, next: true, nextMax: 2, baseDelayMs: 1000, maxDelayMs: 8000, honorRetryAfter: true },
  provider_down: { sameMax: 0, next: true, nextMax: 1, baseDelayMs: 500, maxDelayMs: 4000, honorRetryAfter: true },
  timeout: { sameMax: 0, next: true, nextMax: 2, baseDelayMs: 0, maxDelayMs: 0, honorRetryAfter: false },
  malformed_output: { sameMax: 2, next: true, nextMax: 1, baseDelayMs: 0, maxDelayMs: 0, honorRetryAfter: false },
  tool_error: { sameMax: 1, next: false, nextMax: 0, baseDelayMs: 200, maxDelayMs: 2000, honorRetryAfter: false },
  budget_exhausted: { sameMax: 0, next: true, nextMax: 1, baseDelayMs: 0, maxDelayMs: 0, honorRetryAfter: false },
  permanent: { sameMax: 0, next: true, nextMax: 2, baseDelayMs: 0, maxDelayMs: 0, honorRetryAfter: false },
  policy_blocked: { sameMax: 0, next: false, nextMax: 0, baseDelayMs: 0, maxDelayMs: 0, honorRetryAfter: false, giveUp: true },
  poisoned: { sameMax: 0, next: false, nextMax: 0, baseDelayMs: 0, maxDelayMs: 0, honorRetryAfter: false, giveUp: true },
  cancelled: { sameMax: 0, next: false, nextMax: 0, baseDelayMs: 0, maxDelayMs: 0, honorRetryAfter: false, giveUp: true },
});

export const DEFAULT_MAX_INLINE_WAIT_MS = 10_000;

/** Park backoff across pulses, by how many times this task has parked already. */
export const PARK_BACKOFF_MS = Object.freeze([5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 3_600_000]);

/**
 * @param {number} attempt Zero-based same-provider retry index.
 * @param {{ baseDelayMs: number, maxDelayMs: number }} policy
 * @param {() => number} [random]
 */
export function backoffMs(attempt, policy, random = Math.random) {
  if (policy.maxDelayMs <= 0) return 0;
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt, 10));
  return Math.round(random() * ceiling);
}

/**
 * @param {{
 *   failure: { class: string, retryAfterMs?: number|null },
 *   sameProviderAttempts: number,   how many times this model has been tried for this step
 *   attemptsUsed: number,           total attempts on this step so far
 *   maxAttempts: number,
 *   nextAvailable: boolean,         is there a distinct candidate left
 *   hops?: number,                  distinct candidates already moved to on this step
 *   parks: number,                  how many times this task has already parked
 *   maxInlineWaitMs?: number,
 *   random?: () => number,
 * }} args
 * @returns {{ action: 'retry-same'|'retry-next'|'park'|'give-up', delayMs: number, park: string|null, wakeInMs: number|null, why: string }}
 */
export function decideRetry(args) {
  const policy = POLICY[args.failure.class] ?? POLICY.transient;
  const maxInline = args.maxInlineWaitMs ?? DEFAULT_MAX_INLINE_WAIT_MS;
  const parkReason = PARKABLE[args.failure.class] ?? null;

  if (policy.giveUp) return { action: 'give-up', delayMs: 0, park: null, wakeInMs: null, why: `${args.failure.class} is never retried` };
  if (args.attemptsUsed >= args.maxAttempts) {
    return parkReason
      ? parkDecision(args, parkReason, 'attempt ceiling reached; the fault is on the provider side')
      : { action: 'give-up', delayMs: 0, park: null, wakeInMs: null, why: 'attempt ceiling reached' };
  }

  const retryAfter = policy.honorRetryAfter && Number.isFinite(args.failure.retryAfterMs) ? args.failure.retryAfterMs : null;
  if (args.sameProviderAttempts <= policy.sameMax && !(retryAfter != null && retryAfter > maxInline)) {
    const delay = retryAfter != null ? retryAfter : backoffMs(args.sameProviderAttempts - 1, policy, args.random);
    if (delay <= maxInline) return { action: 'retry-same', delayMs: delay, park: null, wakeInMs: null, why: `${args.failure.class}: same model, attempt ${args.sameProviderAttempts + 1}` };
  }
  const hops = args.hops ?? 0;
  if (policy.next && args.nextAvailable && hops < policy.nextMax) return { action: 'retry-next', delayMs: 0, park: null, wakeInMs: null, why: `${args.failure.class}: next candidate (hop ${hops + 1} of ${policy.nextMax})` };
  if (parkReason) {
    const why = retryAfter != null && retryAfter > maxInline ? `Retry-After ${retryAfter} ms exceeds the inline cap`
      : hops >= policy.nextMax && args.nextAvailable ? `${hops + 1} provider(s) failed the same way; the fault is widespread`
        : 'no candidate left; the fault is on the provider side';
    return parkDecision(args, parkReason, why);
  }
  return { action: 'give-up', delayMs: 0, park: null, wakeInMs: null, why: `${args.failure.class}: no candidate left` };
}

/**
 * The park a failure outside the scheduler (planning, a tool) earns: the
 * same backoff ladder and Retry-After rule the scheduler's policy uses.
 * @param {{ class: string, retryAfterMs?: number|null }} failure
 * @param {number} parks
 * @returns {{ reason: string, wakeInMs: number, why: string } | null} null when the class is not parkable.
 */
export function parkFor(failure, parks) {
  const reason = PARKABLE[failure.class] ?? null;
  if (!reason) return null;
  const d = parkDecision({ failure, parks }, reason, `${failure.class} outside a step`);
  return { reason: d.park, wakeInMs: d.wakeInMs, why: d.why };
}

function parkDecision(args, reason, why) {
  const retryAfter = Number.isFinite(args.failure.retryAfterMs) ? args.failure.retryAfterMs : null;
  const backoff = PARK_BACKOFF_MS[Math.min(args.parks ?? 0, PARK_BACKOFF_MS.length - 1)];
  const wakeInMs = retryAfter != null ? Math.max(retryAfter, 1000) : backoff;
  return { action: 'park', delayMs: 0, park: reason, wakeInMs, why };
}

export default { POLICY, decideRetry, backoffMs, parkFor, PARK_BACKOFF_MS };
