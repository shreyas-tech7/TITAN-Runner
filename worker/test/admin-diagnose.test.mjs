// Covers handleAdminDiagnose() — the GET /admin/diagnose route added so a
// human wiring up GITHUB_PAT can confirm it actually works (right scope,
// not expired, right owner/repo) before ever pasting a real provider key
// into POST /admin/keys. It reuses ghGetPublicKey() (never mutates
// anything) and describeGithubFailure() (already covered by
// github-errors.test.mjs), so these tests just check the {ok, error?}
// shape for each case, stubbing globalThis.fetch rather than hitting a
// real GitHub API (same no-live-network reasoning as sealedbox.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminDiagnose } from '../src/index.js';

function fakeEnv(overrides = {}) {
  return { GITHUB_OWNER: 'shreyas-tech7', GITHUB_REPO: 'TITAN-Runner', GITHUB_PAT: 'gh_fake_test_pat', ...overrides };
}

test('no GITHUB_PAT configured: ok:false with a clear "not configured" message, no fetch attempted', async (t) => {
  let fetchCalled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalled = true;
    throw new Error('fetch should not have been called');
  });

  const res = await handleAdminDiagnose(fakeEnv({ GITHUB_PAT: undefined }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /GITHUB_PAT is not configured/);
  assert.equal(fetchCalled, false);
});

test('a working GITHUB_PAT: ok:true', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ key: 'ZmFrZS1wdWJsaWMta2V5', key_id: '1' }), { status: 200 }),
  );

  const res = await handleAdminDiagnose(fakeEnv());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

test('a 403 (under-scoped/expired GITHUB_PAT): ok:false with the same actionable hint as describeGithubFailure()', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 }),
  );

  const res = await handleAdminDiagnose(fakeEnv());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /GitHub public-key fetch failed: 403/);
  assert.match(body.error, /Secrets.*permission|repo.*scope/i);
});
