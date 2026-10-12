// RT5: sessions, sign-in limits, the sign-in log, CORS, input limits, public route limits, and the key form.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { checkLoginGuard, recordLoginFailure, recordLoginSuccess } from '../src/lib/loginGuard.js';
import { createSession, lookupSession, sessionLimits } from '../src/lib/sessions.js';
import { logSignin } from '../src/lib/signinLog.js';
import { ROUTES } from '../src/routes.js';
import { pruneOldRows } from '../src/retention.js';
import { ADMIN, FAKE_GROQ_KEY, FakeWorld, authed, get, post } from './helpers/world.mjs';

function setup(t, extraEnv = {}) {
  const world = new FakeWorld().install(t);
  world.providers.host('api.groq.com').valid.add(FAKE_GROQ_KEY);
  return { world, env: world.env(extraEnv) };
}
const ip = (addr, headers = {}) => ({ 'CF-Connecting-IP': addr, 'User-Agent': 'Test-Agent/1.0', ...headers });
const login = (env, token, addr = '203.0.113.5') => worker.fetch(post('/auth/login', { token }, ip(addr)), env);
const sessionHeader = (token) => ({ 'X-Titan-Auth': token });

test('RT5: a correct sign-in gives a session that opens admin routes, and the admin token still works for scripts', async (t) => {
  const { env } = setup(t);
  const res = await login(env, ADMIN);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.session, /^tsn_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.idle_timeout_seconds, 1800);
  assert.equal(body.absolute_timeout_seconds, 43200);
  const status = await worker.fetch(get('/status', sessionHeader(body.session)), env);
  assert.equal(status.status, 200);
  assert.equal((await worker.fetch(get('/status', authed), env)).status, 200);
  const info = await (await worker.fetch(get('/auth/session', sessionHeader(body.session)), env)).json();
  assert.equal(info.kind, 'session');
  assert.ok(info.expires_at && info.idle_expires_at);
  // The table holds a hash, never the session token.
  const rows = (await env.DB.prepare('SELECT id FROM sessions').all()).results;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, body.session);
  assert.match(rows[0].id, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(env.DB.dump()).includes(body.session));
});

test('RT5: a wrong token gives 401, a missing body gives 400, and each attempt lands in the sign-in log with IP and user agent', async (t) => {
  const { env } = setup(t);
  assert.equal((await login(env, 'wrong-token')).status, 401);
  assert.equal((await worker.fetch(new Request('https://worker.example/auth/login', { method: 'POST', headers: ip('203.0.113.5'), body: 'not json' }), env)).status, 400);
  assert.equal((await login(env, ADMIN)).status, 200);
  const rows = (await env.DB.prepare('SELECT at, ip, user_agent, route, result, reason FROM signin_log ORDER BY id').all()).results;
  assert.deepEqual(rows.map((r) => [r.route, r.result, r.reason]), [['login', 'failure', 'wrong_token'], ['login', 'failure', 'bad_body'], ['login', 'success', 'ok']]);
  assert.ok(rows.every((r) => r.ip === '203.0.113.5' && r.user_agent === 'Test-Agent/1.0' && /^\d{4}-\d{2}-\d{2}T/.test(r.at)));
  assert.ok(!JSON.stringify(rows).includes(ADMIN), 'the log never holds a token');
});

test('RT5: the Worker answers 503 when it has no admin token, never an open door', async (t) => {
  const { env } = setup(t, { TITAN_ADMIN_TOKEN: undefined });
  assert.equal((await login(env, '')).status, 503);
  assert.equal((await login(env, 'anything')).status, 503);
});

test('RT5: 5 wrong tokens lock one client, even for the right token, and other clients still sign in', async (t) => {
  const { env } = setup(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await login(env, `wrong-${i}`, '198.51.100.9')).status, 401);
  const locked = await login(env, ADMIN, '198.51.100.9');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('Retry-After')) >= 1);
  assert.equal((await locked.json()).error, 'locked_out');
  assert.equal((await login(env, ADMIN, '198.51.100.10')).status, 200, 'another client is not affected');
  const blocked = (await env.DB.prepare("SELECT reason FROM signin_log WHERE result = 'blocked'").all()).results;
  assert.deepEqual(blocked.map((r) => r.reason), ['locked_ip']);
  await login(env, ADMIN, '198.51.100.9');
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM signin_log WHERE result = 'blocked'").first()).n, 1, 'a client that keeps knocking adds one blocked row, not one for each knock');
});

