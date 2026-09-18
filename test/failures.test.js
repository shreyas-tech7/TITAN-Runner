import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, aggregateClass, FAILURE_CLASSES, PARKABLE } from '../src/reliability/failures.js';
import { POLICY } from '../src/reliability/retryPolicy.js';

test('every provider-shaped error lands in exactly one class', () => {
  const cases = [
    [{ status: 429, code: 'RATE_LIMITED', message: 'slow down', retryAfterMs: 2500 }, 'rate_limited'],
    [{ status: 503, code: 'UPSTREAM_ERROR', message: 'unavailable' }, 'provider_down'],
    [{ status: 500, message: 'boom' }, 'provider_down'],
    [{ code: 'ECONNRESET', message: 'socket hang up' }, 'provider_down'],
    [{ message: 'fetch failed' }, 'provider_down'],
    [{ status: 401, code: 'UNAUTHORIZED', message: 'bad key' }, 'permanent'],
    [{ status: 403, message: 'forbidden' }, 'permanent'],
    [{ status: 404, message: 'model not found' }, 'permanent'],
    [{ code: 'NOT_CONFIGURED', message: 'no key' }, 'permanent'],
    [{ status: 402, message: 'payment required' }, 'budget_exhausted'],
    [{ status: 400, message: 'insufficient_quota: out of credits' }, 'budget_exhausted'],
    [{ code: 'TASK_BUDGET', message: 'ceiling' }, 'budget_exhausted'],
    [{ code: 'MALFORMED_OUTPUT', message: 'bad envelope' }, 'malformed_output'],
    [{ code: 'EMPTY_OUTPUT', message: '' }, 'malformed_output'],
    [{ code: 'REFUSAL', message: 'declined' }, 'malformed_output'],
    [{ code: 'TASK_TIMEOUT', message: 'deadline of 1500ms exceeded' }, 'timeout'],
    [{ name: 'TimeoutError', message: 'timed out' }, 'timeout'],
    [{ code: 'TOOL_ERROR', message: 'tool broke' }, 'tool_error'],
    [{ code: 'GATE_BLOCK', message: 'no' }, 'policy_blocked'],
    [{ code: 'NO_PROGRESS', message: 'again' }, 'poisoned'],
    [{ code: 'CANCELLED', message: 'stopped' }, 'cancelled'],
    [{ code: 'UPSTREAM_ERROR', message: 'something odd, no status' }, 'transient'],
    ['just a string', 'transient'],
    [null, 'transient'],
  ];
  for (const [input, expected] of cases) {
    const c = classifyFailure(input);
    assert.equal(c.class, expected, `${JSON.stringify(input)} → ${c.class}, expected ${expected}`);
    assert.ok(FAILURE_CLASSES.includes(c.class));
  }
});

test('a classified error keeps status, code, Retry-After, and a bounded message', () => {
  const c = classifyFailure({ status: 429, code: 'RATE_LIMITED', message: 'x'.repeat(2000), retryAfterMs: 4000 });
  assert.deepEqual([c.status, c.code, c.retryAfterMs, c.message.length], [429, 'RATE_LIMITED', 4000, 500]);
});

test('an explicit class on the error wins, and an ALL_PROVIDERS_FAILED aggregate carries its failureClass', () => {
  assert.equal(classifyFailure({ class: 'poisoned', status: 503, message: 'x' }).class, 'poisoned');
  assert.equal(classifyFailure({ code: 'ALL_PROVIDERS_FAILED', failureClass: 'budget_exhausted', message: 'all failed' }).class, 'budget_exhausted');
  assert.equal(classifyFailure({ code: 'ALL_PROVIDERS_FAILED', message: 'all failed' }).class, 'provider_down');
  assert.equal(classifyFailure({ class: 'not-a-class', status: 503, message: 'x' }).class, 'provider_down', 'an unknown class is ignored');
});

test('the aggregate of several providers is the class that decides what to do next', () => {
  assert.equal(aggregateClass(['permanent', 'permanent']), 'permanent');
  assert.equal(aggregateClass(['permanent', 'policy_blocked']), 'permanent');
  assert.equal(aggregateClass(['budget_exhausted', 'permanent']), 'budget_exhausted');
  assert.equal(aggregateClass(['permanent', 'rate_limited', 'provider_down']), 'rate_limited', 'a limit anywhere means waiting works');
  assert.equal(aggregateClass(['provider_down', 'timeout']), 'provider_down');
  assert.equal(aggregateClass(['malformed_output', 'malformed_output']), 'malformed_output');
  assert.equal(aggregateClass(['transient', 'malformed_output']), 'transient');
  assert.equal(aggregateClass([], { skipped: 3 }), 'provider_down', 'nothing callable right now');
  assert.equal(aggregateClass([], { skipped: 0 }), 'permanent', 'nothing configured at all');
});

test('contract: every class has a retry policy, and only provider-side classes are parkable', () => {
  for (const cls of FAILURE_CLASSES) assert.ok(POLICY[cls], `no policy for ${cls}`);
  for (const cls of Object.keys(POLICY)) assert.ok(FAILURE_CLASSES.includes(cls), `policy for unknown class ${cls}`);
  assert.deepEqual(Object.keys(PARKABLE).sort(), ['budget_exhausted', 'provider_down', 'rate_limited']);
  for (const cls of ['policy_blocked', 'poisoned', 'cancelled']) assert.equal(POLICY[cls].giveUp, true, `${cls} must never be retried`);
});
