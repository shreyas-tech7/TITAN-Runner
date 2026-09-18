import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SideEffectLedger, markerFor } from '../src/engine/sideEffects.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';

function github() {
  return new FakeGitHub({ fixture: { issues: [{ number: 1, title: 't', body: 'b', user: { login: 'o' }, author_association: 'OWNER', updated_at: '2026-01-01T00:00:00.000Z' }] } });
}

test('a comment fires once per key; the ledger records it; a second call with the same key is skipped', async () => {
  const gh = github();
  const recorded = [];
  const ledger = new SideEffectLedger({ github: gh, ledger: {}, onRecord: (k) => recorded.push(k) });
  assert.equal(await ledger.comment(1, 'done:r1', 'hello'), 'posted');
  assert.equal(await ledger.comment(1, 'done:r1', 'hello'), 'skipped-ledger');
  assert.equal(gh.counts().commentOnIssue, 1);
  assert.deepEqual(recorded, ['done:r1']);
  const posted = gh.data.issues[0].comments[0].body;
  assert.ok(posted.endsWith(markerFor('done:r1')));
});

test('after a crash between the comment landing and the ledger being saved, the re-run finds the marker on GitHub and does not post again', async () => {
  const gh = github();
  // First life: comment landed, ledger write "lost" (we simulate by not carrying it over)...
  const life1 = new SideEffectLedger({ github: gh, ledger: {} });
  await life1.comment(1, 'done:r1', 'hello');
  // ...but at least one other key had been ledgered before, which is what a resumed checkpoint looks like.
  const life2 = new SideEffectLedger({ github: gh, ledger: { 'gate:r1': '2026-01-01T00:00:00.000Z' } });
  assert.equal(await life2.comment(1, 'done:r1', 'hello'), 'skipped-remote');
  assert.equal(gh.counts().commentOnIssue, 1, 'no duplicate comment');
  assert.ok(life2.has('done:r1'), 'ledger back-filled');
});

test('closeIssue and once() are keyed the same way; a null issue number is a no-op', async () => {
  const gh = github();
  const ledger = new SideEffectLedger({ github: gh, ledger: {} });
  assert.equal(await ledger.closeIssue(1, 'close:r1'), 'closed');
  assert.equal(await ledger.closeIssue(1, 'close:r1'), 'skipped-ledger');
  assert.equal(await ledger.comment(null, 'x', 'y'), 'noop');
  let ran = 0;
  const first = await ledger.once('pr:r1', async () => { ran += 1; return 42; });
  const second = await ledger.once('pr:r1', async () => { ran += 1; return 43; });
  assert.deepEqual([first.ran, first.result, second.ran, ran], [true, 42, false, 1]);
});