test('RT5: each new lock doubles the time, to a ceiling of 60 minutes, and a good sign-in clears the client', async (t) => {
  const { env } = setup(t);
  const req = new Request('https://worker.example/auth/login', { method: 'POST', headers: ip('192.0.2.50') });
  const start = new Date('2026-10-11T12:00:00Z');
  const lockMinutes = [];
  let now = start;
  for (let round = 0; round < 7; round += 1) {
    for (let i = 0; i < 5; i += 1) await recordLoginFailure(env, req, now);
    const guard = await checkLoginGuard(env, req, now);
    assert.equal(guard.locked, true, `round ${round}`);
    lockMinutes.push(Math.round(guard.retryAfterSeconds / 60));
    now = new Date(now.getTime() + guard.retryAfterSeconds * 1000 + 1000);
    assert.equal((await checkLoginGuard(env, req, now)).locked, false, 'the lock ends');
  }
  assert.deepEqual(lockMinutes, [2, 4, 8, 16, 32, 60, 60]);
  await recordLoginSuccess(env, req);
  for (let i = 0; i < 5; i += 1) await recordLoginFailure(env, req, now);
  assert.equal(Math.round((await checkLoginGuard(env, req, now)).retryAfterSeconds / 60), 2, 'back to the first step');
});

test('RT5: many wrong tokens from many clients start an overall throttle, and a known client keeps access', async (t) => {
  const { env } = setup(t, { TITAN_LOGIN_GLOBAL_MAX: '8' });
  assert.equal((await login(env, ADMIN, '192.0.2.200')).status, 200, 'the owner signed in before');
  for (let i = 0; i < 8; i += 1) assert.equal((await login(env, 'guess', `203.0.113.${i + 1}`)).status, 401);
  const stranger = await login(env, ADMIN, '203.0.113.99');
  assert.equal(stranger.status, 429, 'an unknown client waits, even with the right token');
  assert.ok(Number(stranger.headers.get('Retry-After')) > 0);
  assert.equal((await login(env, ADMIN, '192.0.2.200')).status, 200, 'the known client still signs in');
  const reasons = (await env.DB.prepare("SELECT reason FROM signin_log WHERE result = 'blocked'").all()).results.map((r) => r.reason);
  assert.deepEqual(reasons, ['locked_global']);
});

test('RT5: a session ends after the idle time and after the absolute time, and both limits are configurable', async (t) => {
  const { env } = setup(t, { TITAN_SESSION_IDLE_MINUTES: '10', TITAN_SESSION_ABSOLUTE_HOURS: '2' });
  assert.deepEqual(sessionLimits(env), { idleMs: 600_000, absoluteMs: 7_200_000 });
  assert.deepEqual(sessionLimits({ TITAN_SESSION_IDLE_MINUTES: '1', TITAN_SESSION_ABSOLUTE_HOURS: '9999' }), { idleMs: 300_000, absoluteMs: 72 * 3_600_000 }, 'the values are clamped');
  const req = new Request('https://worker.example/auth/login', { method: 'POST', headers: ip('203.0.113.5') });
  const t0 = new Date('2026-10-11T12:00:00Z');
  const s = await createSession(env, req, t0);
  assert.equal((await lookupSession(env, s.token, new Date(t0.getTime() + 9 * 60_000))).ok, true);
  // The request at minute 9 moved the idle clock, so minute 18 is inside the idle limit.
  assert.equal((await lookupSession(env, s.token, new Date(t0.getTime() + 18 * 60_000))).ok, true);
  assert.deepEqual(await lookupSession(env, s.token, new Date(t0.getTime() + 40 * 60_000)), { ok: false, reason: 'idle' });
  assert.deepEqual(await lookupSession(env, s.token, new Date(t0.getTime() + 41 * 60_000)), { ok: false, reason: 'unknown' }, 'an ended session is gone');
  const s2 = await createSession(env, req, t0);
  let at = t0.getTime();
  for (let i = 0; i < 12; i += 1) {
    at += 9 * 60_000; // busy all the time, so idle never fires
    assert.equal((await lookupSession(env, s2.token, new Date(at))).ok, i < 12 ? true : false);
  }
  assert.deepEqual(await lookupSession(env, s2.token, new Date(t0.getTime() + 2 * 3_600_000 + 1000)), { ok: false, reason: 'absolute' });
});

