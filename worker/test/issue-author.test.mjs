import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedIssueAuthor, TRUSTED_ASSOCIATIONS } from '../src/index.js';

const env = { GITHUB_OWNER: 'Owner-Login' };

test('the repository owner and GitHub-verified collaborators are trusted; strangers, contributors, and bots are not', () => {
  assert.equal(isTrustedIssueAuthor({ user: { login: 'owner-login' }, author_association: 'NONE' }, env), true);
  for (const a of TRUSTED_ASSOCIATIONS) {
    assert.equal(isTrustedIssueAuthor({ user: { login: 'x' }, author_association: a }, env), true, a);
  }
  for (const a of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER', '', undefined]) {
    assert.equal(isTrustedIssueAuthor({ user: { login: 'x' }, author_association: a }, env), false, String(a));
  }
  assert.equal(isTrustedIssueAuthor({ user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'OWNER' }, env), false);
  assert.equal(isTrustedIssueAuthor({ user: null, author_association: 'OWNER' }, env), false);
});
