import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileIssueState, selectClaims } from '../src/issueSync.js';

function task(overrides) {
  return {
    id: `issue-${overrides.issueNumber}`,
    type: 'task',
    issueNumber: overrides.issueNumber,
    issueUrl: `https://github.com/x/y/issues/${overrides.issueNumber}`,
    title: 't',
    prompt: 'p',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    claimedAt: null,
    startedAt: null,
    completedAt: null,
    runId: 'run-1',
    prNumber: null,
    prUrl: null,
    error: null,
    ...overrides,
  };
}

test('a still-pending task whose issue is no longer open is cancelled (dashboard "Cancel")', () => {
  const state = { tasks: [task({ issueNumber: 1, status: 'pending' })] };
  const result = reconcileIssueState(state, []); // issue 1 not in the open set
  assert.equal(result.cancelled, 1);
  assert.equal(result.retried, 0);
  assert.equal(state.tasks[0].status, 'cancelled');
  assert.ok(state.tasks[0].completedAt);
  assert.match(state.tasks[0].error, /Cancelled from the dashboard/);
});

test('a pending task whose issue is still open is left completely alone', () => {
  const state = { tasks: [task({ issueNumber: 1, status: 'pending' })] };
  const result = reconcileIssueState(state, [{ number: 1, updated_at: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(result.cancelled, 0);
  assert.equal(state.tasks[0].status, 'pending');
});

test('a completed task reopened and updated after completion is reset to pending (dashboard "Retry")', () => {
  const state = {
    tasks: [task({ issueNumber: 2, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z', error: 'boom', runId: 'old-run' })],
  };
  const result = reconcileIssueState(state, [{ number: 2, updated_at: '2026-01-01T00:05:00.000Z' }]);
  assert.equal(result.retried, 1);
  const t = state.tasks[0];
  assert.equal(t.status, 'pending');
  assert.equal(t.completedAt, null);
  assert.equal(t.error, null);
  assert.equal(t.runId, null);
});

test('a completed task whose issue is open but was NOT updated since completion is left alone (not a retry)', () => {
  const state = {
    tasks: [task({ issueNumber: 3, status: 'complete', completedAt: '2026-01-01T00:10:00.000Z' })],
  };
  // updated_at predates completedAt — this issue was open all along, no retry signal.
  const result = reconcileIssueState(state, [{ number: 3, updated_at: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(result.retried, 0);
  assert.equal(state.tasks[0].status, 'complete');
});

test('a manual task (no issueNumber) is never touched by reconciliation', () => {
  const state = { tasks: [task({ issueNumber: null, status: 'pending' })] };
  const result = reconcileIssueState(state, []);
  assert.equal(result.cancelled, 0);
  assert.equal(result.retried, 0);
  assert.equal(state.tasks[0].status, 'pending');
});

test('a blocked (Reviewer Gate) task can also be retried once its issue is reopened and updated', () => {
  const state = {
    tasks: [task({ issueNumber: 4, status: 'blocked', completedAt: '2026-01-01T00:00:00.000Z', error: 'Blocked by the Reviewer Gate.' })],
  };
  const result = reconcileIssueState(state, [{ number: 4, updated_at: '2026-01-01T01:00:00.000Z' }]);
  assert.equal(result.retried, 1);
  assert.equal(state.tasks[0].status, 'pending');
});

test('retryCount increments on each dashboard retry and is preserved', () => {
  const state = { tasks: [task({ issueNumber: 5, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z' })] };
  reconcileIssueState(state, [{ number: 5, updated_at: '2026-01-01T00:05:00.000Z' }]);
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(state.tasks[0].retryCount, 1);
});

test('a task retried past the cap stops being reset to pending and fails loudly instead', () => {
  const state = { tasks: [task({ issueNumber: 6, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z', retryCount: 3 })] };
  const result = reconcileIssueState(state, [{ number: 6, updated_at: '2026-01-01T00:05:00.000Z' }]);
  assert.equal(result.retried, 1);
  const t = state.tasks[0];
  assert.equal(t.status, 'failed'); // NOT reset to pending
  assert.equal(t.retryCount, 4);
  assert.match(t.error, /Retry limit reached/);
});

test('selectClaims orders by priority (high > normal > low) then FIFO by createdAt', () => {
  const base = (id, priority, createdAt) => ({ id, priority, createdAt, status: 'pending' });
  const tasks = [
    base('low-new', 'low', '2026-01-03T00:00:00.000Z'),
    base('high-old', 'high', '2026-01-01T00:00:00.000Z'),
    base('normal-a', 'normal', '2026-01-02T00:00:00.000Z'),
    base('high-new', 'high', '2026-01-04T00:00:00.000Z'),
  ];
  const { claims, expired } = selectClaims(tasks, { max: 10 });
  assert.equal(expired.length, 0);
  assert.deepEqual(claims.map((t) => t.id), ['high-old', 'high-new', 'normal-a', 'low-new']);
});

test('selectClaims honours the max slice', () => {
  const base = (id, priority, createdAt) => ({ id, priority, createdAt, status: 'pending' });
  const tasks = [base('a', 'high', '2026-01-01T00:00:00.000Z'), base('b', 'high', '2026-01-02T00:00:00.000Z')];
  const { claims } = selectClaims(tasks, { max: 1 });
  assert.deepEqual(claims.map((t) => t.id), ['a']);
});

test('selectClaims expires a stale pending task only when a TTL is configured', () => {
  const now = Date.parse('2026-01-10T00:00:00.000Z');
  const pending = { id: 'old', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' };
  const fresh = { id: 'fresh', status: 'pending', createdAt: '2026-01-09T23:00:00.000Z' };

  // No TTL: nothing expires (the pre-TTL behaviour).
  const noTtl = selectClaims([{ ...pending }, { ...fresh }], { max: 10, ttlMs: 0, now });
  assert.equal(noTtl.expired.length, 0);

  // With a 24h TTL, only the old task expires (mutated to failed in place).
  const withTtl = selectClaims([{ ...pending }, { ...fresh }], { max: 10, ttlMs: 24 * 3_600_000, now });
  assert.equal(withTtl.expired.length, 1);
  assert.equal(withTtl.expired[0].id, 'old');
  assert.equal(withTtl.expired[0].status, 'failed');
  assert.match(withTtl.expired[0].error, /Expired/);
  assert.deepEqual(withTtl.claims.map((t) => t.id), ['fresh']);
});

