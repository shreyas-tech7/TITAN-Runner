// T1 to T5, C7, M1, M2: Telegram with a fake Bot API, the notification router, and the MCP server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { routeEvents } from '../src/connectors/notifyRouter.js';
import { emitEvent } from '../src/notify.js';
import { FakeWorld, captureConsole } from './helpers/world.mjs';
import { KEK, callbackToken, caller, discordUrl, dumpWithoutVault, fakeDiscord, fakeTelegram, json, telegramToken } from './helpers/hub.mjs';

function setup(t, extra = {}) {
  const world = new FakeWorld().install(t);
  const env = world.env({ CONNECTOR_KEK: KEK, ...extra });
  return { world, env, api: caller(env) };
}

// --- Telegram -------------------------------------------------------------------------------------------------------

async function connectTelegram(api, calls) {
  const res = await api.post('/connectors/telegram/connect', { fields: { token: telegramToken() } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const hook = calls.find((c) => c.method === 'setWebhook').payload;
  return { res, cid: res.body.connection.id, secret: hook.secret_token, hook };
}

let updateId = 100;
const sendUpdate = (api, cid, secret, update) => api.call('POST', `/hooks/telegram/${cid}`, JSON.stringify({ update_id: (updateId += 1), ...update }), { 'X-Telegram-Bot-Api-Secret-Token': secret });
const say = (chatId, text, type = 'private') => ({ message: { message_id: 1, chat: { id: chatId, type }, from: { id: chatId }, text } });
const sentTo = (calls, chatId) => calls.filter((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(chatId)).map((c) => c.payload.text);

async function pair(api, calls, cid, secret, chatId = 42) {
  const code = (await api.post(`/connections/${cid}/telegram/pair`, {})).body.code;
  await sendUpdate(api, cid, secret, say(chatId, `/pair ${code}`));
  return code;
}

test('scenario 9 / T1 and T2: connect sets the webhook with a secret token, and the owner pairs with a one-time code', async (t) => {
  const { world, api, env } = setup(t);
  const logs = captureConsole(t);
  const calls = fakeTelegram(world);
  const { res, cid, secret, hook } = await connectTelegram(api, calls);
  assert.deepEqual(calls.map((c) => c.method).slice(0, 3), ['getMe', 'getMe', 'setWebhook'].slice(0, 3));
  assert.equal(hook.url, `https://worker.example/hooks/telegram/${cid}`);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.deepEqual(hook.allowed_updates, ['message', 'callback_query']);
  assert.equal(res.body.botUsername, 'titan_test_bot');
  assert.ok(!res.text.includes(telegramToken()) && !res.text.includes(secret), 'neither the bot token nor the webhook secret is in the answer');

  // The wrong secret header gets 401. A missing hook gets 404.
  assert.equal((await sendUpdate(api, cid, 'wrong', say(42, '/status'))).status, 401);
  assert.equal((await sendUpdate(api, 'c_unknown', secret, say(42, '/status'))).status, 404);

  // Before pairing, the bot answers nobody.
  await sendUpdate(api, cid, secret, say(42, '/status'));
  assert.deepEqual(sentTo(calls, 42), []);

  // A wrong code does not pair. A right code does.
  const code = (await api.post(`/connections/${cid}/telegram/pair`, {})).body.code;
  assert.match(code, /^[0-9a-f]{8}$/);
  await sendUpdate(api, cid, secret, say(42, '/pair 00000000'));
  assert.equal((await api.get(`/connections/${cid}`)).body.connection.ownerPaired, false);
  await sendUpdate(api, cid, secret, say(42, `/pair ${code}`));
  assert.equal((await api.get(`/connections/${cid}`)).body.connection.ownerPaired, true);
  assert.match(sentTo(calls, 42).at(-1), /^Paired\./);
  // The code works once.
  await sendUpdate(api, cid, secret, say(77, `/pair ${code}`));
  assert.equal(env.DB.dump().connections[0].config_json.includes('"77"'), false);
  assert.ok(!logs().includes(telegramToken()) && !logs().includes(secret), 'no log line holds a token');
  assert.ok(!dumpWithoutVault(env).includes(telegramToken()) && !dumpWithoutVault(env).includes(secret));
});

test('T2: five wrong codes invalidate the code, and a code that is too old does not work', async (t) => {
  const { world, api, env } = setup(t);
  const calls = fakeTelegram(world);
  const { cid, secret } = await connectTelegram(api, calls);
  const code = (await api.post(`/connections/${cid}/telegram/pair`, {})).body.code;
  for (let i = 0; i < 5; i += 1) await sendUpdate(api, cid, secret, say(42, `/pair ${String(i).repeat(8)}`));
  await sendUpdate(api, cid, secret, say(42, `/pair ${code}`));
  assert.equal((await api.get(`/connections/${cid}`)).body.connection.ownerPaired, false, 'five tries used the code up');
  const code2 = (await api.post(`/connections/${cid}/telegram/pair`, {})).body.code;
  await env.DB.prepare("UPDATE settings SET value = replace(value, substr(value, instr(value, 'expiresAt') + 12, 24), '2020-01-01T00:00:00.000Z') WHERE key LIKE 'tg.pair.%'").run();
  await sendUpdate(api, cid, secret, say(42, `/pair ${code2}`));
  assert.equal((await api.get(`/connections/${cid}`)).body.connection.ownerPaired, false);
});

test('scenario 9 / T3: the owner commands work, other chats get no answer, and a repeated update is ignored', async (t) => {
  const { world, api, env } = setup(t);
  const logs = captureConsole(t);
  const calls = fakeTelegram(world);
  const { cid, secret } = await connectTelegram(api, calls);
  await pair(api, calls, cid, secret);
  const ask = async (text) => {
    const before = sentTo(calls, 42).length;
    await sendUpdate(api, cid, secret, say(42, text));
    return sentTo(calls, 42).slice(before);
  };
  assert.match((await ask('/help'))[0], /\/status.*\n\/task <text>/s);
  assert.match((await ask('/status'))[0], /Pulse: .*\nTasks in 24 hours: 0 done, 0 active, 0 failed\nApprovals waiting: 0/);
  assert.match((await ask('/task Summarize the open issues'))[0], /^Queued task [0-9a-f]{8}\.$/);
  assert.equal(env.DB.dump().subagents[0].source, 'telegram');
  assert.match((await ask('/tasks'))[0], /queued: Summarize the open issues/);
  assert.match((await ask('/task'))[0], /Write the task after the command/);
  assert.match((await ask('/keys'))[0], /groq:/);
  assert.match((await ask('/chat hi'))[0], /Chat is not ready yet/);
  assert.match((await ask('/brief'))[0], /not set up yet/);

  // Plain text offers a button that makes a task.
  const before = calls.filter((c) => c.method === 'sendMessage').length;
  await sendUpdate(api, cid, secret, say(42, 'remind me to check the logs'));
  const offer = calls.filter((c) => c.method === 'sendMessage').at(-1).payload;
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, before + 1);
  const data = offer.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(data) <= 64, 'callback_data fits the 64 byte limit');
  await sendUpdate(api, cid, secret, { callback_query: { id: 'cq-1', from: { id: 42 }, message: { message_id: 5, chat: { id: 42 } }, data } });
  assert.equal(env.DB.dump().subagents.filter((s) => s.brief === 'remind me to check the logs').length, 1);

  // Another chat gets nothing, and the log holds metadata only.
  const other = sentTo(calls, 99).length;
  await sendUpdate(api, cid, secret, say(99, '/status secret-text-of-a-stranger', 'group'));
  assert.equal(sentTo(calls, 99).length, other);
  assert.ok(logs().includes('ignored_chat'));
  assert.ok(!logs().includes('secret-text-of-a-stranger'), 'the text of another chat is not logged');

  // A repeated update id does nothing.
  const dup = JSON.stringify({ update_id: 5000, ...say(42, '/task once') });
  const hdr = { 'X-Telegram-Bot-Api-Secret-Token': secret };
  await api.call('POST', `/hooks/telegram/${cid}`, dup, hdr);
  const second = await api.call('POST', `/hooks/telegram/${cid}`, dup, hdr);
  assert.equal(second.body.duplicate, true);
  assert.equal(env.DB.dump().subagents.filter((s) => s.brief === 'once').length, 1);
});

test('scenario 9 / T4: an approval message has buttons. A good HMAC decides, a bad HMAC and another chat do nothing', async (t) => {
  const { world, api, env } = setup(t);
  const calls = fakeTelegram(world);
  const sent = fakeDiscord(world);
  const { cid, secret } = await connectTelegram(api, calls);
  await pair(api, calls, cid, secret);
  const discord = await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });
  const cb = await callbackToken(world, env);

  const ask = async (text) => (await api.post('/internal/connector-call', { connectionId: discord.body.connection.id, action: 'send', input: { text } }, cb)).body.approvalId;
  const first = await ask('first');
  const message = calls.filter((c) => c.method === 'sendMessage').at(-1).payload;
  assert.match(message.text, /^Approval needed \(write\)\nDiscord webhook: Send a message \(text=first\)\nAsked by internal\nKey: [0-9a-f]{8}/);
  const [approve, deny] = message.reply_markup.inline_keyboard[0];
  assert.deepEqual([approve.text, deny.text], ['Approve', 'Deny']);
  for (const b of [approve, deny]) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  assert.match(approve.callback_data, new RegExp(`^a:${first}:y:[0-9a-f]{16}$`));

  const press = (data, chat = 42, from = chat) => sendUpdate(api, cid, secret, { callback_query: { id: 'cq', from: { id: from }, message: { message_id: 9, chat: { id: chat } }, data } });
  const bad = `${approve.callback_data.slice(0, -1)}${approve.callback_data.endsWith('0') ? '1' : '0'}`;
  await press(bad);
  assert.equal((await api.get('/approvals?status=pending')).body.approvals.length, 1, 'a bad HMAC changes nothing');
  assert.equal(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).payload.text, 'That button is not valid.');
  await press(approve.callback_data, 99);
  assert.equal((await api.get('/approvals?status=pending')).body.approvals.length, 1, 'another chat changes nothing');
  assert.equal(sent.length, 0);

  await press(approve.callback_data);
  assert.equal(sent.length, 1, 'the good HMAC from the owner ran the call');
  assert.equal(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).payload.text, 'Approved and done.');
  assert.ok(calls.some((c) => c.method === 'editMessageReplyMarkup'), 'the buttons are removed');
  await press(approve.callback_data);
  assert.equal(sent.length, 1, 'a second press does not run it again');

  const second = await ask('second');
  await press(calls.filter((c) => c.method === 'sendMessage').at(-1).payload.reply_markup.inline_keyboard[0][1].callback_data);
  assert.equal((await api.get('/approvals')).body.approvals.find((a) => a.id === second).status, 'denied');

  // The commands /approve and /deny reach the same code.
  const third = await ask('third');
  await sendUpdate(api, cid, secret, say(42, `/approve ${third}`));
  assert.equal(sent.length, 2);
  const fourth = await ask('fourth');
  await sendUpdate(api, cid, secret, say(42, `/deny ${fourth}`));
  assert.equal(sent.length, 2);
  assert.match(sentTo(calls, 42).at(-1), /^Denied\.$/);
});

