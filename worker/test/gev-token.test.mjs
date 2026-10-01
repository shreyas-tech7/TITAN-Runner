// Covers the God's Eye View access token: the WebCrypto minter, the GET /gev/token
// handler, and the route's admin-token gate. The format is shared with the
// TITAN-GEV gateway (a separate repo with its own node:crypto implementation),
// so the first test pins this side to the same fixture the gateway tests use.
// gev-vector.json is a copy of TITAN-GEV/test/vectors.json. It holds a public,
// non-secret fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { handleGevToken } from '../src/index.js';
import { mintGevToken } from '../src/gev-token.js';

const vector = JSON.parse(readFileSync(new URL('./gev-vector.json', import.meta.url), 'utf8'));
const SECRET = 'worker-test-secret-that-is-long-enough-000';
const ADMIN = 'test-admin-token';

/** An independent verifier written with node:crypto, not the Worker's WebCrypto path. */
function verify(secret, token) {
  const parts = token.split('.');
  assert.equal(parts.length, 5);
  const [prefix, iat, exp, jti, sig] = parts;
  assert.equal(prefix, 'gev1');
  const expected = createHmac('sha256', secret).update(`${prefix}.${iat}.${exp}.${jti}`).digest('base64url');
  return { signatureOk: sig === expected, iat: Number(iat), exp: Number(exp), jti };
}

test('reproduces the shared token fixture byte for byte', async () => {
  const { token } = await mintGevToken(vector.secret, {
    nowMs: vector.iat * 1000,
    ttlSeconds: vector.ttlSeconds,
    jti: vector.jti,
  });
  assert.equal(token, vector.token);
});

test('a minted token verifies with an independent implementation and lives 5 minutes', async () => {
  const { token, iat, exp } = await mintGevToken(SECRET);
  const parsed = verify(SECRET, token);
  assert.equal(parsed.signatureOk, true);
  assert.equal(parsed.exp - parsed.iat, 300);
  assert.equal(parsed.iat, iat);
  assert.equal(parsed.exp, exp);
  assert.equal(verify('a-different-secret-that-is-also-long-0000', token).signatureOk, false);
});

test('every token carries a fresh id', async () => {
  const first = await mintGevToken(SECRET);
  const second = await mintGevToken(SECRET);
  assert.notEqual(first.token, second.token);
  assert.notEqual(verify(SECRET, first.token).jti, verify(SECRET, second.token).jti);
});

test('handleGevToken returns a token, its expiry, and no-store caching', async () => {
  const res = await handleGevToken({ GEV_SHARED_SECRET: SECRET });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = await res.json();
  assert.equal(body.ttl_seconds, 300);
  assert.equal(verify(SECRET, body.token).signatureOk, true);
  assert.ok(Date.parse(body.expires_at) > Date.now());
  assert.equal(JSON.stringify(body).includes(SECRET), false);
});

test('handleGevToken refuses to mint without a strong secret', async () => {
  for (const GEV_SHARED_SECRET of [undefined, '', '   ', 'too-short', 12345]) {
    const res = await handleGevToken({ GEV_SHARED_SECRET });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'gev_not_configured' });
  }
});

test('GET /gev/token needs the admin token and mints only for a logged in session', async () => {
  const env = { TITAN_ADMIN_TOKEN: ADMIN, GEV_SHARED_SECRET: SECRET };
  const url = 'https://worker.example/gev/token';

  const anonymous = await worker.fetch(new Request(url), env);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.text()).includes('gev1.'), false);

  const wrong = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': 'not-the-token' } }), env);
  assert.equal(wrong.status, 401);

  const noAdminConfigured = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': '' } }), { GEV_SHARED_SECRET: SECRET });
  assert.equal(noAdminConfigured.status, 401);

  const ok = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': ADMIN } }), env);
  assert.equal(ok.status, 200);
  assert.equal(verify(SECRET, (await ok.json()).token).signatureOk, true);

  const post = await worker.fetch(new Request(url, { method: 'POST', headers: { 'X-Titan-Auth': ADMIN } }), env);
  assert.equal(post.status, 404);

  const unconfigured = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': ADMIN } }), { TITAN_ADMIN_TOKEN: ADMIN });
  assert.equal(unconfigured.status, 503);
});
