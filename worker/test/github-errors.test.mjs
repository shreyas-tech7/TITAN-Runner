// Covers describeGithubFailure() — the error path behind the reported
// "failed to set GROQ_API_KEY: GitHub public-key fetch failed: 403" bug.
// Before this, ghGetPublicKey()/ghPutSecret() threw a bare `${res.status}`
// with no way to tell an expired/under-scoped GITHUB_PAT apart from a wrong
// GITHUB_OWNER/GITHUB_REPO or a genuine outage. These tests build a fake
// GitHub API `Response` (status/headers/body, no live network needed — same
// reasoning as sealedbox.test.mjs for not hitting a real GitHub secret) and
// assert the message actually distinguishes those cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGithubFailure } from '../src/index.js';

function fakeGithubResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('403 (insufficient PAT permission) names the fix, not just the status code', async () => {
  const res = fakeGithubResponse(
    403,
    { message: 'Resource not accessible by personal access token' },
    { 'x-github-request-id': 'ABCD:1234:E5F6:789A:0001' },
  );
  const message = await describeGithubFailure('GitHub public-key fetch', res);
  assert.match(message, /GitHub public-key fetch failed: 403/);
  assert.match(message, /Secrets.*permission|repo.*scope/i);
  assert.match(message, /request-id: ABCD:1234:E5F6:789A:0001/);
  assert.match(message, /Resource not accessible by personal access token/);
});

test('401 (expired/revoked token) gets its own hint, distinct from 403', async () => {
  const res = fakeGithubResponse(401, { message: 'Bad credentials' });
  const message = await describeGithubFailure('GitHub public-key fetch', res);
  assert.match(message, /GitHub public-key fetch failed: 401/);
  assert.match(message, /expired, or revoked/);
});

test('404 (wrong owner/repo, or PAT cannot see the repo) gets its own hint', async () => {
  const res = fakeGithubResponse(404, { message: 'Not Found' });
  const message = await describeGithubFailure('GitHub secret PUT', res);
  assert.match(message, /GitHub secret PUT failed: 404/);
  assert.match(message, /GITHUB_OWNER\/GITHUB_REPO/);
});

test('an unrecognized status still reports status and body, with no hint text', async () => {
  const res = fakeGithubResponse(503, { message: 'Service unavailable' });
  const message = await describeGithubFailure('GitHub public-key fetch', res);
  assert.equal(message, 'GitHub public-key fetch failed: 503 — {"message":"Service unavailable"}');
});

test('never includes an Authorization header value, even if present on the response', async () => {
  // Defense in depth: GitHub's API never echoes the Authorization header
  // back, but if a future change ever passed request headers in here by
  // mistake, this test would catch a leaked PAT before it reached a log
  // line or an API response.
  const res = fakeGithubResponse(403, { message: 'nope' }, { authorization: 'Bearer ghp_should_never_appear' });
  const message = await describeGithubFailure('GitHub public-key fetch', res);
  assert.ok(!message.includes('ghp_should_never_appear'));
});
