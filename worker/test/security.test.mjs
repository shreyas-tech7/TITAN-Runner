// S1 to S4, S7 (in part): token scopes, lockout, CORS, the outbound guard, and the route table.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { LOCKOUT, allowedOrigins, checkLockout, recordAuthFailure } from '../src/lib/auth.js';
import { ROUTES, groupForPath, matchRoute } from '../src/routes.js';
import { SafeFetchError, checkUrl, isPrivateAddress, looksLikeIp, safeFetch } from '../src/lib/safeFetch.js';
import { FakeWorld, authed, captureConsole, get, post } from './helpers/world.mjs';

const ORIGIN = 'https://shreyas-tech7.github.io';

function setup(t) {
  const world = new FakeWorld().install(t);
  return { world, env: world.env() };
}
const withIp = (ip, headers = {}) => ({ 'CF-Connecting-IP': ip, ...headers });

test('S1: every route has exactly one known group, and no method and path appear twice', () => {
  const seen = new Set();
  for (const r of ROUTES) {
    assert.ok(['public', 'admin', 'internal', 'mcp', 'hook', 'oauth'].includes(r.group), `${r.method} ${r.path}`);
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
});

test('S1: /internal routes are in the internal group and /admin routes in the admin group', () => {
  for (const r of ROUTES) {
    if (r.path.startsWith('/internal/')) assert.equal(r.group, 'internal', r.path);
    if (r.path.startsWith('/admin/') && !r.path.startsWith('/admin/_bench')) assert.equal(r.group, 'admin', r.path);
  }
  assert.equal(groupForPath('/internal/ping'), 'internal');
  assert.equal(groupForPath('/admin/keys/groq/test'), 'admin');
  assert.equal(matchRoute('POST', '/tasks/abc/retry').params.id, 'abc');
  assert.equal(matchRoute('GET', '/nope'), null);
});

test('S1: the docs table lists every route', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../../docs/RUNTIME.md', import.meta.url), 'utf8');
  const missing = ROUTES.filter((r) => !r.path.startsWith('/admin/_bench') && !doc.includes(r.path)).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(missing, [], 'docs/RUNTIME.md must list every route in its token table');
});

test('scenario 9 / S2: ten wrong tokens give 429 for the client, other clients still work, and access returns after the window', async (t) => {
  const { env } = setup(t);
  const attempt = (ip, token) => worker.fetch(get('/status', withIp(ip, { 'X-Titan-Auth': token })), env);
  for (let i = 0; i < LOCKOUT.maxFailures; i += 1) assert.equal((await attempt('203.0.113.7', `wrong-${i}`)).status, 401);
  const locked = await attempt('203.0.113.7', 'wrong-again');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('Retry-After')) > 0);
  assert.equal((await locked.json()).error, 'locked_out');
  // The right token from the locked client is also refused during the lock.
  assert.equal((await worker.fetch(get('/status', withIp('203.0.113.7', authed)), env)).status, 429);
  // Another client is not affected.
  assert.equal((await worker.fetch(get('/status', withIp('198.51.100.9', authed)), env)).status, 200);
  // The lock is per route group: the same client can still use a public route.
  assert.equal((await worker.fetch(get('/', withIp('203.0.113.7')), env)).status, 200);
  // After the window, access works again.
  await env.DB.prepare("UPDATE auth_failures SET locked_until = '2020-01-01T00:00:00.000Z', window_start = '2020-01-01T00:00:00.000Z'").run();
  assert.equal((await worker.fetch(get('/status', withIp('203.0.113.7', authed)), env)).status, 200);
});

test('S2: the table holds a hash and not the address, a missing token is not counted, and old rows are pruned', async (t) => {
  const { env } = setup(t);
  await worker.fetch(get('/status', withIp('203.0.113.7', { 'X-Titan-Auth': 'wrong' })), env);
  await worker.fetch(get('/status', withIp('203.0.113.8')), env); // no token at all
  const rows = (await env.DB.prepare('SELECT * FROM auth_failures').all()).results;
  assert.equal(rows.length, 1, 'only the wrong token counts');
  assert.match(rows[0].key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(env.DB.dump()).includes('203.0.113'), 'the raw address is never stored');
  await env.DB.prepare("UPDATE auth_failures SET updated_at = '2020-01-01T00:00:00.000Z'").run();
  const { pruneAuthFailures } = await import('../src/lib/auth.js');
  assert.equal(await pruneAuthFailures(env), 1);
  const window = await (async () => {
    const req = get('/status', withIp('1.2.3.4'));
    await recordAuthFailure(req, env, 'admin', new Date('2026-10-08T12:00:00Z'));
    return checkLockout(req, env, 'admin', new Date('2026-10-08T12:05:00Z'));
  })();
  assert.equal(window.locked, false);
});

