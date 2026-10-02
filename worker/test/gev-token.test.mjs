// Covers the God's Eye View access token: the Ed25519 minter, GET /gev/token,
// GET /gev/jwks, and the route gates. The format is shared with the TITAN-GEV
// gateway (a separate repo with its own node:crypto verifier), so one test pins
// this side to the same public fixture the gateway tests use. gev-vector.json is
// a copy of TITAN-GEV/test/vectors.json. It holds a public key and a signed
// token, and no private key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { handleGevJwks, handleGevToken } from '../src/index.js';
import { mintGevToken, parseSigningJwk, signingKeyIsConsistent } from '../src/gev-token.js';

const vector = JSON.parse(readFileSync(new URL('./gev-vector.json', import.meta.url), 'utf8'));
const ADMIN = 'test-admin-token';

async function makeKey() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return crypto.subtle.exportKey('jwk', pair.privateKey);
}

/** An independent verifier written with node:crypto, not the Worker's WebCrypto path. */
function verifyToken(x, token) {
  const parts = token.split('.');
  assert.equal(parts.length, 5);
  const [prefix, iat, exp, jti, sig] = parts;
  assert.equal(prefix, 'gev2');
  const signature = Buffer.from(sig, 'base64url');
  assert.equal(signature.length, 64);
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  const signatureOk = verify(null, Buffer.from(`${prefix}.${iat}.${exp}.${jti}`), key, signature);
  return { signatureOk, iat: Number(iat), exp: Number(exp), jti };
}

test('the shared public fixture verifies with an independent implementation', () => {
  assert.equal(verifyToken(vector.publicKeyX, vector.token).signatureOk, true);
  const tampered = vector.token.replace('.1790000300.', '.1790009999.');
  assert.equal(verifyToken(vector.publicKeyX, tampered).signatureOk, false);
});

test('a minted token verifies with node:crypto and lives 5 minutes', async () => {
  const jwk = await makeKey();
  const { token, iat, exp } = await mintGevToken(jwk);
  const parsed = verifyToken(jwk.x, token);
  assert.equal(parsed.signatureOk, true);
  assert.equal(parsed.exp - parsed.iat, 300);
  assert.equal(parsed.iat, iat);
  assert.equal(parsed.exp, exp);
  const other = await makeKey();
  assert.equal(verifyToken(other.x, token).signatureOk, false);
});

test('Ed25519 signing is deterministic for a pinned payload', async () => {
  const jwk = await makeKey();
  const options = { nowMs: vector.iat * 1000, ttlSeconds: vector.ttlSeconds, jti: vector.jti };
  const first = await mintGevToken(jwk, options);
  const second = await mintGevToken(jwk, options);
  assert.equal(first.token, second.token);
  assert.equal(first.token.split('.').slice(0, 4).join('.'), vector.token.split('.').slice(0, 4).join('.'));
});

test('every token carries a fresh id', async () => {
  const jwk = await makeKey();
  const first = await mintGevToken(jwk);
  const second = await mintGevToken(jwk);
  assert.notEqual(first.token, second.token);
  assert.notEqual(verifyToken(jwk.x, first.token).jti, verifyToken(jwk.x, second.token).jti);
});

test('parseSigningJwk accepts a full Ed25519 private JWK and nothing else', async () => {
  const jwk = await makeKey();
  assert.ok(parseSigningJwk(JSON.stringify(jwk)));
  const { d, ...publicOnly } = jwk;
  const bad = [
    undefined,
    '',
    '   ',
    'not json',
    '[]',
    'null',
    JSON.stringify(publicOnly),
    JSON.stringify({ ...jwk, kty: 'RSA' }),
    JSON.stringify({ ...jwk, crv: 'P-256' }),
    JSON.stringify({ ...jwk, d: 'short' }),
    JSON.stringify({ ...jwk, x: 'short' }),
    12345,
  ];
  for (const raw of bad) assert.equal(parseSigningJwk(raw), null);
});

test('a key whose x does not belong to its d is refused', async () => {
  const first = await makeKey();
  const second = await makeKey();
  const mismatched = JSON.stringify({ ...first, x: second.x });
  assert.equal(await signingKeyIsConsistent(mismatched), false);
  assert.equal((await handleGevToken({ GEV_SIGNING_KEY: mismatched })).status, 503);
  assert.equal((await handleGevJwks({ GEV_SIGNING_KEY: mismatched })).status, 503);
  assert.equal(await signingKeyIsConsistent(JSON.stringify(first)), true);
});

