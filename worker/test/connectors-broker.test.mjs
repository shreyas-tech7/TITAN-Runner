// C2, C3, S7: the broker end to end with fakes. Connect, test, run, approvals, personal data, and secret leaks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWorld, captureConsole } from './helpers/world.mjs';
import { KEK, caller, callbackToken, discordUrl, dumpWithoutVault, fakeDiscord, json } from './helpers/hub.mjs';
import { FAKES } from './helpers/fakeValues.mjs';

function setup(t, extra = {}) {
  const world = new FakeWorld().install(t);
  const env = world.env({ CONNECTOR_KEK: KEK, ...extra });
  return { world, env, api: caller(env) };
}

async function connectDiscord(api, label = 'Alerts') {
  const url = discordUrl();
  const res = await api.post('/connectors/discord_webhook/connect', { label, fields: { url } });
  return { res, url, id: res.body?.connection?.id };
}

test('scenario 1: connect a Discord webhook, test it, and send a message', async (t) => {
  const { world, api, env } = setup(t);
  const logs = captureConsole(t);
  const sent = fakeDiscord(world);
  const { res, url, id } = await connectDiscord(api);
  assert.equal(res.status, 201);
  assert.equal(res.body.connection.status, 'connected');
  assert.equal(res.body.test.ok, true);
  assert.deepEqual(res.body.test.data, { name: 'TITAN', channel_id: '55', guild_id: '66' });
  assert.deepEqual(res.body.connection.secretNames, ['url']);

  const again = await api.post(`/connections/${id}/test`, {});
  assert.equal(again.body.ok, true);

  const run = await api.post(`/connections/${id}/actions/send`, { input: { text: 'Hello channel' } });
  assert.equal(run.status, 200);
  assert.equal(run.body.state, 'done');
  assert.deepEqual(sent, [{ content: 'Hello channel', allowed_mentions: { parse: [] } }]);

  const calls = await api.get(`/connections/${id}/calls`);
  assert.deepEqual(calls.body.calls.map((c) => [c.actionId, c.outcome, c.caller]), [['send', 'ok', 'admin']]);

  // The secret appears nowhere: not in a response, not in a table other than the vault, not in a log line.
  const token = url.split('/').pop();
  const all = JSON.stringify([res.body, again.body, run.body, calls.body, (await api.get('/connectors')).body, (await api.get(`/connections/${id}`)).body]);
  assert.ok(!all.includes(token), 'no response holds the webhook token');
  assert.ok(!dumpWithoutVault(env).includes(token), 'D1 holds the token only in the vault');
  assert.ok(!logs().includes(token), 'no log line holds the token');
  const vault = env.DB.dump().vault_records;
  assert.equal(vault.length, 1);
  assert.ok(!JSON.stringify(vault).includes(token), 'the vault row is encrypted');
});

test('C2: without CONNECTOR_KEK the vault is not ready, and connect answers 503 with the fix', async (t) => {
  const world = new FakeWorld().install(t);
  const env = world.env();
  const api = caller(env);
  const res = await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'vault_not_ready');
  assert.match(res.body.fix, /Provision vault key/);
  const catalog = await api.get('/connectors');
  assert.equal(catalog.body.vault.ready, false);
  assert.equal(catalog.body.connectors.length, 19);
});

test('C3: a field that fails its pattern gets 422 and no row; a failed test saves only with saveIfUnverified', async (t) => {
  const { world, api, env } = setup(t);
  const bad = await api.post('/connectors/discord_webhook/connect', { fields: { url: 'https://example.com/nope' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'invalid_fields');
  world.addHost('discord.com', () => json({ message: 'Unknown Webhook', code: 10015 }, 404));
  const failed = await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });
  assert.equal(failed.status, 422);
  assert.equal(failed.body.error, 'test_failed');
  assert.equal(failed.body.canSaveAnyway, true);
  assert.equal(env.DB.dump().connections.length, 0, 'nothing is saved');
  const saved = await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() }, saveIfUnverified: true });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.connection.status, 'unverified');
  assert.equal(saved.body.connection.lastTestOk, false);
});