test('RT5: an ended session gives 401 session_expired, is not counted as a wrong token, and is written to the log', async (t) => {
  const { env } = setup(t);
  const body = await (await login(env, ADMIN)).json();
  await env.DB.prepare("UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000Z'").run();
  const res = await worker.fetch(get('/status', ip('203.0.113.5', sessionHeader(body.session))), env);
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.error, 'session_expired');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures').first()).n, 0, 'no lockout row');
  const last = await env.DB.prepare("SELECT route, result, reason FROM signin_log WHERE reason LIKE 'session_%'").first();
  assert.deepEqual({ ...last }, { route: 'admin', result: 'failure', reason: 'session_idle' });
});

test('RT5: logout ends the session at once', async (t) => {
  const { env } = setup(t);
  const body = await (await login(env, ADMIN)).json();
  const out = await worker.fetch(post('/auth/logout', {}, sessionHeader(body.session)), env);
  assert.deepEqual(await out.json(), { ok: true, ended: true });
  assert.equal((await worker.fetch(get('/status', sessionHeader(body.session)), env)).status, 401);
  assert.equal((await worker.fetch(post('/auth/logout', {}), env)).status, 401, 'logout needs a token');
});

test('RT5: a wrong or unknown session token counts toward the lockout, and the lockout backs off', async (t) => {
  const { env } = setup(t);
  for (let i = 0; i < 10; i += 1) assert.equal((await worker.fetch(get('/status', ip('203.0.113.77', { 'X-Titan-Auth': `tsn_${'a'.repeat(43)}` })), env)).status, 401);
  assert.equal((await worker.fetch(get('/status', ip('203.0.113.77', authed)), env)).status, 429);
  const row = await env.DB.prepare('SELECT strikes FROM auth_failures').first();
  assert.equal(row.strikes, 1);
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS n FROM signin_log WHERE route = 'admin' AND reason = 'unknown_session'").first()).n >= 1);
});

test('RT5: the sign-in log is shown only behind auth, with a summary, and appears in no public or state route', async (t) => {
  const { env } = setup(t);
  await login(env, 'wrong', '203.0.113.5');
  await login(env, ADMIN, '203.0.113.6');
  assert.equal((await worker.fetch(get('/admin/security/signins'), env)).status, 401);
  assert.equal((await worker.fetch(get('/admin/security/signins', ip('203.0.113.5', { 'X-Titan-Auth': 'wrong' })), env)).status, 401);
  const res = await worker.fetch(get('/admin/security/signins?limit=10', authed), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.summary.success, 1);
  assert.ok(j.summary.failure >= 1);
  assert.ok(j.entries.some((e) => e.ip === '203.0.113.5' && e.reason === 'wrong_token' && e.userAgent === 'Test-Agent/1.0'));
  const failures = await (await worker.fetch(get('/admin/security/signins?result=failure', authed), env)).json();
  assert.ok(failures.entries.every((e) => e.result === 'failure'));
  for (const path of ['/', '/version', '/badge/pulse', '/gev/jwks']) {
    const text = await (await worker.fetch(get(path), env)).text();
    assert.ok(!text.includes('203.0.113'), `${path} holds no address`);
  }
});

