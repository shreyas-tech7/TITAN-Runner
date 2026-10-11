// H1, H2, H3: the health rows, the full diagnosis, and the setup checklist.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWorld } from './helpers/world.mjs';
import { KEK, caller, discordUrl, fakeDiscord } from './helpers/hub.mjs';

function setup(t, extra = {}) {
  const world = new FakeWorld().install(t);
  world.addHost('shreyas-tech7.github.io', () => new Response('<html></html>', { headers: { 'last-modified': new Date(Date.now() - 3 * 3600_000).toUTCString() } }));
  world.addHost('titan-gev.onrender.com', () => new Response('ok'));
  const env = world.env({ CONNECTOR_KEK: KEK, TITAN_COMMIT: 'abc1234', ...extra });
  return { world, env, api: caller(env) };
}

const byId = (rows, id) => rows.find((r) => r.id === id);

test('H1: GET /health/full has one row for each part, with a state, a latency, and a fix for what is not ok', async (t) => {
  const { world, api, env } = setup(t);
  world.github.setByHand('GROQ_API_KEY', 'x'.repeat(30));
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('pulse.lastHeartbeatAt', ?, ?)").bind(new Date(Date.now() - 20 * 60_000).toISOString(), new Date().toISOString()).run();
  const res = await api.get('/health/full');
  assert.equal(res.status, 200);
  const rows = res.body.rows;
  for (const id of ['worker', 'd1', 'pulse', 'pages', 'callback', 'queue', 'vault', 'ext:gev', 'vms']) assert.ok(byId(rows, id), `row ${id}`);
  assert.equal(byId(rows, 'worker').state, 'ok');
  assert.match(byId(rows, 'worker').detail, /abc1234/);
  assert.equal(byId(rows, 'pulse').state, 'ok');
  assert.match(byId(rows, 'pulse').detail, /20 minutes ago/);
  assert.equal(byId(rows, 'pages').state, 'ok');
  assert.equal(byId(rows, 'vault').state, 'ok');
  assert.equal(byId(rows, 'ext:gev').state, 'ok');
  assert.equal(byId(rows, 'ext:render').state, 'unknown', 'no address is set for the Render sub-servers');
  assert.match(byId(rows, 'ext:render').fix.text, /Settings/);
  assert.ok(rows.filter((r) => !r.id.startsWith('ext:r') && r.id !== 'ext:hf').every((r) => typeof r.latencyMs === 'number' && r.checkedAt), 'each checked row has a latency and a time');
  assert.ok(rows.some((r) => r.id === 'key:groq' && r.state === 'warn'), 'a saved key that no one verified is a warning');
  assert.equal(res.body.cached, false);
  assert.equal(res.body.summary.ok > 3, true);
  // The answer is cached for 30 seconds.
  assert.equal((await api.get('/health/full')).body.cached, true);
});

test('H1: a down service, a stale pulse, and a stuck task show as problems with a fix', async (t) => {
  const { world, api, env } = setup(t);
  world.addHost('titan-gev.onrender.com', () => new Response('sleeping', { status: 503 }));
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('pulse.lastHeartbeatAt', ?, ?)").bind(new Date(Date.now() - 90 * 60_000).toISOString(), new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO subagents (id, task_type, brief, status, source, queued_at, dispatched_at) VALUES ('stuck-1', 'auto', 'b', 'dispatched', 'dashboard', ?, ?)").bind(new Date(Date.now() - 60 * 60_000).toISOString(), new Date(Date.now() - 60 * 60_000).toISOString()).run();
  const rows = (await api.get('/health/full')).body.rows;
  assert.equal(byId(rows, 'ext:gev').state, 'down');
  assert.equal(byId(rows, 'pulse').state, 'down');
  assert.equal(byId(rows, 'pulse').fix.action.path, '/admin/pulse/run');
  assert.equal(byId(rows, 'queue').state, 'warn');
  assert.match(byId(rows, 'queue').detail, /1 stuck/);
});

test('H1: the Worker without a vault key shows a warning with the exact fix', async (t) => {
  const { api } = setup(t, { CONNECTOR_KEK: undefined });
  const rows = (await api.get('/health/full')).body.rows;
  assert.equal(byId(rows, 'vault').state, 'warn');
  assert.match(byId(rows, 'vault').fix.text, /Provision vault key/);
});

