// Coverage for the VM-fleet routes and tick helper (Railway free VMs).
// Stubs a minimal env.DB the way the handlers actually call it
// (prepare().bind().run()/.all()/.first()) and, for the dispatch test, stubs
// globalThis.fetch — same no-live-network approach as the other worker tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleListVms,
  handleProvisionVm,
  handleInternalVmStatus,
  dispatchQueuedVms,
  expireStaleVms,
} from '../src/legacy.js';

/**
 * A tiny fake D1. `plan` maps a substring of the SQL to the result the
 * matching statement should resolve to; `.run()` results default to
 * { meta: { changes: 1 } }. Every executed statement (sql + bound params)
 * is recorded on `calls` for assertions.
 */
function fakeDb(plan = {}) {
  const calls = [];
  function resultFor(sql, kind) {
    for (const [needle, value] of Object.entries(plan)) {
      if (sql.includes(needle)) return typeof value === 'function' ? value(kind) : value;
    }
    return undefined;
  }
  const db = {
    calls,
    prepare(sql) {
      const stmt = {
        _params: [],
        bind(...params) {
          this._params = params;
          return this;
        },
        async all() {
          calls.push({ sql, params: this._params, kind: 'all' });
          return resultFor(sql, 'all') ?? { results: [] };
        },
        async run() {
          calls.push({ sql, params: this._params, kind: 'run' });
          return resultFor(sql, 'run') ?? { meta: { changes: 1 } };
        },
        async first() {
          calls.push({ sql, params: this._params, kind: 'first' });
          return resultFor(sql, 'first') ?? null;
        },
      };
      return stmt;
    },
  };
  return db;
}