test('S3: CORS allows the Pages origin and the two dev origins, sends Vary: Origin, and refuses another origin', async (t) => {
  const { env } = setup(t);
  for (const origin of [ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000']) {
    const pre = await worker.fetch(new Request('https://worker.example/admin/keys', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } }), env);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    assert.equal(pre.headers.get('vary'), 'Origin');
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Titan-Auth/);
  }
  const evil = await worker.fetch(new Request('https://worker.example/admin/keys', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }), env);
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(evil.headers.get('vary'), 'Origin');
  // A real request from another origin never reaches a handler and gets no CORS header.
  const real = await worker.fetch(get('/status', { Origin: 'https://evil.example', ...authed }), env);
  assert.equal(real.status, 403);
  assert.equal(real.headers.get('access-control-allow-origin'), null);
  // A tool without an Origin header is fine, and a normal response carries the request id.
  const tool = await worker.fetch(get('/status', authed), env);
  assert.equal(tool.status, 200);
  assert.match(tool.headers.get('x-request-id'), /^req_[0-9a-f]{12}$/);
  assert.equal(tool.headers.get('access-control-allow-origin'), null);
  assert.equal(allowedOrigins({ TITAN_ALLOWED_ORIGINS: 'https://dash.example' }).includes('https://dash.example'), true);
});

test('R5: every request writes one JSON log line with the request id, the route group, the status and the duration, and never a token', async (t) => {
  const { env } = setup(t);
  const logs = captureConsole(t);
  const res = await worker.fetch(get('/status', authed), env);
  await worker.fetch(get('/status', { 'X-Titan-Auth': 'super-secret-wrong-token-value' }), env);
  const lines = logs().split('\n').filter((l) => l.startsWith('{') && l.includes('"rid"'));
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.rid, res.headers.get('x-request-id'));
  assert.deepEqual([first.group, first.route, first.status, first.token], ['admin', '/status', 200, 'admin']);
  assert.equal(typeof first.ms, 'number');
  assert.ok(!logs().includes('super-secret-wrong-token-value'));
  assert.ok(!logs().includes(authed['X-Titan-Auth']));
});

test('an unhandled error returns 500 with the request id and no stack', async (t) => {
  const { env } = setup(t);
  captureConsole(t);
  // Run one good request first, so the one-time migration step is done and cannot answer 503 here.
  assert.equal((await worker.fetch(get('/status', authed), env)).status, 200);
  const broken = { ...env, DB: { prepare() { throw new Error('boom with /secret/path'); } } };
  const res = await worker.fetch(get('/status', authed), broken);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'internal_error');
  assert.ok(body.requestId && body.message.includes(body.requestId));
  assert.ok(!JSON.stringify(body).includes('/secret/path'));
});

test('GET /version is public and shows the commit that deploy set', async (t) => {
  const { env } = setup(t);
  const body = await (await worker.fetch(get('/version'), { ...env, TITAN_COMMIT: 'abc1234', TITAN_BUILD_TIME: '2026-10-08T00:00:00Z' })).json();
  assert.deepEqual(body, { service: 'titan-runner-brain', commit: 'abc1234', builtAt: '2026-10-08T00:00:00Z', schemaVersion: body.schemaVersion });
  assert.ok(body.schemaVersion >= 2);
  assert.equal((await worker.fetch(get('/'), env)).status, 200);
});

// --- S4 -----------------------------------------------------------------------------------------------------------

