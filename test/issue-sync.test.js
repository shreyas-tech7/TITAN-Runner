import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileIssueState, processTitanCommands } from '../src/issueSync.js';

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

test('a needs-human task (status "review") is reset to pending once titan-approved is added — the human approval gate', () => {
  const state = { tasks: [task({ issueNumber: 5, status: 'review' })] };
  const withoutApproval = reconcileIssueState(state, [{ number: 5, labels: [{ name: 'titan-task' }, { name: 'titan-review' }] }]);
  assert.equal(withoutApproval.approved, 0);
  assert.equal(state.tasks[0].status, 'review', 'must not proceed without titan-approved');

  const result = reconcileIssueState(state, [
    { number: 5, labels: [{ name: 'titan-task' }, { name: 'titan-review' }, { name: 'titan-approved' }] },
  ]);
  assert.equal(result.approved, 1);
  assert.equal(state.tasks[0].status, 'pending');
});

test('a needs-human task also accepts plain-string labels, not just {name} objects', () => {
  const state = { tasks: [task({ issueNumber: 6, status: 'review' })] };
  const result = reconcileIssueState(state, [{ number: 6, labels: ['titan-task', 'titan-approved'] }]);
  assert.equal(result.approved, 1);
  assert.equal(state.tasks[0].status, 'pending');
});

function fakeDeps({ comments = [], owner = 'shreyas-tech7' } = {}) {
  const posted = [];
  const labeled = [];
  return {
    deps: {
      listIssueComments: async () => comments,
      commentOnIssue: async (number, body) => { posted.push({ number, body }); return null; },
      addLabels: async (number, labels) => { labeled.push({ number, labels }); return null; },
      repoOwnerLogin: () => owner,
    },
    posted,
    labeled,
  };
}

test('/titan cancel from the repo owner cancels a pending task and labels it titan-cancelled', async () => {
  const t = task({ issueNumber: 10, status: 'pending' });
  const { deps, posted, labeled } = fakeDeps({
    comments: [{ user: { login: 'shreyas-tech7' }, body: '/titan cancel', created_at: '2026-02-01T00:00:00.000Z' }],
  });
  const result = await processTitanCommands(t, deps);
  assert.equal(result.action, 'cancel');
  assert.equal(t.status, 'cancelled');
  assert.deepEqual(labeled[0].labels, ['titan-cancelled']);
  assert.equal(posted.length, 1);
});

test('/titan cancel from someone who is NOT the repo owner is ignored entirely', async () => {
  const t = task({ issueNumber: 11, status: 'pending' });
  const { deps, posted } = fakeDeps({
    comments: [{ user: { login: 'some-random-user' }, body: '/titan cancel', created_at: '2026-02-01T00:00:00.000Z' }],
  });
  const result = await processTitanCommands(t, deps);
  assert.equal(result.action, null);
  assert.equal(t.status, 'pending');
  assert.equal(posted.length, 0);
});

test('/titan retry resets a terminal task to pending', async () => {
  const t = task({ issueNumber: 12, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z', error: 'boom' });
  const { deps } = fakeDeps({
    comments: [{ user: { login: 'shreyas-tech7' }, body: '/titan retry', created_at: '2026-02-01T00:00:00.000Z' }],
  });
  const result = await processTitanCommands(t, deps);
  assert.equal(result.action, 'retry');
  assert.equal(t.status, 'pending');
  assert.equal(t.error, null);
});

test('/titan status never changes the task, only posts a comment', async () => {
  const t = task({ issueNumber: 13, status: 'running', runId: 'run-xyz' });
  const { deps, posted } = fakeDeps({
    comments: [{ user: { login: 'shreyas-tech7' }, body: '/titan status', created_at: '2026-02-01T00:00:00.000Z' }],
  });
  const result = await processTitanCommands(t, deps);
  assert.equal(result.action, 'status');
  assert.equal(t.status, 'running');
  assert.match(posted[0].body, /run-xyz/);
});

test('a command already processed (older than lastCommandProcessedAt) is never re-applied', async () => {
  const t = task({ issueNumber: 14, status: 'pending', lastCommandProcessedAt: '2026-02-01T00:05:00.000Z' });
  const { deps, posted } = fakeDeps({
    comments: [{ user: { login: 'shreyas-tech7' }, body: '/titan cancel', created_at: '2026-02-01T00:00:00.000Z' }],
  });
  const result = await processTitanCommands(t, deps);
  assert.equal(result.action, null);
  assert.equal(t.status, 'pending');
  assert.equal(posted.length, 0);
});

test('a comment that merely mentions /titan cancel mid-sentence is not treated as a command', async () => {
  const t = task({ issueNumber: 15, status: 'pending' });
  const { deps } = fakeDeps({
    comments: [{ user: { login: 'shreyas-tech7' }, body: 'I was thinking about /titan cancel but not yet', created_at: '2026-02-01T00:00:00.000Z' }],
  });
  const result = await processTitanCommands(t, deps);
  assert.equal(result.action, null);
  assert.equal(t.status, 'pending');
});

test('when multiple commands arrive, only the most recent one is applied', async () => {
  const t = task({ issueNumber: 16, status: 'pending' });
  const { deps } = fakeDeps({
    comments: [
      { user: { login: 'shreyas-tech7' }, body: '/titan cancel', created_at: '2026-02-01T00:00:00.000Z' },
      { user: { login: 'shreyas-tech7' }, body: '/titan status', created_at: '2026-02-01T00:01:00.000Z' },
    ],
  });
  const result = await processTitanCommands(t, deps);
  assert.equal(result.action, 'status');
  assert.equal(t.status, 'pending', 'the earlier cancel must not have been applied');
});
