import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_STATUSES, TRANSITIONS, TERMINAL_STATUSES, transition, canTransition, isTerminal, effectivePriority, IllegalTransitionError } from '../src/task/lifecycle.js';
import { taskDefaults } from '../src/state/schema.js';

function task(status = 'pending', extra = {}) {
  return { ...taskDefaults(), id: 't1', type: 'task', title: 't', prompt: 'p', status, createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

const clock = () => new Date('2026-01-01T01:00:00.000Z');

test('the transition table covers every status exactly once and names only real statuses', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...TASK_STATUSES].sort());
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) assert.ok(TASK_STATUSES.includes(to), `${from} -> ${to}`);
    assert.ok(!targets.includes(from), `${from} must not transition to itself`);
  }
});

test('every non-terminal status has an exit, and every terminal status can only be retried', () => {
  for (const s of TASK_STATUSES) {
    if (isTerminal(s)) {
      assert.deepEqual(TRANSITIONS[s], ['pending'], s);
    } else {
      assert.ok(TRANSITIONS[s].length >= 2, `${s} needs more than one exit`);
      // Each non-terminal status must be able to end without a model or a
      // human: a timeout/expiry path to a terminal status.
      const hasTimeoutExit = TRANSITIONS[s].some((t) => ['expired', 'dead-lettered', 'cancelled', 'failed'].includes(t));
      assert.ok(hasTimeoutExit, `${s} has no timeout exit`);
    }
  }
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['blocked', 'cancelled', 'complete', 'dead-lettered', 'expired', 'failed']);
});

test('no illegal transition is reachable: every pair not in the table throws and leaves the task untouched', () => {
  let illegal = 0;
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      if (canTransition(from, to)) continue;
      const t = task(from, { history: [] });
      const before = JSON.stringify(t);
      assert.throws(() => transition(t, to, { now: clock, waitReason: 'backoff' }), IllegalTransitionError, `${from} -> ${to}`);
      assert.equal(JSON.stringify(t), before, `${from} -> ${to} mutated the task`);
      illegal += 1;
    }
  }
  assert.ok(illegal > 60, `expected most pairs to be illegal, got ${illegal}`);
  assert.throws(() => transition(task('pending'), 'nonsense', { now: clock }), IllegalTransitionError);
});

test('a legal transition stamps timestamps, clears the lease on terminal, records history, and emits an event', () => {
  const events = [];
  const t = task('pending', { lease: { owner: 'x', acquiredAt: 'a', expiresAt: 'b' } });
  transition(t, 'running', { now: clock, events: { append: (type, f) => events.push({ type, ...f }) }, reason: 'claimed', by: 'pulse-1' });
  assert.equal(t.status, 'running');
  assert.equal(t.startedAt, '2026-01-01T01:00:00.000Z');
  transition(t, 'complete', { now: clock, events: { append: (type, f) => events.push({ type, ...f }) }, reason: 'done' });
  assert.equal(t.completedAt, '2026-01-01T01:00:00.000Z');
  assert.equal(t.lease, null);
  assert.deepEqual(t.history.map((h) => `${h.from}>${h.to}`), ['pending>running', 'running>complete']);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'task.transition');
  assert.equal(events[1].outcome, 'complete');
  assert.equal(events[0].by, 'pulse-1');
});

test('waiting requires a wait reason and records wakeAt; leaving waiting clears both', () => {
  const t = task('pending');
  assert.throws(() => transition(t, 'waiting', { now: clock }), /waiting needs a reason/);
  transition(t, 'waiting', { now: clock, waitReason: 'backoff', wakeAt: '2026-01-01T02:00:00.000Z' });
  assert.equal(t.waitReason, 'backoff');
  assert.equal(t.wakeAt, '2026-01-01T02:00:00.000Z');
  transition(t, 'pending', { now: clock });
  assert.equal(t.waitReason, null);
  assert.equal(t.wakeAt, null);
});

test('a retry from a terminal status clears the previous run record but keeps attempts', () => {
  const t = task('failed', { attempts: 2, runId: 'r', error: 'boom', completedAt: 'x', failure: { class: 'permanent' } });
  transition(t, 'pending', { now: clock, reason: 'retry' });
  assert.equal(t.runId, null);
  assert.equal(t.error, null);
  assert.equal(t.failure, null);
  assert.equal(t.completedAt, null);
  assert.equal(t.attempts, 2);
});

test('history is bounded', () => {
  const t = task('pending');
  for (let i = 0; i < 60; i += 1) {
    transition(t, 'paused', { now: clock });
    transition(t, 'pending', { now: clock });
  }
  assert.ok(t.history.length <= 40);
});

test('effective priority: urgent > high > normal > low; age, deadline, and dependents raise it; a category gap is never crossed by age alone', () => {
  const now = () => new Date('2026-01-10T00:00:00.000Z');
  const p = (extra) => effectivePriority(task('pending', extra), { now });
  assert.ok(p({ priority: 'urgent' }) > p({ priority: 'high' }));
  assert.ok(p({ priority: 'high' }) > p({ priority: 'normal' }));
  assert.ok(p({ priority: 'normal' }) > p({ priority: 'low' }));
  const fresh = p({ priority: 'normal', createdAt: '2026-01-10T00:00:00.000Z' });
  const old = p({ priority: 'normal', createdAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(old > fresh, 'age boosts');
  assert.ok(old - fresh <= 10, 'age boost is capped');
  assert.ok(p({ priority: 'normal', deadline: '2026-01-10T00:30:00.000Z' }) > p({ priority: 'high' }), 'an imminent deadline outranks high');
  assert.ok(effectivePriority(task('pending'), { now, dependents: 3 }) > effectivePriority(task('pending'), { now, dependents: 0 }));
});
