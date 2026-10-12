import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedIssueAuthor, TRUSTED_ASSOCIATIONS } from '../src/tasks.js';

const env = { GITHUB_OWNER: 'Owner-Login' };
const optIn = { ...env, TITAN_TRUST_COLLABORATORS: '1' };

test('by default only the owner and the allowlist are trusted. A collaborator is not (RT2)', () => {
  assert.equal(isTrustedIssueAuthor({ user: { login: 'owner-login' }, author_association: 'NONE' }, env), true);
  for (const a of TRUSTED_ASSOCIATIONS) {
    assert.equal(isTrustedIssueAuthor({ user: { login: 'x' }, author_association: a }, env), false, a);
  }
  const listed = { ...env, TITAN_TASK_AUTHORS: 'Friend, @other' };
  assert.equal(isTrustedIssueAuthor({ user: { login: 'friend' }, author_association: 'NONE' }, listed), true);
  assert.equal(isTrustedIssueAuthor({ user: { login: 'other' }, author_association: 'NONE' }, listed), true);
  assert.equal(isTrustedIssueAuthor({ user: { login: 'stranger' }, author_association: 'NONE' }, listed), false);
});

test('with TITAN_TRUST_COLLABORATORS=1 the GitHub associations count; strangers, contributors, and bots still do not', () => {
  assert.equal(isTrustedIssueAuthor({ user: { login: 'owner-login' }, author_association: 'NONE' }, optIn), true);
  for (const a of TRUSTED_ASSOCIATIONS) {
    assert.equal(isTrustedIssueAuthor({ user: { login: 'x' }, author_association: a }, optIn), true, a);
  }
  for (const a of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER', '', undefined]) {
    assert.equal(isTrustedIssueAuthor({ user: { login: 'x' }, author_association: a }, optIn), false, String(a));
  }
  assert.equal(isTrustedIssueAuthor({ user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'OWNER' }, optIn), false);
  assert.equal(isTrustedIssueAuthor({ user: null, author_association: 'OWNER' }, optIn), false);
});
