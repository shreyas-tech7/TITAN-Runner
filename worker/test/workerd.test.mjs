// The real Workers runtime (workerd, through `wrangler dev --local`) with a real local D1. These tests prove what Node
// cannot: the Worker starts in the true runtime, the migrations run in real D1, the sealed box works in workerd and
// opens with libsodium, and the sealed box stays cheap enough for the 10 ms CPU limit of the Workers free plan.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startWorkerd } from './helpers/workerd.mjs';
import { startFakeServer } from './helpers/fakeServer.mjs';
import { ADMIN, FAKE_GROQ_KEY, FakeWorld } from './helpers/world.mjs';

const sodium = createRequire(import.meta.url)('libsodium-wrappers');
const world = new FakeWorld();
world.providers.host('api.groq.com').valid.add(FAKE_GROQ_KEY);
let fake;
let worker;
const H = { 'X-Titan-Auth': ADMIN, 'content-type': 'application/json' };
const call = (path, init = {}) => fetch(`${worker.url}${path}`, { ...init, headers: { ...(init.headers ?? {}) } });

before(async () => {
  fake = await startFakeServer(world);
  worker = await startWorkerd({
    vars: {
      TITAN_ADMIN_TOKEN: ADMIN,
      GITHUB_PAT: 'fake-pat-for-workerd-tests',
      TITAN_TEST_MODE: '1',
      TITAN_TEST_HOST_MAP: JSON.stringify(fake.hostMap),
      TITAN_COMMIT: 'workerd-test-commit',
    },
    timeoutMs: 90_000,
  });
});

after(async () => {
  await worker?.stop();
  await fake?.stop();
});

test('workerd: the Worker starts, GET / and GET /version answer, and the local D1 is migrated on the first request', async () => {
  assert.equal((await call('/')).status, 200);
  const version = await (await call('/version')).json();
  assert.equal(version.commit, 'workerd-test-commit');
  const status = await call('/status', { headers: H });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.ok(body.providers.length >= 5, 'the baseline migration seeded the provider rows');
  assert.equal((await call('/status')).status, 401);
  assert.equal((await call('/admin/keys')).status, 401);
});

test('workerd: a key goes through the real runtime, and libsodium opens the sealed box that the fake GitHub received', async () => {
  const res = await call('/admin/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: 'groq', value: FAKE_GROQ_KEY }) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const json = JSON.parse(text);
  assert.equal(json.verified, true);
  assert.equal(json.selftest, 'dispatched');
  assert.ok(!text.includes(FAKE_GROQ_KEY));
  // The fake GitHub, running in this process, holds the secret that workerd sealed.
  await sodium.ready;
  const stored = world.github.secrets.get('GROQ_API_KEY');
  assert.ok(stored, 'the secret reached the fake GitHub');
  const opened = sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(stored.encrypted_value, 'base64')), world.github.keyPair.publicKey, world.github.keyPair.secretKey);
  assert.equal(new TextDecoder().decode(opened), FAKE_GROQ_KEY, 'libsodium opens the box that workerd made');
  assert.equal(world.github.dispatches.at(-1).event_type, 'provider-selftest');
  // The key list works in workerd, including the Cache API for the pulse view.
  const list = await (await call('/admin/keys', { headers: H })).json();
  assert.equal(list.providers.find((p) => p.id === 'groq').state, 'provider_ok');
});

test('workerd: the seal step costs well under the 5 ms threshold of the brief, measured from outside the runtime', async () => {
  const time = async (path, iterations) => {
    const t0 = performance.now();
    const r = await call('/admin/_bench/seal', { method: 'POST', headers: H, body: JSON.stringify({ path, iterations }) });
    assert.equal(r.status, 200);
    await r.json();
    return performance.now() - t0;
  };
  await time('webcrypto', 3); // warm up
  await time('nacl', 3);
  const results = {};
  for (const path of ['webcrypto', 'nacl']) {
    const one = Math.min(await time(path, 1), await time(path, 1), await time(path, 1));
    const many = Math.min(await time(path, 100), await time(path, 100));
    results[path] = { requestOverheadMs: Math.round(one * 10) / 10, perSealMs: Math.round(((many - one) / 99) * 100) / 100 };
  }
  console.log(`# seal cost in workerd (wall time on this machine): ${JSON.stringify(results)}`);
  assert.ok(results.webcrypto.perSealMs < 5, `the WebCrypto path must stay under 5 ms, got ${results.webcrypto.perSealMs}`);
  // The WebCrypto path is the one the Worker uses. The result is part of the final report.
  world.sealCostReport = results;
});

test('workerd: ten wrong tokens lock the client, and CORS answers for the Pages origin only', async () => {
  const bad = () => call('/admin/export', { headers: { 'X-Titan-Auth': 'wrong', 'CF-Connecting-IP': '198.51.100.77' } });
  for (let i = 0; i < 10; i += 1) assert.equal((await bad()).status, 401);
  assert.equal((await bad()).status, 429);
  const pre = await call('/admin/keys', { method: 'OPTIONS', headers: { Origin: 'https://shreyas-tech7.github.io', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://shreyas-tech7.github.io');
  const evil = await call('/admin/keys', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('workerd: the callback token is made, written as a sealed box, and then opens /internal', async () => {
  // The cron does not run in `wrangler dev`, so ask for the rotation through the admin route.
  const rotate = await call('/admin/callback-token/rotate', { method: 'POST', headers: H, body: '{}' });
  assert.equal(rotate.status, 200);
  await sodium.ready;
  const stored = world.github.secrets.get('TITAN_CALLBACK_TOKEN');
  const plain = new TextDecoder().decode(sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(stored.encrypted_value, 'base64')), world.github.keyPair.publicKey, world.github.keyPair.secretKey));
  assert.match(plain, /^[0-9a-f]{64}$/);
  const hb = await call('/internal/pulse-heartbeat', { method: 'POST', headers: { 'X-Titan-Callback': plain, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(hb.status, 200);
  assert.equal((await call('/internal/pulse-heartbeat', { method: 'POST', headers: { 'X-Titan-Callback': '0'.repeat(64) }, body: '{}' })).status, 401);
});
