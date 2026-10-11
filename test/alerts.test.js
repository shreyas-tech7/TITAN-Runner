import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { ensureAlert, resolveAlert } from '../src/ops/alerts.js';

const alert = { label: 'host-alert', title: 'Host down: hf-space', body: 'The host hf-space failed 2 checks in a row.' };

test('ensureAlert opens one Issue and never a second one for the same title', async () => {
  const gh = new FakeGitHub({ fixture: { issues: [] } });
  const first = await ensureAlert(gh, alert);
  assert.equal(first.action, 'opened');
  const again = await ensureAlert(gh, alert);
  assert.deepEqual(again, { action: 'exists', number: first.number });
  assert.equal(gh.counts().createIssue, 1);
  const other = await ensureAlert(gh, { ...alert, title: 'Host down: render-1' });
  assert.equal(other.action, 'opened');
  assert.equal(gh.data.issues.length, 2);
});

test('resolveAlert comments once, closes the Issue, and does nothing when no Issue is open', async () => {
  const gh = new FakeGitHub({ fixture: { issues: [] } });
  assert.deepEqual(await resolveAlert(gh, { label: alert.label, title: alert.title, comment: 'Back up.' }), { action: 'none', number: null });
  const { number } = await ensureAlert(gh, alert);
  const res = await resolveAlert(gh, { label: alert.label, title: alert.title, comment: 'The host is back up.' });
  assert.deepEqual(res, { action: 'closed', number });
  const issue = gh.data.issues.find((i) => i.number === number);
  assert.equal(issue.state, 'closed');
  assert.equal(issue.comments.length, 1);
  // A new failure opens a new Issue, because the old one is closed.
  const reopened = await ensureAlert(gh, alert);
  assert.equal(reopened.action, 'opened');
  assert.notEqual(reopened.number, number);
});

test('an alert is only found by its label and its exact title, and a pull request never counts', async () => {
  const gh = new FakeGitHub({ fixture: { issues: [{ number: 5, title: alert.title, state: 'open', labels: [{ name: 'other-label' }] }, { number: 6, title: alert.title, state: 'open', labels: [{ name: 'host-alert' }], pull_request: {} }] } });
  const res = await ensureAlert(gh, alert);
  assert.equal(res.action, 'opened');
});