test('handleGevToken returns a token, its expiry, and no-store caching', async () => {
  const jwk = await makeKey();
  const res = await handleGevToken({ GEV_SIGNING_KEY: JSON.stringify(jwk) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['expires_at', 'token', 'ttl_seconds']);
  assert.equal(body.ttl_seconds, 300);
  assert.equal(verifyToken(jwk.x, body.token).signatureOk, true);
  assert.ok(Date.parse(body.expires_at) > Date.now());
  assert.equal(JSON.stringify(body).includes(jwk.d), false);
});

test('handleGevToken refuses to mint without a usable key', async () => {
  for (const GEV_SIGNING_KEY of [undefined, '', '   ', 'too-short', '{}', 12345]) {
    const res = await handleGevToken({ GEV_SIGNING_KEY });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'gev_not_configured' });
  }
});

test('GET /gev/jwks publishes only kty, crv, and x, and never the private d', async () => {
  const jwk = await makeKey();
  // Stuff the secret with extra fields to prove none of them leak.
  const secretText = JSON.stringify({ ...jwk, key_ops: ['sign'], ext: true, kid: 'private-label' });
  const res = await handleGevJwks({ GEV_SIGNING_KEY: secretText });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { kty: 'OKP', crv: 'Ed25519', x: jwk.x });
  assert.equal('d' in JSON.parse(text), false);
  assert.equal(text.includes(jwk.d), false);
  assert.equal(text.includes('private-label'), false);
});

test('GET /gev/jwks answers 503 with no key and caches nothing', async () => {
  for (const GEV_SIGNING_KEY of [undefined, '', 'garbage']) {
    const res = await handleGevJwks({ GEV_SIGNING_KEY });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'gev_not_configured' });
  }
});

test('GET /gev/jwks needs no admin token and the key it serves verifies minted tokens', async () => {
  const jwk = await makeKey();
  const env = { TITAN_ADMIN_TOKEN: ADMIN, GEV_SIGNING_KEY: JSON.stringify(jwk) };

  const jwks = await worker.fetch(new Request('https://worker.example/gev/jwks'), env);
  assert.equal(jwks.status, 200);
  const published = await jwks.json();
  assert.equal(published.d, undefined);

  const minted = await worker.fetch(new Request('https://worker.example/gev/token', { headers: { 'X-Titan-Auth': ADMIN } }), env);
  assert.equal(verifyToken(published.x, (await minted.json()).token).signatureOk, true);

  const post = await worker.fetch(new Request('https://worker.example/gev/jwks', { method: 'POST' }), env);
  assert.equal(post.status, 404);

  const unconfigured = await worker.fetch(new Request('https://worker.example/gev/jwks'), { TITAN_ADMIN_TOKEN: ADMIN });
  assert.equal(unconfigured.status, 503);
});

test('GET /gev/token needs the admin token and mints only for a logged in session', async () => {
  const jwk = await makeKey();
  const env = { TITAN_ADMIN_TOKEN: ADMIN, GEV_SIGNING_KEY: JSON.stringify(jwk) };
  const url = 'https://worker.example/gev/token';

  const anonymous = await worker.fetch(new Request(url), env);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.text()).includes('gev2.'), false);

  const wrong = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': 'not-the-token' } }), env);
  assert.equal(wrong.status, 401);

  const noAdminConfigured = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': '' } }), { GEV_SIGNING_KEY: env.GEV_SIGNING_KEY });
  assert.equal(noAdminConfigured.status, 401);

  const ok = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': ADMIN } }), env);
  assert.equal(ok.status, 200);
  assert.equal(verifyToken(jwk.x, (await ok.json()).token).signatureOk, true);

  const post = await worker.fetch(new Request(url, { method: 'POST', headers: { 'X-Titan-Auth': ADMIN } }), env);
  assert.equal(post.status, 404);

  const unconfigured = await worker.fetch(new Request(url, { headers: { 'X-Titan-Auth': ADMIN } }), { TITAN_ADMIN_TOKEN: ADMIN });
  assert.equal(unconfigured.status, 503);
});
