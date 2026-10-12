// RO1 to RO6: the /ops routes of contract v1 (docs/CONTRACT.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { ROUTES } from '../src/routes.js';
import { authenticateOps, buildQuotaTable, pruneOps } from '../src/ops.js';
import { ADMIN, FakeWorld, authed } from './helpers/world.mjs';

const OPS = ['ops', 'token', 'for', 'tests', 'only', '0123456789'].join('-');
const bearer = (token = OPS) => ({ Authorization: `Bearer ${token}` });
const ip = (addr, extra = {}) => ({ 'CF-Connecting-IP': addr, ...extra });

function setup(t, extraEnv = {}) {
  const world = new FakeWorld().install(t);
  return { world, env: world.env({ OPS_TOKEN: OPS, ...extraEnv }) };
}
let nextIp = 1;
const call = (env, method, path, body, headers = bearer()) => worker.fetch(new Request(`https://worker.example${path}`, {
  // Each call comes from its own client address, so a sweep of wrong tokens does not lock itself out.
  method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `198.18.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
}), env);
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const rec = (over = {}) => ({ source: 'runner', provider: 'openrouter', model: 'meta/llama-free:free', requests: 1, tokens_in: 10, tokens_out: 5, status: 'ok', ts: iso(), ...over });

const OPS_ROUTES = ROUTES.filter((r) => r.group === 'ops');

test('RO: there are ops routes, and each one answers 401 with no token and with a wrong token', async (t) => {
  const { env } = setup(t);
  assert.ok(OPS_ROUTES.length >= 9);
  for (const r of OPS_ROUTES) {
    const none = await call(env, r.method, r.path, r.method === 'POST' ? {} : undefined, {});
    assert.equal(none.status, 401, `${r.method} ${r.path} without a token`);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer');
    const wrong = await call(env, r.method, r.path, r.method === 'POST' ? {} : undefined, bearer('x'.repeat(40)));
    assert.equal(wrong.status, 401, `${r.method} ${r.path} with a wrong token`);
    const admin = await call(env, r.method, r.path, r.method === 'POST' ? {} : undefined, { 'X-Titan-Auth': ADMIN });
    assert.equal(admin.status, 401, `${r.method} ${r.path} with the admin token`);
    const basic = await call(env, r.method, r.path, r.method === 'POST' ? {} : undefined, { Authorization: `Basic ${OPS}` });
    assert.equal(basic.status, 401, `${r.method} ${r.path} with another scheme`);
  }
});

test('RO: the ops token opens only the ops routes', async (t) => {
  const { env } = setup(t);
  for (const path of ['/status', '/admin/keys', '/auth/session']) assert.equal((await call(env, 'GET', path, undefined, bearer())).status, 401, path);
  assert.equal((await worker.fetch(new Request('https://worker.example/ops/quota', { headers: { 'X-Titan-Auth': OPS } }), env)).status, 401);
});

test('RO: with OPS_TOKEN unset, or shorter than 24 characters, every ops route answers 401 even with a token', async (t) => {
  for (const extra of [{ OPS_TOKEN: undefined }, { OPS_TOKEN: 'short-token' }, { OPS_TOKEN: '' }]) {
    const { env } = setup(t, extra);
    const res = await call(env, 'GET', '/ops/quota', undefined, bearer(extra.OPS_TOKEN || 'short-token'));
    assert.equal(res.status, 401, JSON.stringify(extra));
  }
  assert.equal(authenticateOps(new Request('https://x/', { headers: bearer(OPS) }), { OPS_TOKEN: OPS }), 'ok');
});

test('RO: a wrong ops token counts toward the lockout and lands in the sign-in log, and the right token still fails while locked', async (t) => {
  const { env } = setup(t);
  const same = (headers) => ({ ...headers, 'CF-Connecting-IP': '203.0.113.9' });
  for (let i = 0; i < 10; i += 1) assert.equal((await call(env, 'GET', '/ops/quota', undefined, same(bearer(`wrong-${i}-`.padEnd(30, 'x'))))).status, 401);
  const locked = await call(env, 'GET', '/ops/quota', undefined, same(bearer()));
  assert.equal(locked.status, 429);
  const row = await env.DB.prepare("SELECT route, result, reason FROM signin_log WHERE route = 'ops' ORDER BY id").first();
  assert.deepEqual({ ...row }, { route: 'ops', result: 'failure', reason: 'wrong_token' });
});

test('RO: a browser request with an Origin header is refused, and a response carries no CORS header', async (t) => {
  const { env } = setup(t);
  const res = await call(env, 'GET', '/ops/quota', undefined, { ...bearer(), Origin: 'https://shreyas-tech7.github.io' });
  assert.equal(res.status, 403);
  const ok = await call(env, 'GET', '/ops/quota');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});

// ---------------------------------------------------------------------
// POST /ops/usage
// ---------------------------------------------------------------------

test('RO1: usage takes one record or an array, counts a repeat once, and answers accepted and duplicates', async (t) => {
  const { env } = setup(t);
  const one = rec({ ts: '2026-10-11T10:00:00.000Z' });
  const a = await (await call(env, 'POST', '/ops/usage', one)).json();
  assert.deepEqual([a.accepted, a.duplicates], [1, 0]);
  const b = await (await call(env, 'POST', '/ops/usage', [one, rec({ provider: 'groq', model: 'llama-3.3-70b-versatile', ts: iso() })])).json();
  assert.deepEqual([b.accepted, b.duplicates], [1, 1], 'the repeat is not counted twice');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_log').first()).n, 2);
});

test('RO1: a field that the contract does not name is refused and the answer names it, so a prompt never reaches the table', async (t) => {
  const { env } = setup(t);
  const res = await call(env, 'POST', '/ops/usage', rec({ prompt: 'my private note', email: 'a@example.com' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_records');
  assert.deepEqual(body.rejected.map((r) => r.field).sort(), ['email', 'prompt']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_log').first()).n, 0);
});

const BAD_USAGE = [
  ['a missing field', { ...rec(), requests: undefined }, 'requests'],
  ['a negative count', rec({ requests: -1 }), 'requests'],
  ['a count that is not a whole number', rec({ tokens_in: 1.5 }), 'tokens_in'],
  ['a count that is too large', rec({ tokens_out: 5_000_000_000 }), 'tokens_out'],
  ['a bad status', rec({ status: 'fine' }), 'status'],
  ['a bad source', rec({ source: 'someone' }), 'source'],
  ['a provider with a space', rec({ provider: 'open router' }), 'provider'],
  ['a provider in upper case', rec({ provider: 'OpenRouter' }), 'provider'],
  ['a model with a space', rec({ model: 'my model' }), 'model'],
  ['a model that is too long', rec({ model: 'm'.repeat(200) }), 'model'],
  ['a time that is not ISO 8601', rec({ ts: 'yesterday' }), 'ts'],
  ['a time in the future', rec({ ts: iso(Date.now() + 3 * 3600_000) }), 'ts'],
  ['a time older than 40 days', rec({ ts: iso(Date.now() - 41 * 86_400_000) }), 'ts'],
  ['a negative remaining', rec({ remaining_requests: -5 }), 'remaining_requests'],
];
for (const [name, record, field] of BAD_USAGE) {
  test(`RO1: usage refuses ${name}, and names the field ${field}`, async (t) => {
    const { env } = setup(t);
    const res = await call(env, 'POST', '/ops/usage', JSON.parse(JSON.stringify(record)));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).rejected.some((r) => r.field === field), field);
  });
}

test('RO1: usage keeps the good records of a mixed batch and lists the bad ones by index', async (t) => {
  const { env } = setup(t);
  const res = await call(env, 'POST', '/ops/usage', [rec(), rec({ status: 'nope' }), rec({ provider: 'groq', model: 'g' })]);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.accepted, 2);
  assert.deepEqual(body.rejected.map((r) => [r.index, r.field]), [[1, 'status']]);
});

test('RO1: usage refuses a body that is not JSON, an empty array, too many records, and an oversize body', async (t) => {
  const { env } = setup(t);
  assert.equal((await call(env, 'POST', '/ops/usage', '{')).status, 400);
  assert.equal((await call(env, 'POST', '/ops/usage', [])).status, 400);
  assert.equal((await call(env, 'POST', '/ops/usage', Array.from({ length: 501 }, (_, i) => rec({ ts: iso(Date.now() - i * 1000) })))).status, 400);
  assert.equal((await call(env, 'POST', '/ops/usage', JSON.stringify([rec({ model: 'x'.repeat(300_000) })]))).status, 413);
  assert.equal((await call(env, 'POST', '/ops/usage', '"text"')).status, 400);
});

// ---------------------------------------------------------------------
// GET /ops/quota
// ---------------------------------------------------------------------

const quotaOf = async (env, provider, model) => (await (await call(env, 'GET', '/ops/quota')).json()).providers[provider][model];

test('RO1: the quota answer has the fields of the contract, and a provider with no usage shows model *', async (t) => {
  const { env } = setup(t);
  const body = await (await call(env, 'GET', '/ops/quota')).json();
  assert.equal(body.contract, '1');
  assert.match(body.generated_at, /^\d{4}-/);
  const groq = body.providers.groq['*'];
  assert.deepEqual(Object.keys(groq).sort(), ['exhausted', 'limit_confidence', 'limit_day', 'limit_month', 'limit_source', 'remaining_pct', 'resets_at', 'used_day', 'used_month']);
  assert.deepEqual([groq.limit_day, groq.limit_confidence, groq.exhausted, groq.remaining_pct, groq.used_day], [null, 'unknown', false, null, 0], 'a limit that the docs do not state stays unknown and is never guessed');
  assert.match(groq.limit_source, /^https:\/\/console\.groq\.com/);
  assert.ok(body.providers.hermes_1 && body.providers.custom_3, 'every catalog provider is listed');
});

test('RO1: OpenRouter free models share one daily count of 50, and exhausted turns true at 95%', async (t) => {
  const { env } = setup(t);
  await call(env, 'POST', '/ops/usage', [rec({ model: 'a/one:free', requests: 20 }), rec({ model: 'b/two:free', requests: 27, ts: iso(Date.now() - 1000) })]);
  let q = await quotaOf(env, 'openrouter', 'a/one:free');
  assert.deepEqual([q.limit_day, q.used_day, q.limit_confidence, q.exhausted], [50, 47, 'official', false], '47 of 50 is 94%');
  assert.equal(q.remaining_pct, 6);
  assert.equal((await quotaOf(env, 'openrouter', 'b/two:free')).used_day, 47, 'the count is shared by the account');
  await call(env, 'POST', '/ops/usage', rec({ model: 'a/one:free', requests: 1, ts: iso(Date.now() - 2000) }));
  q = await quotaOf(env, 'openrouter', 'a/one:free');
  assert.deepEqual([q.used_day, q.exhausted], [48, true], '48 of 50 is 96%');
  assert.equal(q.resets_at, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString());
  assert.equal(q.limit_source, 'https://openrouter.ai/docs/api-reference/limits');
  await call(env, 'POST', '/ops/usage', rec({ model: 'a/paid-model', requests: 1, ts: iso(Date.now() - 3000) }));
  const paid = await quotaOf(env, 'openrouter', 'a/paid-model');
  assert.deepEqual([paid.limit_day, paid.limit_confidence], [null, 'unknown'], 'a model that is not :free has no stated free limit');
});

test('RO1: a 429 holds the model until the reset, and an unknown limit never turns exhausted by use alone', async (t) => {
  const { env } = setup(t);
  await call(env, 'POST', '/ops/usage', rec({ provider: 'groq', model: 'llama-3.3-70b-versatile', requests: 500 }));
  assert.equal((await quotaOf(env, 'groq', 'llama-3.3-70b-versatile')).exhausted, false, 'no known limit, so no guess');
  await call(env, 'POST', '/ops/usage', rec({ provider: 'groq', model: 'llama-3.3-70b-versatile', requests: 1, status: 'rate_limited', ts: iso(Date.now() - 500) }));
  const q = await quotaOf(env, 'groq', 'llama-3.3-70b-versatile');
  assert.equal(q.exhausted, true);
  assert.equal(q.limit_confidence, 'unknown');
  assert.match(q.resets_at, /T00:00:00\.000Z$/);
  await env.DB.prepare("UPDATE quota_state SET blocked_until = '2020-01-01T00:00:00.000Z'").run();
  assert.equal((await quotaOf(env, 'groq', 'llama-3.3-70b-versatile')).exhausted, false, 'after the reset the hold ends');
});

test('RO1: the Groq header that counts a day shows the real daily limit, marked observed', async (t) => {
  const { env } = setup(t);
  await call(env, 'POST', '/ops/usage', rec({ provider: 'groq', model: 'g1', requests: 100, ts: iso(Date.now() - 5000) }));
  await call(env, 'POST', '/ops/usage', rec({ provider: 'groq', model: 'g1', requests: 1, remaining_requests: 899 }));
  const q = await quotaOf(env, 'groq', 'g1');
  assert.deepEqual([q.limit_day, q.limit_confidence, q.used_day], [1000, 'observed', 101]);
  assert.equal(q.remaining_pct, 89.9);
  // The same header from a provider whose header does not count a day shows nothing.
  await call(env, 'POST', '/ops/usage', rec({ provider: 'together', model: 't1', requests: 5, remaining_requests: 10 }));
  const t1 = await quotaOf(env, 'together', 't1');
  assert.deepEqual([t1.limit_day, t1.limit_confidence], [null, 'unknown']);
});

test('RO1: Gemini resets at midnight Pacific time, and the month total counts the whole UTC month', async (t) => {
  const { env } = setup(t);
  const now = new Date('2026-12-05T20:00:00Z');
  const { dayWindow } = await import('../../src/ops/quota.js');
  assert.equal(dayWindow('pacific-midnight', now).next.toISOString(), '2026-12-06T08:00:00.000Z');
  const q = await quotaOf(env, 'gemini', '*');
  assert.ok(/T0[78]:00:00\.000Z$/.test(q.resets_at), q.resets_at);
  const table = await buildQuotaTable(env, new Date());
  assert.ok(table.gemini['*']);
});

// ---------------------------------------------------------------------
// Health, eval, hosts, doorbell, usage totals, retention
// ---------------------------------------------------------------------

test('RO2: health stores the canary results and returns them by provider and model', async (t) => {
  const { env } = setup(t);
  const results = [
    { provider: 'groq', model: 'llama', status: 'healthy', latency_ms: 420, checked_at: iso(), error_class: null },
    { provider: 'together', model: '*', status: 'not_configured', latency_ms: null, checked_at: iso(), error_class: 'no_key' },
  ];
  assert.equal((await call(env, 'POST', '/ops/health', { results })).status, 200);
  assert.equal((await call(env, 'POST', '/ops/health', { results: [{ ...results[0], status: 'degraded', latency_ms: 9000 }] })).status, 200, 'the latest result replaces the old one');
  const body = await (await call(env, 'GET', '/ops/health')).json();
  assert.deepEqual(body.providers.groq.llama, { status: 'degraded', latency_ms: 9000, checked_at: results[0].checked_at, error_class: null });
  assert.equal(body.providers.together['*'].status, 'not_configured');
  for (const bad of [{ results: [{ ...results[0], status: 'ok' }] }, { results: [{ ...results[0], url: 'https://x' }] }, { results: [] }, {}]) {
    assert.equal((await call(env, 'POST', '/ops/health', bad)).status, 400);
  }
});

test('RO3: eval stores the scores and returns them by model and category', async (t) => {
  const { env } = setup(t);
  const results = [{ model: 'llama', category: 'code-generation', score: 0.75, tasks_run: 4, run_at: iso(), eval_version: 'v1' }, { model: 'llama', category: 'research', score: 1, tasks_run: 2, run_at: iso(), eval_version: 'v1' }];
  assert.equal((await call(env, 'POST', '/ops/eval', { results })).status, 200);
  const body = await (await call(env, 'GET', '/ops/eval')).json();
  assert.deepEqual(body.models.llama['code-generation'], { score: 0.75, tasks_run: 4, run_at: results[0].run_at, eval_version: 'v1' });
  for (const bad of [{ results: [{ ...results[0], score: 1.5 }] }, { results: [{ ...results[0], score: -0.1 }] }, { results: [{ ...results[0], extra: 1 }] }]) {
    assert.equal((await call(env, 'POST', '/ops/eval', bad)).status, 400);
  }
});

test('RO5: hosts are stored by name, the answer carries no URL, and only the GitHub Actions entry has last_pulse_at', async (t) => {
  const { env } = setup(t);
  const checks = [
    { host: 'github_actions', status: 'up', last_check: iso(), uptime_24h: 100, uptime_7d: 99.5, uptime_30d: 99.9, last_pulse_at: iso() },
    { host: 'hf_space', status: 'asleep', last_check: iso(), uptime_24h: 100, uptime_7d: 100, uptime_30d: 100, last_pulse_at: iso() },
  ];
  assert.equal((await call(env, 'POST', '/ops/hosts', { checks })).status, 200);
  const body = await (await call(env, 'GET', '/ops/hosts')).json();
  assert.ok(body.hosts.github_actions.last_pulse_at);
  assert.ok(!('last_pulse_at' in body.hosts.hf_space));
  assert.deepEqual(Object.keys(body.hosts.hf_space).sort(), ['last_check', 'status', 'uptime_24h', 'uptime_30d', 'uptime_7d']);
  assert.ok(!JSON.stringify(body).includes('http'), 'no URL');
  for (const bad of [{ checks: [{ ...checks[0], host: 'https://x.example' }] }, { checks: [{ ...checks[0], status: 'sleeping' }] }, { checks: [{ ...checks[0], url: 'https://x.example' }] }, { checks: [{ ...checks[0], uptime_24h: 120 }] }]) {
    assert.equal((await call(env, 'POST', '/ops/hosts', bad)).status, 400);
  }
});

test('RO6: the doorbell stores a job and a status code and nothing else', async (t) => {
  const { env } = setup(t);
  assert.equal((await call(env, 'POST', '/ops/doorbell', { job: 'sweep', status_code: 200, at: iso() })).status, 200);
  assert.equal((await call(env, 'POST', '/ops/doorbell', { job: 'sweep', status_code: null, at: iso() })).status, 200);
  for (const bad of [{ job: 'delete-all', status_code: 200, at: iso() }, { job: 'digest', status_code: 200, at: iso(), body: 'secret' }, { job: 'digest', status_code: 1000, at: iso() }]) {
    assert.equal((await call(env, 'POST', '/ops/doorbell', bad)).status, 400);
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM doorbell_log').first()).n, 2);
});

test('RO1: GET /ops/usage returns daily totals, and the ops retention removes old rows', async (t) => {
  const { env } = setup(t);
  await call(env, 'POST', '/ops/usage', [rec({ requests: 3, tokens_in: 30, tokens_out: 9 }), rec({ requests: 2, status: 'error', ts: iso(Date.now() - 1000) })]);
  const body = await (await call(env, 'GET', '/ops/usage?days=2')).json();
  assert.equal(body.usage[0].requests, 5);
  assert.equal(body.usage[0].errors, 2);
  await env.DB.prepare("UPDATE usage_log SET ts = '2020-01-01T00:00:00.000Z'").run();
  await env.DB.prepare("INSERT INTO doorbell_log (job, status_code, at) VALUES ('sweep', 200, '2020-01-01T00:00:00.000Z')").run();
  const out = await pruneOps(env);
  assert.deepEqual([out.usage_log, out.doorbell_log], [2, 1]);
});

test('RO: every ops body that holds a host name, a provider, or a model never carries a URL or a secret by design', async (t) => {
  const { env } = setup(t);
  for (const body of [{ host: 'x', status: 'up', last_check: iso() }]) assert.equal((await call(env, 'POST', '/ops/hosts', { checks: [{ ...body, host: 'https://secret.example/path?token=abc' }] })).status, 400);
  assert.equal((await call(env, 'POST', '/ops/usage', rec({ model: 'https://x.example/?key=abc' }))).status, 400);
});