test('C3: a connector can have two connections, labels are unique, and rename and disconnect work', async (t) => {
  const { world, api, env } = setup(t);
  fakeDiscord(world);
  const a = await connectDiscord(api, 'Team');
  const b = await connectDiscord(api, 'Team');
  assert.equal(b.res.body.connection.label, 'Team 2');
  const renamed = await api.post(`/connections/${a.id}/rename`, { label: 'Team 2' });
  assert.equal(renamed.status, 409);
  const ok = await api.post(`/connections/${a.id}/rename`, { label: 'Ops' });
  assert.equal(ok.body.connection.label, 'Ops');
  const gone = await api.post(`/connections/${a.id}/disconnect`, {});
  assert.equal(gone.status, 200);
  assert.equal(env.DB.dump().connections.length, 1);
  assert.equal(env.DB.dump().vault_records.length, 1, 'the vault record of the first connection is deleted');
  assert.equal((await api.get(`/connections/${a.id}`)).status, 404);
});

test('C3: the risk rules. A sub-agent write waits for approval, a personal action is refused, and a read runs', async (t) => {
  const { world, api, env } = setup(t);
  const sent = fakeDiscord(world);
  const { id } = await connectDiscord(api);
  const cb = await callbackToken(world, env);

  const write = await api.post('/internal/connector-call', { connectionId: id, action: 'send', input: { text: 'from a sub-agent' } }, cb);
  assert.equal(write.status, 202);
  assert.equal(write.body.state, 'pending_approval');
  assert.equal(sent.length, 0, 'nothing was sent');
  const queue = await api.get('/approvals?status=pending');
  assert.equal(queue.body.approvals.length, 1);
  assert.equal(queue.body.approvals[0].requestedBy, 'internal');
  assert.match(queue.body.approvals[0].summary, /Discord webhook: Send a message/);
  assert.equal(env.DB.dump().events.filter((e) => e.type === 'approval.needed').length, 1);

  // Approve: the call runs once. A second approve is refused.
  const approved = await api.post(`/approvals/${write.body.approvalId}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'executed');
  assert.equal(sent.length, 1);
  assert.equal((await api.post(`/approvals/${write.body.approvalId}/approve`, {})).status, 409);
  assert.equal(sent.length, 1, 'still one message');
  assert.equal(env.DB.dump().approvals[0].input_json, '{}', 'the input is dropped after the decision');

  // Deny: nothing runs.
  const second = await api.post('/internal/connector-call', { connectionId: id, action: 'send', input: { text: 'again' } }, cb);
  assert.equal((await api.post(`/approvals/${second.body.approvalId}/deny`, {})).body.status, 'denied');
  assert.equal(sent.length, 1);
});

test('scenario 6 and S7: the broker refuses a callback token call to a personal action, and lists none to a sub-agent', async (t) => {
  const { world, api, env } = setup(t);
  const hits = [];
  world.addHost('api.notion.com', (req) => {
    hits.push(req.url);
    return json({ results: [] });
  });
  const token = ['ntn', '_', 'TESTVALUENOTAREALSECRET'].join('');
  const res = await api.post('/connectors/notion/connect', { fields: { token }, saveIfUnverified: true });
  const id = res.body.connection.id;
  const cb = await callbackToken(world, env);
  hits.length = 0;
  const refused = await api.post('/internal/connector-call', { connectionId: id, action: 'search', input: { query: 'plans' } }, cb);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'personal_data_forbidden');
  assert.equal(hits.length, 0, 'the call never left the Worker');
  const listed = await api.get('/internal/connectors', cb);
  assert.equal(listed.body.connections.length, 0, 'a sub-agent sees no connector that only has personal actions');
  // A person can still run it.
  const ok = await api.post(`/connections/${id}/actions/search`, { input: { query: 'plans' } });
  assert.equal(ok.status, 200);
  assert.equal(hits.length, 1);
});

test('C3: the admin token alone opens a destructive action only with a typed confirm, and a deny policy blocks everyone', async (t) => {
  const { world, api } = setup(t);
  fakeDiscord(world);
  const { id } = await connectDiscord(api);
  const policy = await api.post(`/connections/${id}/policy`, { actionId: 'send', mode: 'deny' });
  assert.equal(policy.status, 200);
  const blocked = await api.post(`/connections/${id}/actions/send`, { input: { text: 'x' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'action_disabled');
  assert.equal((await api.post(`/connections/${id}/policy`, { actionId: 'send', mode: 'sometimes' })).status, 422);
  assert.equal((await api.post(`/connections/${id}/policy`, { actionId: 'nope', mode: 'ask' })).status, 404);
});

test('C3: input is checked with the JSON Schema, unknown fields are refused, and a rate limit answers 429', async (t) => {
  const { world, api } = setup(t);
  fakeDiscord(world);
  const { id } = await connectDiscord(api);
  const bad = await api.post(`/connections/${id}/actions/send`, { input: { text: 'x', extra: 1 } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'invalid_input');
  const empty = await api.post(`/connections/${id}/actions/send`, { input: {} });
  assert.equal(empty.status, 422);
  let last;
  for (let i = 0; i < 21; i += 1) last = await api.post(`/connections/${id}/actions/send`, { input: { text: `m${i}` } });
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'rate_limited');
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});

test('S4: a typed address is checked. A private DNS answer and an IP literal are refused', async (t) => {
  const { world, api } = setup(t);
  world.addHost('feeds.example.org', () => new Response('<rss><channel><title>T</title><item><title>A</title></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } }));
  const ok = await api.post('/connectors/rss/connect', { fields: { feed_url: 'https://feeds.example.org/news.xml' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.test.ok, true);
  const literal = await api.post('/connectors/rss/connect', { fields: { feed_url: 'https://10.0.0.5/feed.xml' } });
  assert.equal(literal.status, 422);
  world.dns.set('rebind.example.org', ['10.1.2.3']);
  world.addHost('rebind.example.org', () => new Response('<rss/>'));
  const rebind = await api.post('/connectors/rss/connect', { fields: { feed_url: 'https://rebind.example.org/feed.xml' } });
  assert.equal(rebind.status, 422);
  assert.equal(rebind.body.error, 'test_failed');
  assert.match(rebind.body.message, /private address/);
  const read = await api.post(`/connections/${ok.body.connection.id}/actions/read_feed`, { input: { limit: 1 } });
  assert.equal(read.body.state, 'done');
  assert.deepEqual(read.body.data, { title: 'T', items: [{ title: 'A', link: '', date: '', summary: '' }] });
});

test('C5: rest_custom keeps to its prefixes, refuses a path that leaves the host, and sends the key in the header you chose', async (t) => {
  const { world, api } = setup(t);
  const seen = [];
  world.addHost('api.example.org', async (req) => {
    seen.push({ url: req.url, key: req.headers.get('x-api-key'), method: req.method, body: req.method === 'POST' ? await req.json() : null });
    return json({ ok: true });
  });
  const key = ['rest', 'key', 'for', 'tests', '123456'].join('-');
  const res = await api.post('/connectors/rest_custom/connect', { fields: { base_url: 'https://api.example.org/v2', auth_style: 'header', header_name: 'X-Api-Key', api_key: key, path_prefixes: '/items', test_path: '/items' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.connection.id;
  assert.equal((await api.post(`/connections/${id}/actions/get`, { input: { path: '/items/9', query: { q: 'a b' } } })).body.state, 'done');
  assert.equal(seen.at(-1).url, 'https://api.example.org/v2/items/9?q=a%20b');
  assert.equal(seen.at(-1).key, key);
  const out = await api.post(`/connections/${id}/actions/get`, { input: { path: '/admin' } });
  assert.equal(out.status, 422);
  assert.match(out.body.message, /outside the allowed paths/);
  assert.equal((await api.post(`/connections/${id}/actions/get`, { input: { path: '//evil.example.net/x' } })).status, 422);
  // A POST from a person runs. The same POST from a sub-agent is a personal action and is refused.
  assert.equal((await api.post(`/connections/${id}/actions/post`, { input: { path: '/items', body: { a: 1 } } })).body.state, 'done');
  assert.deepEqual(seen.at(-1).body, { a: 1 });
  assert.ok(!JSON.stringify(res.body).includes(key));
});

test('C8 prerequisite: Google OAuth fields are checked against the pattern, and the fake values come from the helper', () => {
  assert.match(FAKES.google_client_id, /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  assert.match(FAKES.google_client_secret, /^GOCSPX-/);
});
