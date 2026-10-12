// A sign-in is the first request that a fresh database sees. The sign-in route is public, and it reads and writes D1
// (the login guard, the sign-in log, the session). The migrations must run before it. The fake D1 of the Node tests
// holds the full schema from the start, so only the real runtime can show this. The first run of the dashboard against
// a new Worker found it: the sign-in answered 500 with a missing table.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerd } from './helpers/workerd.mjs';
import { ADMIN } from './helpers/world.mjs';

let worker;
before(async () => {
  worker = await startWorkerd({ vars: { TITAN_ADMIN_TOKEN: ADMIN, TITAN_TEST_MODE: '1' }, timeoutMs: 90_000 });
});
after(async () => {
  await worker?.stop();
});

const post = (path, body, headers = {}) => fetch(`${worker.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('workerd: a wrong token as the very first request answers 401, not a database error', async () => {
  const res = await post('/auth/login', { token: 'not-the-admin-token' });
  assert.equal(res.status, 401, await res.clone().text());
});

test('workerd: the right token then gives a session, and the session works on an admin route and on the session check', async () => {
  const res = await post('/auth/login', { token: ADMIN });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.ok(body.session && body.session !== ADMIN);
  assert.ok(Date.parse(body.expires_at) > Date.now());
  const check = await fetch(`${worker.url}/auth/session`, { headers: { 'X-Titan-Auth': body.session } });
  assert.equal(check.status, 200);
  assert.equal((await check.json()).kind, 'session');
  const log = await fetch(`${worker.url}/admin/security/signins?limit=10`, { headers: { 'X-Titan-Auth': body.session } });
  assert.equal(log.status, 200);
  const entries = (await log.json()).entries;
  assert.deepEqual(entries.map((e) => e.result).sort(), ['failure', 'success']);
  assert.ok(!JSON.stringify(entries).includes(ADMIN), 'the log never holds a token');
});

test('workerd: logout ends the session, and the session then answers 401', async () => {
  const { session } = await (await post('/auth/login', { token: ADMIN })).json();
  const out = await fetch(`${worker.url}/auth/logout`, { method: 'POST', headers: { 'X-Titan-Auth': session, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(out.status, 200);
  assert.equal((await fetch(`${worker.url}/auth/session`, { headers: { 'X-Titan-Auth': session } })).status, 401);
});