test('H1: connectors appear in the rows, and a connection that needs a new sign in is down', async (t) => {
  const { world, api, env } = setup(t);
  fakeDiscord(world);
  const c = await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });
  let rows = (await api.get('/health/full')).body.rows;
  assert.equal(byId(rows, `connector:${c.body.connection.id}`).state, 'ok');
  await env.DB.prepare("UPDATE connections SET status = 'needs_reconnect', last_error = 'Sign in again.'").run();
  await env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'health.cache'").run();
  rows = (await api.get('/health/full')).body.rows;
  assert.equal(byId(rows, `connector:${c.body.connection.id}`).state, 'down');
  assert.equal(byId(rows, `connector:${c.body.connection.id}`).fix.action.href, '/connectors/');
});

test('H1: the external health addresses are validated and saved in Settings', async (t) => {
  const { world, api } = setup(t);
  world.addHost('orch.example.org', () => new Response('ok'));
  assert.equal((await api.post('/admin/health/urls', { urls: [{ id: 'orch', label: 'Orchestrator', url: 'http://orch.example.org/healthz' }] })).status, 422);
  assert.equal((await api.post('/admin/health/urls', { urls: [{ id: 'Bad Id', label: 'x', url: 'https://orch.example.org/' }] })).status, 422);
  assert.equal((await api.post('/admin/health/urls', { urls: [{ id: 'a', label: 'A', url: 'https://a.example.org/' }, { id: 'a', label: 'B', url: 'https://b.example.org/' }] })).status, 422, 'ids are unique');
  const saved = await api.post('/admin/health/urls', { urls: [{ id: 'gev', label: 'GEV', url: 'https://titan-gev.onrender.com/healthz' }, { id: 'orch', label: 'Orchestrator', url: 'https://orch.example.org/healthz' }, { id: 'rs', label: 'Render', url: 'https://rs.example.org/healthz' }] });
  assert.equal(saved.status, 200);
  world.addHost('rs.example.org', () => new Response('ok'));
  const rows = (await api.get('/health/full')).body.rows;
  assert.equal(byId(rows, 'ext:orch').state, 'ok');
  assert.equal(byId(rows, 'ext:rs').state, 'ok');
  assert.equal(byId(rows, 'ext:hf'), undefined, 'the placeholder rows go away once addresses are set');
});

test('H2: the full diagnosis checks the listed items and the report holds no secret', async (t) => {
  const { world, api, env } = setup(t);
  world.github.setByHand('GROQ_API_KEY', 'x'.repeat(30));
  const res = await api.post('/admin/diagnose/full', {});
  assert.equal(res.status, 200);
  const items = res.body.items;
  for (const id of ['version', 'd1', 'pat-read', 'secret-roundtrip', 'pat-issues', 'callback', 'variable', 'pages', 'vault', 'mcp', 'cors', 'lockout']) assert.ok(byId(items, id), `item ${id}`);
  assert.equal(byId(items, 'd1').state, 'ok');
  assert.equal(byId(items, 'secret-roundtrip').state, 'ok');
  assert.equal(byId(items, 'mcp').state, 'ok');
  assert.match(byId(items, 'mcp').detail, /401/);
  assert.equal(byId(items, 'cors').state, 'ok');
  assert.equal(byId(items, 'lockout').state, 'ok');
  assert.equal(byId(items, 'pat-issues').state, 'unknown', 'honest: no safe probe exists');
  assert.match(res.body.report, /^TITAN full diagnosis, /);
  assert.match(res.body.report, /\[OK\] D1 read and write: Read and write work\./);
  for (const secret of [env.GITHUB_PAT, KEK, env.TITAN_ADMIN_TOKEN]) assert.ok(!res.text.includes(secret), 'no secret in the report');
  assert.equal(env.DB.dump().vault_records.length, 0);
});

test('H3: the setup checklist turns green item by item', async (t) => {
  const { world, api } = setup(t);
  let res = await api.get('/admin/setup');
  assert.equal(res.body.total, 6);
  assert.deepEqual(res.body.items.map((i) => [i.id, i.done]), [['worker', true], ['pat', false], ['vault', true], ['providers', false], ['channel', false], ['mcp', false]]);
  assert.equal(res.body.complete, false);
  assert.equal(res.body.items.find((i) => i.id === 'channel').link.href, '/connectors/');
  fakeDiscord(world);
  await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });
  await api.post('/admin/mcp/tokens', { label: 't', scopes: ['status:read'] });
  res = await api.get('/admin/setup');
  assert.equal(res.body.items.find((i) => i.id === 'channel').done, true);
  assert.equal(res.body.items.find((i) => i.id === 'mcp').done, true);
  assert.equal(res.body.done, 4);
});