test('S4: the guard allows https on an allowlisted public host and nothing else', () => {
  const allow = ['api.example.com', '.trusted.org'];
  assert.equal(checkUrl('https://api.example.com/x', allow).ok, true);
  assert.equal(checkUrl('https://a.b.trusted.org/x', allow).ok, true);
  assert.equal(checkUrl('https://trusted.org/x', allow).ok, true);
  const bad = {
    'http://api.example.com/x': 'not_https',
    'https://other.example.com/x': 'host_not_allowed',
    'https://user:pw@api.example.com/x': 'credentials_in_url',
    'https://api.example.com:8443/x': 'bad_port',
    'https://127.0.0.1/x': 'not_public',
    'https://[::1]/x': 'not_public',
    'https://2130706433/x': 'not_public',
    'https://0x7f000001/x': 'not_public',
    'https://localhost/x': 'not_public',
    'https://intranet/x': 'not_public',
    'https://box.internal/x': 'not_public',
    'ftp://api.example.com/x': 'not_https',
    'nonsense': 'bad_url',
  };
  for (const [url, code] of Object.entries(bad)) {
    const r = checkUrl(url, [...allow, '127.0.0.1', 'localhost', 'intranet', 'box.internal', '2130706433', '0x7f000001']);
    assert.equal(r.ok, false, url);
    assert.equal(r.code, code, url);
  }
  assert.equal(looksLikeIp('1.2.3.4'), true);
  assert.equal(looksLikeIp('example.com'), false);
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('S4: a redirect is refused, a slow host times out, a big response is cut, and the auth header is never logged', async (t) => {
  const world = new FakeWorld().install(t);
  const logs = captureConsole(t);
  world.addHost('redirect.example.com', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
  world.addHost('slow.example.com', () => new Promise(() => {}));
  world.addHost('big.example.com', () => new Response('x'.repeat(5000)));
  const secret = 'Bearer super-secret-token-value-123';
  await assert.rejects(() => safeFetch({}, 'https://redirect.example.com/a', { headers: { authorization: secret } }, { allow: ['redirect.example.com'] }), (e) => e instanceof SafeFetchError && e.code === 'redirect_refused');
  await assert.rejects(() => safeFetch({}, 'https://slow.example.com/a', {}, { allow: ['slow.example.com'], timeoutMs: 50 }), (e) => e.code === 'timeout');
  const big = await safeFetch({}, 'https://big.example.com/a', {}, { allow: ['big.example.com'], maxBytes: 1000 });
  await assert.rejects(() => big.text(), /larger than 1000 bytes|response_too_large/);
  await assert.rejects(() => safeFetch({}, 'https://nope.example.com/a', {}, { allow: ['redirect.example.com'] }), (e) => e.code === 'host_not_allowed');
  assert.ok(!logs().includes('super-secret-token-value'));
});

test('S4: a host that resolves to a private address is refused when DNS checking is on', async (t) => {
  const world = new FakeWorld().install(t);
  world.addHost('rebind.example.com', () => new Response('ok'));
  world.dns.set('rebind.example.com', ['10.1.2.3']);
  await assert.rejects(() => safeFetch({}, 'https://rebind.example.com/', {}, { allow: ['rebind.example.com'], checkDns: true }), (e) => e.code === 'not_public');
  world.dns.set('rebind.example.com', ['93.184.216.34']);
  const ok = await safeFetch({}, 'https://rebind.example.com/', {}, { allow: ['rebind.example.com'], checkDns: true });
  assert.equal(await ok.text(), 'ok');
});

test('S4: the test host map works only when TITAN_TEST_MODE is 1, and the deployed config never sets it', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(String(url));
    return new Response('ok');
  });
  const map = JSON.stringify({ 'api.example.com': 'http://127.0.0.1:9100/fake' });
  await safeFetch({ TITAN_TEST_MODE: '1', TITAN_TEST_HOST_MAP: map }, 'https://api.example.com/x', {}, { allow: ['api.example.com'] });
  assert.equal(seen[0], 'http://127.0.0.1:9100/fake/x');
  await safeFetch({ TITAN_TEST_HOST_MAP: map }, 'https://api.example.com/x', {}, { allow: ['api.example.com'] });
  assert.equal(seen[1], 'https://api.example.com/x', 'without the flag the map is ignored');
  await assert.rejects(() => safeFetch({ TITAN_TEST_MODE: '1', TITAN_TEST_HOST_MAP: map }, 'https://evil.example.com/x', {}, { allow: ['api.example.com'] }), (e) => e.code === 'host_not_allowed');
});
