import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeActor, authorizationContextFrom, parseLoginList, TRUSTED_ASSOCIATIONS } from '../src/security/authorization.js';
import { syncIssuesIntoTasks } from '../src/issueSync.js';

const ctx = authorizationContextFrom({ repository: 'Owner-Login/TITAN-Runner', taskAuthors: ['trusted-friend'], trustCollaborators: true });

test('the repository owner is always authorized, case-insensitively', () => {
  assert.equal(authorizeActor({ user: { login: 'owner-login' }, author_association: 'NONE' }, ctx).ok, true);
  assert.equal(authorizeActor({ user: { login: 'OWNER-LOGIN' }, author_association: 'NONE' }, ctx).ok, true);
});

test('an allowlisted login is authorized regardless of association', () => {
  const r = authorizeActor({ user: { login: 'Trusted-Friend' }, author_association: 'NONE' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.reason, /allowlist/);
});

test('GitHub-computed OWNER/MEMBER/COLLABORATOR associations are trusted; CONTRIBUTOR/FIRST_TIMER/NONE are not', () => {
  for (const a of TRUSTED_ASSOCIATIONS) {
    assert.equal(authorizeActor({ user: { login: 'someone' }, author_association: a }, ctx).ok, true, a);
  }
  for (const a of ['CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'NONE', 'MANNEQUIN', '', undefined, 'owner; DROP TABLE']) {
    assert.equal(authorizeActor({ user: { login: 'someone' }, author_association: a }, ctx).ok, false, String(a));
  }
});

test('with TITAN_TRUST_COLLABORATORS=0 only the owner and the allowlist count', () => {
  const strict = authorizationContextFrom({ repository: 'owner-login/r', taskAuthors: [], trustCollaborators: false });
  assert.equal(authorizeActor({ user: { login: 'someone' }, author_association: 'COLLABORATOR' }, strict).ok, false);
  assert.equal(authorizeActor({ user: { login: 'owner-login' }, author_association: 'NONE' }, strict).ok, true);
});

test('bot accounts are never authorized, even if allowlisted, and a missing login is rejected', () => {
  const botCtx = authorizationContextFrom({ repository: 'owner/r', taskAuthors: ['github-actions[bot]'] });
  assert.equal(authorizeActor({ user: { login: 'github-actions[bot]' }, author_association: 'OWNER' }, botCtx).ok, false);
  assert.equal(authorizeActor({ user: { login: 'anything', type: 'Bot' }, author_association: 'OWNER' }, botCtx).ok, false);
  assert.equal(authorizeActor({ user: null, author_association: 'OWNER' }, ctx).ok, false);
  assert.equal(authorizeActor({}, ctx).ok, false);
});

test('parseLoginList tolerates commas, spaces, @-prefixes, and duplicates', () => {
  assert.deepEqual(parseLoginList(' @Alice, bob  bob,,@Carol '), ['alice', 'bob', 'carol']);
  assert.deepEqual(parseLoginList(undefined), []);
});

function issue(number, overrides = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Do thing ${number}`,
    html_url: `https://github.com/owner-login/r/issues/${number}`,
    updated_at: '2026-01-01T00:00:00.000Z',
    labels: [{ name: 'titan-task' }],
    user: { login: 'stranger' },
    author_association: 'NONE',
    ...overrides,
  };
}

test('intake: unauthorized issues are ignored (no task, no model call), authorized ones become tasks, PRs are skipped', async () => {
  const state = { tasks: [] };
  const issues = [
    issue(1), // stranger
    issue(2, { user: { login: 'owner-login' }, author_association: 'OWNER' }),
    issue(3, { user: { login: 'colleague' }, author_association: 'COLLABORATOR' }),
    issue(4, { user: { login: 'owner-login' }, author_association: 'OWNER', pull_request: { url: 'x' } }),
    issue(5, { user: { login: 'contrib' }, author_association: 'CONTRIBUTOR' }),
  ];
  const result = await syncIssuesIntoTasks(state, { listIssues: async () => issues, authz: ctx });
  assert.equal(result.added, 2);
  assert.equal(result.ignored, 2);
  assert.deepEqual(result.ignoredIssues, [1, 5]);
  assert.deepEqual(state.tasks.map((t) => t.id), ['issue-2', 'issue-3']);
  assert.equal(state.tasks[0].author, 'owner-login');
  assert.equal(state.tasks[0].status, 'pending');
});

test('intake: an ignored issue is not remembered as a task, so a later authorized edit cannot be confused with it', async () => {
  const state = { tasks: [] };
  await syncIssuesIntoTasks(state, { listIssues: async () => [issue(9)], authz: ctx });
  assert.equal(state.tasks.length, 0);
  // Same number, now filed by the owner (e.g. the stranger's issue was closed and the owner re-filed).
  await syncIssuesIntoTasks(state, { listIssues: async () => [issue(9, { user: { login: 'owner-login' }, author_association: 'OWNER' })], authz: ctx });
  assert.equal(state.tasks.length, 1);
});