test('RT5: logSignin never throws and cuts long or hostile values', async (t) => {
  const { env } = setup(t);
  await logSignin(env, new Request('https://worker.example/', { headers: { 'User-Agent': `agent${'x'.repeat(500)}`, 'CF-Connecting-IP': '203.0.113.1' } }), { route: 'login\nforged line', result: 'failure', reason: 'y'.repeat(500) });
  const row = await env.DB.prepare('SELECT user_agent, route, reason FROM signin_log').first();
  assert.ok(row.user_agent.length <= 200);
  assert.ok(!row.route.includes('\n'), 'control characters are removed');
  assert.ok(row.reason.length <= 60);
  await logSignin({ DB: null }, new Request('https://worker.example/'), { route: 'x', result: 'failure', reason: 'z' });
});

test('RT5: retention removes ended sessions, old log rows, and old limiter rows', async (t) => {
  const { env } = setup(t);
  await env.DB.prepare("INSERT INTO signin_log (at, ip, user_agent, route, result, reason) VALUES ('2020-01-01T00:00:00.000Z', '1.1.1.1', 'x', 'login', 'failure', 'wrong_token')").run();
  await env.DB.prepare("INSERT INTO sessions (id, created_at, last_seen_at, expires_at) VALUES ('old', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T12:00:00.000Z')").run();
  await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count, updated_at) VALUES ('k', '2020-01-01T00:00:00.000Z', 3, '2020-01-01T00:00:00.000Z')").run();
  await env.DB.prepare("INSERT INTO login_limits (key, window_start, failures, strikes, updated_at) VALUES ('ip:old', '2020-01-01T00:00:00.000Z', 1, 1, '2020-01-01T00:00:00.000Z')").run();
  const out = await pruneOldRows(env);
  assert.deepEqual([out.sessions, out.signin_log, out.rate_limits, out.login_limits], [1, 1, 1, 1]);
});

