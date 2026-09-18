import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRetry, backoffMs, parkFor, POLICY, PARK_BACKOFF_MS, DEFAULT_MAX_INLINE_WAIT_MS } from '../src/reliability/retryPolicy.js';

const base = { sameProviderAttempts: 1, attemptsUsed: 1, maxAttempts: 3, nextAvailable: true, hops: 0, parks: 0, random: () => 0.5 };

test('a permanent error never retries the same model: next candidate, then give up at the hop limit', () => {
  const first = decideRetry({ ...base, failure: { class: 'permanent' } });
  assert.equal(first.action, 'retry-next');
  const atLimit = decideRetry({ ...base, failure: { class: 'permanent' }, hops: POLICY.permanent.nextMax, attemptsUsed: 2 });
  assert.equal(atLimit.action, 'give-up');
  const noCandidate = decideRetry({ ...base, failure: { class: 'permanent' }, nextAvailable: false });
  assert.equal(noCandidate.action, 'give-up');
});

test('a transient error gets one same-model retry with jittered backoff, then moves on', () => {
  const retry = decideRetry({ ...base, failure: { class: 'transient' } });
  assert.equal(retry.action, 'retry-same');
  assert.ok(retry.delayMs > 0 && retry.delayMs <= POLICY.transient.maxDelayMs, `delay ${retry.delayMs}`);
  const second = decideRetry({ ...base, failure: { class: 'transient' }, sameProviderAttempts: 2, attemptsUsed: 2 });
  assert.equal(second.action, 'retry-next');
});

test('a rate limit honours a short Retry-After inline and parks on a long one instead of sleeping the pulse away', () => {
  const short = decideRetry({ ...base, failure: { class: 'rate_limited', retryAfterMs: 1500 } });
  assert.deepEqual([short.action, short.delayMs], ['retry-same', 1500]);
  const long = decideRetry({ ...base, failure: { class: 'rate_limited', retryAfterMs: DEFAULT_MAX_INLINE_WAIT_MS + 1 }, nextAvailable: false });
  assert.equal(long.action, 'park');
  assert.equal(long.park, 'provider');
  assert.equal(long.wakeInMs, DEFAULT_MAX_INLINE_WAIT_MS + 1);
  assert.match(long.why, /Retry-After/);
});

test('a provider outage moves to one other candidate and then parks rather than sweeping every provider', () => {
  const hop = decideRetry({ ...base, failure: { class: 'provider_down' } });
  assert.equal(hop.action, 'retry-next');
  const park = decideRetry({ ...base, failure: { class: 'provider_down' }, hops: 1, attemptsUsed: 2 });
  assert.equal(park.action, 'park');
  assert.equal(park.park, 'provider');
  assert.equal(park.wakeInMs, PARK_BACKOFF_MS[0]);
  assert.match(park.why, /widespread/);
});

test('an exhausted quota parks as "quota" with the backoff ladder by park count, capped at the top rung', () => {
  const first = decideRetry({ ...base, failure: { class: 'budget_exhausted' }, nextAvailable: false });
  assert.deepEqual([first.action, first.park, first.wakeInMs], ['park', 'quota', PARK_BACKOFF_MS[0]]);
  const third = decideRetry({ ...base, failure: { class: 'budget_exhausted' }, nextAvailable: false, parks: 2 });
  assert.equal(third.wakeInMs, PARK_BACKOFF_MS[2]);
  const beyond = decideRetry({ ...base, failure: { class: 'budget_exhausted' }, nextAvailable: false, parks: 99 });
  assert.equal(beyond.wakeInMs, PARK_BACKOFF_MS.at(-1));
});

test('a malformed answer is repaired on the same model up to the cap, then handed to one other candidate', () => {
  const r1 = decideRetry({ ...base, failure: { class: 'malformed_output' }, maxAttempts: 6 });
  assert.deepEqual([r1.action, r1.delayMs], ['retry-same', 0]);
  const r2 = decideRetry({ ...base, failure: { class: 'malformed_output' }, sameProviderAttempts: 2, attemptsUsed: 2, maxAttempts: 6 });
  assert.equal(r2.action, 'retry-same');
  const r3 = decideRetry({ ...base, failure: { class: 'malformed_output' }, sameProviderAttempts: 3, attemptsUsed: 3, maxAttempts: 6 });
  assert.equal(r3.action, 'retry-next');
  const r4 = decideRetry({ ...base, failure: { class: 'malformed_output' }, sameProviderAttempts: 3, attemptsUsed: 5, maxAttempts: 6, hops: 1 });
  assert.equal(r4.action, 'give-up');
});

test('the attempt ceiling parks a provider-side fault and gives up on our own', () => {
  const parked = decideRetry({ ...base, failure: { class: 'rate_limited' }, attemptsUsed: 3 });
  assert.equal(parked.action, 'park');
  const gaveUp = decideRetry({ ...base, failure: { class: 'transient' }, attemptsUsed: 3 });
  assert.equal(gaveUp.action, 'give-up');
});

test('blocked, poisoned, and cancelled are never retried', () => {
  for (const cls of ['policy_blocked', 'poisoned', 'cancelled']) {
    const d = decideRetry({ ...base, failure: { class: cls } });
    assert.equal(d.action, 'give-up', cls);
  }
});

test('backoff is full-jitter and bounded, and zero when the policy has no delay', () => {
  const policy = { baseDelayMs: 300, maxDelayMs: 4000 };
  assert.equal(backoffMs(0, policy, () => 1), 300);
  assert.equal(backoffMs(3, policy, () => 1), 2400);
  assert.equal(backoffMs(10, policy, () => 1), 4000, 'capped');
  assert.equal(backoffMs(2, policy, () => 0), 0, 'jitter can be zero');
  assert.equal(backoffMs(5, { baseDelayMs: 0, maxDelayMs: 0 }), 0);
});

test('parkFor gives a planning or tool failure the same park a step would get, and null for a fault that is ours', () => {
  assert.equal(parkFor({ class: 'permanent' }, 0), null);
  assert.equal(parkFor({ class: 'malformed_output' }, 0), null);
  const p = parkFor({ class: 'provider_down' }, 1);
  assert.deepEqual([p.reason, p.wakeInMs], ['provider', PARK_BACKOFF_MS[1]]);
  const q = parkFor({ class: 'rate_limited', retryAfterMs: 120_000 }, 0);
  assert.deepEqual([q.reason, q.wakeInMs], ['provider', 120_000], 'a Retry-After wins over the ladder');
  assert.equal(parkFor({ class: 'budget_exhausted' }, 0).reason, 'quota');
});
