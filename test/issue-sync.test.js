import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileIssueState } from '../src/issueSync.js';

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