function jsonRequest(body) {
  return new Request('https://worker.test/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /vms returns the recent rows the DB hands back', async () => {
  const rows = [{ id: 'vm-1', status: 'live', preview_url: 'https://a.up.railway.app' }];
  const env = { DB: fakeDb({ 'FROM vms': { results: rows } }) };
  const res = await handleListVms(env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.vms, rows);
  assert.ok(body.generatedAt);
});

test('POST /vms/provision inserts a requested row and returns its id', async () => {
  const env = { DB: fakeDb() };
  const res = await handleProvisionVm(jsonRequest({ brief: 'build a landing page' }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.id, /[0-9a-f-]{36}/);
  const insert = env.DB.calls.find((c) => c.sql.includes('INSERT INTO vms'));
  assert.ok(insert, 'expected an INSERT INTO vms');
  assert.ok(insert.params.includes('build a landing page'));
  // vcpu=2, ram_mb=2048 are bound (the fixed Railway free-VM spec).
  assert.ok(insert.params.includes(2) && insert.params.includes(2048));
});

test('POST /vms/provision tolerates an empty body (a bare VM, no brief)', async () => {
  const env = { DB: fakeDb() };
  const res = await handleProvisionVm(jsonRequest({}), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('POST /internal/vm-status rejects an unknown status', async () => {
  const env = { DB: fakeDb() };
  const res = await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'bogus' }), env);
  assert.equal(res.status, 400);
});

test('POST /internal/vm-status updates only the provided fields', async () => {
  const env = { DB: fakeDb() };
  const res = await handleInternalVmStatus(
    jsonRequest({ id: 'vm-1', status: 'live', preview_url: 'https://x.up.railway.app', claim_url: 'https://railway.com/ssh-signup?code=abc123XYZ' }),
    env,
  );
  assert.equal(res.status, 200);
  const update = env.DB.calls.find((c) => c.sql.includes('UPDATE vms'));
  assert.ok(update.sql.includes('preview_url = ?'));
  assert.ok(update.sql.includes('claim_url = ?'));
  assert.ok(!update.sql.includes('region = ?'), 'a field not supplied must not appear in the SET list');
  assert.equal(update.params.at(-1), 'vm-1', 'the id is the last bound param');
});

test('POST /internal/vm-status 404s when no row matches', async () => {
  const env = { DB: fakeDb({ 'UPDATE vms': { meta: { changes: 0 } } }) };
  const res = await handleInternalVmStatus(jsonRequest({ id: 'nope', status: 'live' }), env);
  assert.equal(res.status, 404);
});

test('dispatchQueuedVms fires a provision-vm dispatch and flips the row to provisioning', async (t) => {
  const dispatches = [];
  t.mock.method(globalThis, 'fetch', async (urlArg, init) => {
    const url = typeof urlArg === 'string' ? urlArg : urlArg.url;
    if (url.includes('/dispatches')) {
      dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  });

  const env = {
    GITHUB_PAT: 'gh_fake',
    GITHUB_OWNER: 'shreyas-tech7',
    GITHUB_REPO: 'TITAN-Runner',
    DB: fakeDb({ "status = 'requested'": { results: [{ id: 'vm-1', brief: 'do a thing' }] } }),
  };
  await dispatchQueuedVms(env);

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].event_type, 'provision-vm');
  assert.equal(dispatches[0].client_payload.id, 'vm-1');
  const update = env.DB.calls.find((c) => c.sql.includes("status = 'provisioning'"));
  assert.ok(update, 'expected the row to be flipped to provisioning');
  assert.ok(update.params.includes('vm-1'));
});

test('dispatchQueuedVms is a no-op without a GITHUB_PAT (degrades, never throws)', async () => {
  const env = { DB: fakeDb() };
  await dispatchQueuedVms(env); // must not throw
  assert.equal(env.DB.calls.length, 0);
});

// RT6: a VM is untrusted. The Worker cleans the URLs and caps the lifetime, whatever the caller sends.

function paramsOf(env) {
  const update = env.DB.calls.find((c) => c.sql.includes('UPDATE vms'));
  const cols = [...update.sql.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
  return Object.fromEntries(cols.map((c, i) => [c, update.params[i]]));
}

test('RT6: a preview URL is cut to https on up.railway.app with no query, user name, or path', async () => {
  const env = { DB: fakeDb() };
  await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live', preview_url: 'https://Box-1.up.railway.app/app?token=sk_live_should_not_stay#frag' }), env);
  assert.equal(paramsOf(env).preview_url, 'https://box-1.up.railway.app/');
  for (const bad of ['http://box.up.railway.app/', 'https://evil.example.com/', 'https://u:p@box.up.railway.app/', 'https://box.up.railway.app:8443/', 'javascript:alert(1)']) {
    const e = { DB: fakeDb() };
    await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live', preview_url: bad }), e);
    assert.equal(paramsOf(e).preview_url, undefined, `${bad} must be dropped`);
  }
});

test('RT6: a claim URL keeps only the code, and anything else is dropped', async () => {
  const env = { DB: fakeDb() };
  await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live', claim_url: 'https://railway.com/ssh-signup?code=abc123XYZ' }), env);
  assert.equal(paramsOf(env).claim_url, 'https://railway.com/ssh-signup?code=abc123XYZ');
  for (const bad of ['https://railway.com/ssh-signup?code=abc123XYZ&next=https://evil.example', 'https://evil.example/ssh-signup?code=abc123XYZ', 'https://railway.com/other?code=abc123XYZ']) {
    const e = { DB: fakeDb() };
    await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live', claim_url: bad }), e);
    assert.equal(paramsOf(e).claim_url, undefined, `${bad} must be dropped`);
  }
});

test('RT6: a live VM gets a claim deadline within the cap, even when the caller sends 24 hours or nothing', async () => {
  const day = new Date(Date.now() + 24 * 3600_000).toISOString();
  const env = { DB: fakeDb() };
  await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live', claim_deadline: day }), env);
  const capped = Date.parse(paramsOf(env).claim_deadline) - Date.now();
  assert.ok(capped <= 120 * 60_000 + 5_000 && capped > 100 * 60_000, `capped to about 120 minutes, got ${Math.round(capped / 60_000)}`);
  const none = { DB: fakeDb() };
  await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live' }), none);
  assert.ok(paramsOf(none).claim_deadline, 'a live VM always has a deadline');
  const short = { DB: fakeDb() };
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live', claim_deadline: soon }), short);
  assert.equal(paramsOf(short).claim_deadline, soon, 'a shorter deadline stays');
  const custom = { DB: fakeDb(), TITAN_VM_MAX_LIFETIME_MINUTES: '30' };
  await handleInternalVmStatus(jsonRequest({ id: 'vm-1', status: 'live', claim_deadline: day }), custom);
  assert.ok(Date.parse(paramsOf(custom).claim_deadline) - Date.now() <= 30 * 60_000 + 5_000, 'the cap is configurable');
});

test('RT6: expireStaleVms also expires a VM older than the cap', async () => {
  const env = { DB: fakeDb() };
  await expireStaleVms(env);
  const update = env.DB.calls.find((c) => c.sql.includes("status = 'expired'"));
  assert.ok(update.sql.includes('created_at < ?'));
  const oldest = Date.parse(update.params.at(-1));
  assert.ok(Math.abs(Date.now() - oldest - 120 * 60_000) < 5_000);
});