test('RT5: CORS allows the Pages origin only, and a login from another origin is refused before the handler', async (t) => {
  const { env } = setup(t);
  const ok = await worker.fetch(post('/auth/login', { token: ADMIN }, ip('203.0.113.5', { Origin: 'https://shreyas-tech7.github.io' })), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://shreyas-tech7.github.io');
  for (const origin of ['http://localhost:3000', 'https://evil.example', 'https://shreyas-tech7.github.io.evil.example', 'null']) {
    const res = await worker.fetch(post('/auth/login', { token: ADMIN }, ip('203.0.113.5', { Origin: origin })), env);
    assert.equal(res.status, 403, origin);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM signin_log WHERE result = 'success'").first()).n, 1, 'a refused origin never reached the handler');
});

test('RT5: a body over the size limit gets 413 before any handler, and a bad %-escape in a path gets 400', async (t) => {
  const { env } = setup(t);
  const big = await worker.fetch(new Request('https://worker.example/tasks', { method: 'POST', headers: { ...authed, 'content-type': 'application/json', 'content-length': '300000' }, body: '{}' }), env);
  assert.equal(big.status, 413);
  const bad = await worker.fetch(get('/chat/threads/%E0%A4%A', authed), env);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_path');
});

test('RT5: the public registration route has a rate limit and a client cap', async (t) => {
  const { env } = setup(t);
  const register = (addr) => worker.fetch(post('/oauth/mcp/register', { client_name: 'x', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, ip(addr)), env);
  for (let i = 0; i < 10; i += 1) assert.equal((await register('198.51.100.1')).status, 201);
  const limited = await register('198.51.100.1');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  // The table now holds 10 clients. Fill it to the cap with other clients.
  for (let i = 0; i < 40; i += 1) await env.DB.prepare('INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, grant_types, created_at) VALUES (?, ?, ?, ?, ?)').bind(`c${i}`, 'x', '[]', '[]', new Date().toISOString()).run();
  const capped = await register('198.51.100.2');
  assert.equal(capped.status, 429);
  assert.equal((await capped.json()).error, 'too_many_clients');
  // Retention drops a client that never got a token.
  await env.DB.prepare("UPDATE mcp_oauth_clients SET created_at = '2020-01-01T00:00:00.000Z'").run();
  const out = await pruneOldRows(env);
  assert.equal(out.unused_mcp_clients, 50);
});

test('RT5: the token route is rate limited for each client', async (t) => {
  const { env } = setup(t);
  const exchange = () => worker.fetch(new Request('https://worker.example/oauth/mcp/token', { method: 'POST', headers: { ...ip('198.51.100.3'), 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code' }) }), env);
  for (let i = 0; i < 60; i += 1) assert.notEqual((await exchange()).status, 429);
  assert.equal((await exchange()).status, 429);
});

// A route in the table that changes data or touches keys has a group other than public, hook, or oauth.
test('RT5: every route that is not public, hook, or oauth answers 401 with no token', async (t) => {
  const { env } = setup(t);
  const open = [];
  for (const r of ROUTES) {
    if (['public', 'hook', 'oauth'].includes(r.group)) continue;
    // GET /mcp answers 405 on purpose: the server offers no event stream. It returns no data.
    if (r.method === 'GET' && r.path === '/mcp') continue;
    const path = r.path.replace(/:[A-Za-z]+/g, 'x');
    const res = await worker.fetch(new Request(`https://worker.example${path}`, { method: r.method, headers: ip('203.0.113.123'), body: r.method === 'GET' ? undefined : '{}' }), env);
    if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(open, []);
});

test('RT5: every public route that writes is listed, and each one is limited', () => {
  const writes = ROUTES.filter((r) => r.group === 'public' && r.method !== 'GET').map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(writes, ['POST /auth/login', 'POST /oauth/mcp/register', 'POST /oauth/mcp/token']);
});

test('RT5: hostile bodies on every admin route never cause an unhandled error (500)', async (t) => {
  const { env } = setup(t);
  const bodies = ['{', '[]', '"text"', 'null', JSON.stringify({ a: 'x'.repeat(100_000) }), JSON.stringify({ id: { $ne: 1 }, provider: ['groq'], name: 7, url: 5 }), ''];
  const failures = [];
  for (const r of ROUTES) {
    if (r.group !== 'admin' || r.method === 'GET' || r.path.startsWith('/admin/_bench') || r.path === '/chat' || r.path === '/oauth/mcp/authorize') continue;
    const path = r.path.replace(/:[A-Za-z]+/g, 'zz');
    for (const body of bodies) {
      const res = await worker.fetch(new Request(`https://worker.example${path}`, { method: r.method, headers: { ...authed, 'content-type': 'application/json', ...ip('203.0.113.50') }, body: r.method === 'DELETE' && !body ? undefined : body }), env);
      // 502 and 503 are honest answers about an upstream or a missing setup. 500 means an unhandled error.
      if (res.status === 500) failures.push(`${r.method} ${r.path} <- ${body.slice(0, 20)} -> ${res.status}`);
      await res.arrayBuffer().catch(() => null);
    }
  }
  assert.deepEqual(failures, []);
});

test('RT5: the key form stores the key as a sealed secret and never returns it. It shows the last 4 characters only', async (t) => {
  const { world, env } = setup(t);
  const seen = [];
  const call = async (request) => {
    const res = await worker.fetch(request, env);
    seen.push(await res.clone().text());
    return res;
  };
  const saved = await (await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY }, authed))).json();
  assert.equal(saved.last4, FAKE_GROQ_KEY.slice(-4));
  for (const path of ['/admin/keys', '/admin/keys/events', '/status', '/health/full', '/admin/setup', '/admin/export']) await call(get(path, authed));
  await call(post('/admin/keys/groq/test', {}, authed));
  const all = seen.join('\n') + JSON.stringify(env.DB.dump());
  assert.ok(!all.includes(FAKE_GROQ_KEY), 'the key is in no response and in no D1 row');
  assert.equal(world.github.open('GROQ_API_KEY'), FAKE_GROQ_KEY, 'it sits in the GitHub secret, sealed');
  const row = await env.DB.prepare('SELECT fingerprint, last4 FROM provider_keys WHERE provider = ?').bind('groq').first();
  assert.equal(row.last4, FAKE_GROQ_KEY.slice(-4));
  assert.match(row.fingerprint, /^[0-9a-f]{12}$/);
});