test('T1: disconnect removes the webhook at Telegram and every vault record', async (t) => {
  const { world, api, env } = setup(t);
  const calls = fakeTelegram(world);
  const { cid } = await connectTelegram(api, calls);
  const gone = await api.post(`/connections/${cid}/disconnect`, {});
  assert.equal(gone.body.remote.telegramWebhook, 'removed');
  assert.ok(calls.some((c) => c.method === 'deleteWebhook'));
  assert.equal(env.DB.dump().vault_records.length, 0);
});

test('T1: a bot token that Telegram refuses is not saved', async (t) => {
  const { world, api, env } = setup(t);
  world.addHost('api.telegram.org', () => json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401));
  const res = await api.post('/connectors/telegram/connect', { fields: { token: telegramToken() } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'test_failed');
  assert.equal(env.DB.dump().connections.length, 0);
});

// --- C7: the notification router -----------------------------------------------------------------------------------

const at = (iso) => new Date(iso);

async function channel(world, api) {
  const sent = fakeDiscord(world);
  const res = await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });
  return { sent, id: res.body.connection.id };
}

test('C7: a rule needs a valid pattern, severity, time zone, and a real channel', async (t) => {
  const { world, api } = setup(t);
  const { id } = await channel(world, api);
  const bad = await api.post('/admin/notify/rules', { eventPattern: 'Not A Pattern', minSeverity: 'loud', tz: 'Mars/Base', connectionIds: ['c_nope'], quietStart: '25:00' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.length >= 5);
  const github = await api.post('/connectors/github/connect', { fields: { token: ['github', '_pat_', 'TEST_VALUE_NOT_A_REAL_SECRET'].join(''), owner: 'o', repo: 'r' }, saveIfUnverified: true });
  const notChannel = await api.post('/admin/notify/rules', { eventPattern: 'task.*', connectionIds: [github.body.connection.id] });
  assert.equal(notChannel.status, 422);
  const ok = await api.post('/admin/notify/rules', { label: 'Failures', eventPattern: 'task.*', minSeverity: 'warn', connectionIds: [id] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.rule.tz, 'America/Chicago', 'the default time zone');
  assert.equal((await api.get('/admin/notify/rules')).body.rules.length, 1);
  assert.equal((await api.del(`/admin/notify/rules/${ok.body.rule.id}`)).status, 200);
});

test('C7: the router matches patterns and severity, keeps quiet hours, dedupes, and guards text from outside', async (t) => {
  const { world, api, env } = setup(t);
  const { sent, id } = await channel(world, api);
  await api.post('/admin/notify/rules', { label: 'Tasks', eventPattern: 'task.*', minSeverity: 'warn', connectionIds: [id], quietStart: '22:00', quietEnd: '07:00', dedupeMinutes: 30 });
  await api.post('/admin/notify/rules', { label: 'Hooks', eventPattern: 'hook.received', connectionIds: [id] });
  const noon = at('2026-10-08T17:00:00Z'); // 12:00 in Chicago
  const night = at('2026-10-09T08:00:00Z'); // 03:00 in Chicago

  await emitEvent(env, { type: 'task.done', severity: 'info', title: 'quiet success' });
  await emitEvent(env, { type: 'task.failed', severity: 'warn', title: 'Task failed', body: 'The runner ended.' });
  await emitEvent(env, { type: 'key.invalid', severity: 'warn', title: 'no rule for this' });
  await emitEvent(env, { type: 'hook.received', severity: 'info', title: 'Deploys: text from outside' });
  const first = await routeEvents(env, noon, 'https://worker.example');
  assert.equal(first.routed, 4);
  assert.deepEqual(sent.map((s) => s.content), ['Task failed\nThe runner ended.'], 'only the matching event went out; the hook event needs allow_personal');

  // The same event inside the dedupe window is not sent again.
  await emitEvent(env, { type: 'task.failed', severity: 'warn', title: 'Task failed', body: 'again', dedupeKey: 'other-key' });
  await routeEvents(env, at('2026-10-08T17:10:00Z'), 'https://worker.example');
  assert.equal(sent.length, 1);

  // Quiet hours hold back a warning but not an error.
  await emitEvent(env, { type: 'task.failed', severity: 'warn', title: 'Night warning' });
  await emitEvent(env, { type: 'task.failed', severity: 'error', title: 'Night error' });
  await routeEvents(env, night, 'https://worker.example');
  assert.deepEqual(sent.map((s) => s.content.split('\n')[0]), ['Task failed', 'Night error']);
  assert.equal(env.DB.dump().events.every((e) => e.routed === 1), true);
  assert.equal(env.DB.dump().notify_deliveries.length, 2);

  // A rule with allow_personal passes text from outside.
  await api.post('/admin/notify/rules', { label: 'Hooks open', eventPattern: 'hook.received', connectionIds: [id], allowPersonal: true });
  await emitEvent(env, { type: 'hook.received', severity: 'info', title: 'Deploys: second post' });
  await routeEvents(env, noon, 'https://worker.example');
  assert.ok(sent.some((s) => s.content.startsWith('Deploys: second post')));
});

test('C7: a failed send is recorded and the event is still marked routed; the preset makes one rule for each important event', async (t) => {
  const { world, api, env } = setup(t);
  const { id } = await channel(world, api);
  const preset = await api.post('/admin/notify/preset', { connectionId: id });
  assert.equal(preset.status, 201);
  assert.equal(preset.body.made.length, 6);
  assert.equal((await api.post('/admin/notify/preset', { connectionId: id })).body.made.length, 0, 'a second call adds nothing');
  world.addHost('discord.com', () => json({ message: 'nope' }, 500));
  await emitEvent(env, { type: 'callback.broken', severity: 'error', title: 'Callback broke' });
  const out = await routeEvents(env, new Date());
  assert.equal(out.failed, 1);
  const delivery = env.DB.dump().notify_deliveries[0];
  assert.equal(delivery.ok, 0);
  assert.match(delivery.error, /Discord webhook answered 500/);
});

test('C7: Send test sends one message through the channel; /internal/event accepts pulse events only', async (t) => {
  const { world, api, env } = setup(t);
  const { sent, id } = await channel(world, api);
  assert.equal((await api.post('/admin/notify/test', { connectionId: id })).status, 200);
  assert.match(sent[0].content, /^TITAN test notification/);
  assert.equal((await api.post('/admin/notify/test', { connectionId: 'c_nope' })).status, 502);
  const cb = await callbackToken(world, env);
  const ok = await api.post('/internal/event', { type: 'pulse.late', severity: 'error', title: 'The pulse is late' }, cb);
  assert.equal(ok.status, 202);
  assert.equal(ok.body.recorded, true);
  assert.equal((await api.post('/internal/event', { type: 'hook.received', title: 'x' }, cb)).status, 422);
  assert.equal((await api.post('/internal/event', { type: 'made.up', title: 'x' }, cb)).status, 422);
  assert.equal((await api.post('/internal/event', { type: 'pulse.late', title: 'x' }, { 'X-Titan-Auth': 'nope' })).status, 401);
});

// --- M1 and M2: the MCP server -------------------------------------------------------------------------------------

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const modernHeaders = (token, method, name) => ({ Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}) });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function token(api, scopes, label = 'test') {
  const res = await api.post('/admin/mcp/tokens', { label, scopes });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('M2: tokens. The value is shown once, only a hash is stored, scopes are checked, and revoke works', async (t) => {
  const { api, env } = setup(t);
  const bad = await api.post('/admin/mcp/tokens', { label: '', scopes: ['nope'] });
  assert.equal(bad.status, 422);
  const made = await token(api, ['status:read', 'tasks:write']);
  assert.match(made.token, /^titan_mcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.shownOnce, true);
  const list = await api.get('/admin/mcp/tokens');
  assert.ok(!list.text.includes(made.token), 'the list never shows a token');
  assert.deepEqual(list.body.tokens[0].scopes, ['status:read', 'tasks:write']);
  assert.ok(!dumpWithoutVault(env).includes(made.token) && !JSON.stringify(env.DB.dump().vault_records).includes(made.token));
  assert.ok(list.body.scopes.includes('chat:write'));

  const ok = await api.post('/mcp', rpc('ping'), bearer(made.token));
  assert.equal(ok.status, 200);
  assert.equal((await api.del(`/admin/mcp/tokens/${made.id}`)).status, 200);
  assert.equal((await api.post('/mcp', rpc('ping'), bearer(made.token))).status, 401, 'a revoked token stops working');
  assert.equal((await api.del(`/admin/mcp/tokens/${made.id}`)).status, 404);

  const short = await api.post('/admin/mcp/tokens', { label: 'short', scopes: ['status:read'], expiresInDays: 1 });
  await env.DB.prepare('UPDATE mcp_tokens SET expires_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', short.body.id).run();
  assert.equal((await api.post('/mcp', rpc('ping'), bearer(short.body.token))).status, 401, 'an expired token stops working');
});

test('scenario 4 / M1: no token is 401, GET is 405, a bad body is refused, and ten wrong tokens lock the client', async (t) => {
  const { api } = setup(t);
  const none = await api.post('/mcp', rpc('ping'), {});
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Bearer/);
  const get = await api.get('/mcp', {});
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  const made = await token(api, ['status:read']);
  assert.equal((await api.call('POST', '/mcp', '{not json', bearer(made.token))).body.error.code, -32700);
  assert.equal((await api.call('POST', '/mcp', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', bearer(made.token))).body.error.code, -32600);
  assert.equal((await api.call('POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(70 * 1024) }), bearer(made.token))).status, 413);
  assert.equal((await api.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, bearer(made.token))).status, 202);
  let status = 0;
  for (let i = 0; i < 11; i += 1) status = (await api.post('/mcp', rpc('ping'), bearer(`wrong-${i}`))).status;
  assert.equal(status, 429);
});

test('M1: the origin is checked when it is present', async (t) => {
  const { api } = setup(t);
  const made = await token(api, ['status:read']);
  assert.equal((await api.post('/mcp', rpc('ping'), { ...bearer(made.token), Origin: 'https://evil.example' })).status, 403);
  const pages = await api.post('/mcp', rpc('ping'), { ...bearer(made.token), Origin: 'https://shreyas-tech7.github.io' });
  assert.equal(pages.status, 200);
  assert.equal(pages.headers.get('access-control-allow-origin'), 'https://shreyas-tech7.github.io');
});

test('scenario 4 / M1: the legacy form. initialize, initialized, tools/list, and tools/call', async (t) => {
  const { api } = setup(t);
  const made = await token(api, ['status:read']);
  const init = await api.post('/mcp', rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }), bearer(made.token));
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.headers.get('mcp-session-id'), null, 'the server keeps no session');
  assert.equal(init.body.result.serverInfo.name, 'titan-runner-brain');
  const unknown = await api.post('/mcp', rpc('initialize', { protocolVersion: '1999-01-01' }), bearer(made.token));
  assert.equal(unknown.body.result.protocolVersion, '2025-11-25', 'the server offers its newest legacy version');
  const list = await api.post('/mcp', rpc('tools/list'), { ...bearer(made.token), 'MCP-Protocol-Version': '2025-06-18' });
  assert.deepEqual(list.body.result.tools.map((x) => x.name).sort(), ['titan_get_task', 'titan_keys_status', 'titan_lessons', 'titan_list_tasks', 'titan_status'], 'only the tools within the scopes');
  assert.equal(list.body.result.resultType, undefined);
  const call = await api.post('/mcp', rpc('tools/call', { name: 'titan_status', arguments: {} }), bearer(made.token));
  assert.equal(call.body.result.isError, undefined);
  assert.equal(call.body.result.structuredContent.approvalsWaiting, 0);
  assert.equal(JSON.parse(call.body.result.content[0].text).approvalsWaiting, 0);
  const missing = await api.post('/mcp', rpc('nope'), bearer(made.token));
  assert.equal(missing.body.error.code, -32601);
  assert.equal((await api.post('/mcp', rpc('ping'), { ...bearer(made.token), 'MCP-Protocol-Version': '1999-01-01' })).body.error.code, -32022);
});

test('scenario 4 / M1: the modern form. per-request metadata, matching headers, discover, and the error codes', async (t) => {
  const { api } = setup(t);
  const made = await token(api, ['status:read', 'tasks:write']);
  const discover = await api.post('/mcp', rpc('server/discover', { _meta: META }), modernHeaders(made.token, 'server/discover'));
  assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28']);
  assert.equal(discover.body.result.resultType, 'complete');
  assert.equal(discover.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'titan-runner-brain');

  const list = await api.post('/mcp', rpc('tools/list', { _meta: META }), modernHeaders(made.token, 'tools/list'));
  assert.equal(list.body.result.resultType, 'complete');
  assert.ok(list.body.result.tools.some((x) => x.name === 'titan_queue_task'));
  for (const tool of list.body.result.tools) assert.equal(tool.inputSchema.type, 'object');

  const queued = await api.post('/mcp', rpc('tools/call', { name: 'titan_queue_task', arguments: { brief: 'Check the logs' }, _meta: META }), modernHeaders(made.token, 'tools/call', 'titan_queue_task'));
  assert.equal(queued.status, 200);
  assert.ok(queued.body.result.structuredContent.queued);

  // A header that does not match the body is -32020 with status 400.
  for (const [headers, why] of [
    [{ ...modernHeaders(made.token, 'tools/list'), 'MCP-Protocol-Version': '2025-11-25' }, 'version header'],
    [modernHeaders(made.token, 'tools/call'), 'method header'],
    [{ Authorization: `Bearer ${made.token}`, 'MCP-Protocol-Version': '2026-07-28' }, 'missing method header'],
  ]) {
    const r = await api.post('/mcp', rpc('tools/list', { _meta: META }), headers);
    assert.equal(r.status, 400, why);
    assert.equal(r.body.error.code, -32020, why);
  }
  const wrongName = await api.post('/mcp', rpc('tools/call', { name: 'titan_status', arguments: {}, _meta: META }), modernHeaders(made.token, 'tools/call', 'titan_other'));
  assert.equal(wrongName.body.error.code, -32020);

  const old = await api.post('/mcp', rpc('tools/list', { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } }), { ...modernHeaders(made.token, 'tools/list'), 'MCP-Protocol-Version': '1900-01-01' });
  assert.equal(old.status, 400);
  assert.equal(old.body.error.code, -32022);
  assert.ok(old.body.error.data.supported.includes('2026-07-28'));
  assert.equal(old.body.error.data.requested, '1900-01-01');

  const unknown = await api.post('/mcp', rpc('resources/list', { _meta: META }), modernHeaders(made.token, 'resources/list'));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, -32601);
});

