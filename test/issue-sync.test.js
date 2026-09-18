import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileIssueState } from '../src/issueSync.js';
import { authorizationContextFrom } from '../src/security/authorization.js';

const authz = authorizationContextFrom({ repository: 'owner-login/r', taskAuthors: [], trustCollaborators: true });

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

const ownerRetry = { body: '/titan retry', created_at: '2026-01-01T00:04:00.000Z', user: { login: 'owner-login' }, author_association: 'OWNER' };
const strangerRetry = { body: '/titan retry', created_at: '2026-01-01T00:04:00.000Z', user: { login: 'stranger' }, author_association: 'NONE' };

test('a still-pending task whose issue is no longer open is cancelled (dashboard "Cancel")', async () => {
  const state = { tasks: [task({ issueNumber: 1, status: 'pending' })] };
  const result = await reconcileIssueState(state, [], { authz, listComments: async () => [] }); // issue 1 not in the open set
  assert.equal(result.cancelled, 1);
  assert.equal(result.retried, 0);
  assert.equal(state.tasks[0].status, 'cancelled');
  assert.ok(state.tasks[0].completedAt);
  assert.match(state.tasks[0].error, /Cancelled from the dashboard/);
});

test('a pending task whose issue is still open is left completely alone', async () => {
  const state = { tasks: [task({ issueNumber: 1, status: 'pending' })] };
  const result = await reconcileIssueState(state, [{ number: 1, updated_at: '2026-01-01T00:00:00.000Z' }], { authz, listComments: async () => [] });
  assert.equal(result.cancelled, 0);
  assert.equal(state.tasks[0].status, 'pending');
});

test('a completed task with an authorized /titan retry comment after completion is reset to pending (dashboard "Retry")', async () => {
  const state = {
    tasks: [task({ issueNumber: 2, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z', error: 'boom', runId: 'old-run' })],
  };
  let since = null;
  const result = await reconcileIssueState(state, [{ number: 2, updated_at: '2026-01-01T00:05:00.000Z' }], {
    authz,
    listComments: async (_n, opts) => { since = opts.since; return [ownerRetry]; },
  });
  assert.equal(result.retried, 1);
  assert.equal(since, '2026-01-01T00:00:00.000Z');
  const t = state.tasks[0];
  assert.equal(t.status, 'pending');
  assert.equal(t.completedAt, null);
  assert.equal(t.error, null);
  assert.equal(t.runId, null);
  assert.equal(t.retriedBy, 'owner-login');
});

test('the dashboard retry marker comment counts as /titan retry when its author is authorized', async () => {
  const state = { tasks: [task({ issueNumber: 2, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z' })] };
  const marker = { ...ownerRetry, body: '**Retry requested** from the TITAN-Runner dashboard. This issue was reopened for the next pulse to pick up again.' };
  const result = await reconcileIssueState(state, [{ number: 2, updated_at: '2026-01-01T00:05:00.000Z' }], { authz, listComments: async () => [marker] });
  assert.equal(result.retried, 1);
});

test("a stranger's comment (even a literal /titan retry) never re-queues a finished task", async () => {
  const state = { tasks: [task({ issueNumber: 2, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z', error: 'boom' })] };
  const result = await reconcileIssueState(state, [{ number: 2, updated_at: '2026-01-01T00:05:00.000Z' }], {
    authz,
    listComments: async () => [strangerRetry, { ...strangerRetry, body: 'retry please' }],
  });
  assert.equal(result.retried, 0);
  assert.equal(result.rejectedCommands, 1);
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(state.tasks[0].error, 'boom');
});

test('an updated_at bump with no command is examined once, not on every pulse', async () => {
  const state = { tasks: [task({ issueNumber: 2, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z' })] };
  let fetches = 0;
  const deps = { authz, listComments: async () => { fetches += 1; return [{ body: 'nice work', created_at: '2026-01-01T00:05:00.000Z', user: { login: 'stranger' }, author_association: 'NONE' }]; } };
  const open = [{ number: 2, updated_at: '2026-01-01T00:05:00.000Z' }];
  await reconcileIssueState(state, open, deps);
  await reconcileIssueState(state, open, deps);
  assert.equal(fetches, 1);
  assert.equal(state.tasks[0].issueUpdatedAtSeen, '2026-01-01T00:05:00.000Z');
  // A newer bump is examined again.
  await reconcileIssueState(state, [{ number: 2, updated_at: '2026-01-01T00:06:00.000Z' }], deps);
  assert.equal(fetches, 2);
});

test('an authorized retry command posted BEFORE the task finished does not count', async () => {
  const state = { tasks: [task({ issueNumber: 2, status: 'failed', completedAt: '2026-01-01T00:10:00.000Z' })] };
  const result = await reconcileIssueState(state, [{ number: 2, updated_at: '2026-01-01T00:11:00.000Z' }], {
    authz,
    listComments: async () => [{ ...ownerRetry, created_at: '2026-01-01T00:09:00.000Z' }],
  });
  assert.equal(result.retried, 0);
});

test('a completed task whose issue is open but was NOT updated since completion is left alone (no comments fetched)', async () => {
  const state = { tasks: [task({ issueNumber: 3, status: 'complete', completedAt: '2026-01-01T00:10:00.000Z' })] };
  let fetches = 0;
  const result = await reconcileIssueState(state, [{ number: 3, updated_at: '2026-01-01T00:00:00.000Z' }], { authz, listComments: async () => { fetches += 1; return [ownerRetry]; } });
  assert.equal(result.retried, 0);
  assert.equal(fetches, 0);
  assert.equal(state.tasks[0].status, 'complete');
});

test('a manual task (no issueNumber) is never touched by reconciliation', async () => {
  const state = { tasks: [task({ issueNumber: null, status: 'pending' })] };
  const result = await reconcileIssueState(state, [], { authz, listComments: async () => [] });
  assert.equal(result.cancelled, 0);
  assert.equal(result.retried, 0);
  assert.equal(state.tasks[0].status, 'pending');
});

test('a blocked (Reviewer Gate) task can also be retried by an authorized command', async () => {
  const state = { tasks: [task({ issueNumber: 4, status: 'blocked', completedAt: '2026-01-01T00:00:00.000Z', error: 'Blocked by the Reviewer Gate.' })] };
  const result = await reconcileIssueState(state, [{ number: 4, updated_at: '2026-01-01T01:00:00.000Z' }], { authz, listComments: async () => [ownerRetry] });
  assert.equal(result.retried, 1);
  assert.equal(state.tasks[0].status, 'pending');
});