test('M1: scopes decide what a token sees and does, and arguments are checked', async (t) => {
  const { api, env } = setup(t);
  const reader = await token(api, ['status:read'], 'reader');
  const call = (tok, name, args = {}) => api.post('/mcp', rpc('tools/call', { name, arguments: args }), bearer(tok));
  const denied = await call(reader.token, 'titan_queue_task', { brief: 'x' });
  assert.equal(denied.body.result.isError, true);
  assert.equal(JSON.parse(denied.body.result.content[0].text).error, 'scope_missing');
  assert.equal(env.DB.dump().subagents.length, 0);
  const bad = await call(reader.token, 'titan_get_task', { id: 'x' });
  assert.equal(JSON.parse(bad.body.result.content[0].text).error, 'invalid_arguments');
  const extra = await call(reader.token, 'titan_status', { more: 1 });
  assert.equal(JSON.parse(extra.body.result.content[0].text).error, 'invalid_arguments');
  assert.equal((await call(reader.token, 'titan_nope')).body.error.code, -32602);

  const writer = await token(api, ['tasks:write'], 'writer');
  const queued = JSON.parse((await call(writer.token, 'titan_queue_task', { brief: 'Do the thing', task_type: 'research' })).body.result.content[0].text).queued;
  const row = env.DB.dump().subagents[0];
  assert.equal(row.id, queued);
  assert.equal(row.source, `mcp:${writer.id}`);
  assert.equal(JSON.parse((await call(writer.token, 'titan_queue_task', { brief: 'x', task_type: 'osint' })).body.result.content[0].text).error.includes('reserved'), true);

  const keys = await token(api, ['status:read'], 'keys');
  const states = JSON.parse((await call(keys.token, 'titan_keys_status')).body.result.content[0].text).providers;
  assert.ok(states.every((p) => 'state' in p && !('secretName' in p)));
});

test('M1: titan_connector_call follows the scope rules. read runs, write waits, personal needs its scope', async (t) => {
  const { world, api, env } = setup(t);
  world.addHost('feeds.example.org', () => new Response('<rss><channel><title>T</title><item><title>A</title></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } }));
  const sent = fakeDiscord(world);
  world.addHost('api.notion.com', () => json({ results: [] }));
  const feed = await api.post('/connectors/rss/connect', { fields: { feed_url: 'https://feeds.example.org/news.xml' } });
  const discord = await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });
  const notion = await api.post('/connectors/notion/connect', { fields: { token: ['ntn', '_', 'TESTVALUENOTAREALSECRET'].join('') }, saveIfUnverified: true });
  const call = async (tok, connection, action, input = {}) => JSON.parse((await api.post('/mcp', rpc('tools/call', { name: 'titan_connector_call', arguments: { connection, action, input } }), bearer(tok))).body.result.content[0].text);

  const reader = await token(api, ['connectors:read'], 'reader');
  assert.equal((await call(reader.token, 'rss', 'read_feed')).state, 'done');
  assert.equal((await call(reader.token, discord.body.connection.id, 'send', { text: 'hi' })).error, 'scope_missing', 'a write needs connectors:write');
  assert.equal((await call(reader.token, notion.body.connection.id, 'search', { query: 'a' })).error, 'scope_missing', 'personal data needs personal:read');

  const writer = await token(api, ['connectors:write'], 'writer');
  const waits = await call(writer.token, discord.body.connection.id, 'send', { text: 'hi' });
  assert.equal(waits.pending_approval, true);
  assert.equal(sent.length, 0);
  // A person sets the action to auto. Then the token runs it.
  await api.post(`/connections/${discord.body.connection.id}/policy`, { actionId: 'send', mode: 'auto' });
  assert.equal((await call(writer.token, discord.body.connection.id, 'send', { text: 'now' })).state, 'done');
  assert.equal(sent.length, 1);

  const all = await token(api, ['connectors:read', 'personal:read'], 'personal');
  assert.equal((await call(all.token, notion.body.connection.id, 'search', { query: 'a' })).state, 'done');
  const listing = JSON.parse((await api.post('/mcp', rpc('tools/call', { name: 'titan_connectors', arguments: {} }), bearer(reader.token))).body.result.content[0].text);
  assert.ok(listing.connections.some((c) => c.connector === 'discord_webhook' && c.actions[0].mode === 'auto'));
  void env;
});

test('M1: titan_notify sends to every channel, titan_lessons reads the memory, and a secret never appears in a tool answer', async (t) => {
  const { world, api, env } = setup(t);
  const { sent } = await channel(world, api);
  await env.DB.prepare("INSERT INTO system_memory (category, lesson, prompt_injection, created_at, active) VALUES ('tip', 'Keep tasks small.', 0, ?, 1)").bind(new Date().toISOString()).run();
  const tok = await token(api, ['notify:write', 'status:read']);
  const call = async (name, args) => JSON.parse((await api.post('/mcp', rpc('tools/call', { name, arguments: args }), bearer(tok.token))).body.result.content[0].text);
  assert.equal((await call('titan_notify', { title: 'Build done', body: 'All green', severity: 'info' })).queued, true);
  await routeEvents(env, new Date(), 'https://worker.example');
  assert.deepEqual(sent.map((s) => s.content), ['Build done\nAll green']);
  assert.deepEqual((await call('titan_lessons', {})).lessons.map((l) => l.lesson), ['Keep tasks small.']);
  const everything = JSON.stringify([await call('titan_status', {}), await call('titan_keys_status', {}), await call('titan_list_tasks', {})]);
  assert.ok(!everything.includes(tok.token));
});
