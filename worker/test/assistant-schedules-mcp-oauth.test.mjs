// Wave 12 Release 3 tests: A1 (instant chat), A2 (schedules + DST), A3 (daily brief), A4/T4 (pulse approvals),
// A5/X16 (activity timeline), M5 (OAuth 2.1 with PKCE for MCP), and X8/X19/X32.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runTick } from '../src/tick.js';
import { nextCronRuns, parseCron } from '../src/schedules.js';
import { FAKE_GEMINI_KEY, FAKE_GROQ_KEY, FakeWorld } from './helpers/world.mjs';
import { KEK, caller, discordUrl, dumpWithoutVault, fakeDiscord, fakeTelegram, telegramToken } from './helpers/hub.mjs';

function setup(t, extra = {}) {
  const world = new FakeWorld().install(t);
  const env = world.env({ CONNECTOR_KEK: KEK, TITAN_COMMIT: 'r3commit1', ...extra });
  return { world, env, api: caller(env) };
}

test('scenario 10 / A1: instant chat streams SSE, fails over on 429 to Gemini SSE, accepts MCP chat:write, and deletes threads', async (t) => {
  const { world, api, env } = setup(t);

  // Before any key is marked for chat, threads list shows ready: false and POST /chat returns 409.
  const emptyList = await api.get('/chat/threads');
  assert.equal(emptyList.status, 200);
  assert.equal(emptyList.body.ready, false);
  const noKey = await api.post('/chat', { message: 'Hello' });
  assert.equal(noKey.status, 409);
  assert.equal(noKey.body.error, 'no_chat_key');

  // Save Groq and Gemini keys with alsoForChat: true.
  world.providers.host('api.groq.com').valid.add(FAKE_GROQ_KEY);
  world.providers.host('generativelanguage.googleapis.com').valid.add(FAKE_GEMINI_KEY);
  assert.equal((await api.post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY, alsoForChat: true })).status, 200);
  assert.equal((await api.post('/admin/keys', { provider: 'gemini', value: FAKE_GEMINI_KEY, alsoForChat: true })).status, 200);

  const readyList = await api.get('/chat/threads');
  assert.equal(readyList.body.ready, true);
  assert.deepEqual(readyList.body.providers.map((p) => p.id), ['groq', 'gemini']);

  // Stream a chat response from Groq.
  const streamRes = await api.post('/chat', { message: 'Explain the pulse' });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(streamRes.text, /event: meta/);
  assert.match(streamRes.text, /event: delta/);
  assert.match(streamRes.text, /Hello there/);
  assert.match(streamRes.text, /event: done/);

  const threadsAfter = (await api.get('/chat/threads')).body.threads;
  assert.equal(threadsAfter.length, 1);
  const tid = threadsAfter[0].id;
  assert.equal(threadsAfter[0].provider, 'groq');

  const detail = await api.get(`/chat/threads/${tid}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.messages.length, 2);
  assert.equal(detail.body.messages[1].content, 'Hello there');

  // Failover on 429: Groq returns 429 on chat, so the Worker fails over to Gemini SSE!
  world.providers.host('api.groq.com').chatStatus = 429;
  const failoverRes = await api.post('/chat', { message: 'Try failover', threadId: tid });
  assert.equal(failoverRes.status, 200);
  assert.match(failoverRes.text, /"provider":"gemini"/);
  assert.match(failoverRes.text, /Gemini stream/);
  world.providers.host('api.groq.com').chatStatus = null;

  // MCP token with chat:write can call POST /chat; a token without chat:write gets 403.
  const noChatMcp = (await api.post('/admin/mcp/tokens', { label: 'read-only', scopes: ['status:read'] })).body;
  const chatMcp = (await api.post('/admin/mcp/tokens', { label: 'chatter', scopes: ['chat:write'] })).body;
  const deniedMcp = await api.post('/chat', { message: 'Hi', stream: false }, { Authorization: `Bearer ${noChatMcp.token}` });
  assert.equal(deniedMcp.status, 403);
  const allowedMcp = await api.post('/chat', { message: 'Hi via MCP', stream: false }, { Authorization: `Bearer ${chatMcp.token}` });
  assert.equal(allowedMcp.status, 200);
  assert.equal(allowedMcp.body.text, 'OK');

  // Delete one thread and clear all threads.
  assert.equal((await api.del(`/chat/threads/${tid}`)).status, 200);
  assert.equal((await api.get(`/chat/threads/${tid}`)).status, 404);
  assert.equal((await api.del('/chat/threads')).status, 200);
  assert.equal((await api.get('/chat/threads')).body.threads.length, 0);

  // Neither key ever appears outside the vault.
  assert.ok(!dumpWithoutVault(env).includes(FAKE_GROQ_KEY));
  assert.ok(!dumpWithoutVault(env).includes(FAKE_GEMINI_KEY));
});

test('A2: 5-field cron parser handles time zones and DST transitions, and tickSchedules queues at most 3 due schedules', async (t) => {
  const { api, env } = setup(t);

  assert.equal(parseCron('invalid cron'), null);
  assert.ok(parseCron('30 7 * * 1-5'));

  // DST spring forward in America/Chicago: 2026-03-08 (07:30 CST on Mar 7 is 13:30Z; 07:30 CDT on Mar 8 is 12:30Z).
  const dstRuns = nextCronRuns('30 7 * * *', 'America/Chicago', new Date('2026-03-07T00:00:00Z'), 3);
  assert.deepEqual(dstRuns, [
    '2026-03-07T13:30:00.000Z',
    '2026-03-08T12:30:00.000Z',
    '2026-03-09T12:30:00.000Z',
  ]);

  // Built-in daily brief schedule exists and starts disabled until a channel is connected.
  const initial = await api.get('/schedules');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.schedules[0].id, 'sched_daily_brief');
  assert.equal(initial.body.schedules[0].enabled, false);

  // Create 4 custom schedules that are all due now.
  const ids = [];
  for (let i = 1; i <= 4; i += 1) {
    const created = await api.post('/schedules', {
      label: `Job ${i}`,
      cron: '*/15 * * * *',
      tz: 'America/Chicago',
      brief: `Scheduled work ${i}`,
      taskType: 'research',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.schedule.nextRuns.length, 3);
    ids.push(created.body.schedule.id);
  }
  await env.DB.prepare("UPDATE schedules SET next_run_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'task'").run();

  const tickReport = await runTick(env, new Date('2026-10-08T15:00:00Z'));
  assert.equal(tickReport.schedules.fired, 3, 'at most 3 due schedules run in one tick');
  assert.equal(env.DB.dump().subagents.length, 3);

  // Toggle, run now, and delete.
  const toggled = await api.post(`/schedules/${ids[0]}/toggle`, {});
  assert.equal(toggled.body.schedule.enabled, false);
  const ranNow = await api.post(`/schedules/${ids[0]}/run`, {});
  assert.equal(ranNow.status, 200);
  assert.ok(ranNow.body.taskId);
  assert.equal((await api.del('/schedules/sched_daily_brief')).status, 400, 'built-in schedule cannot be deleted');
  assert.equal((await api.del(`/schedules/${ids[0]}`)).status, 200);
});

test('A3, A4, T4, A5, X8, X19, X32: daily brief, pulse approval comments, activity timeline, task cancel/dedupe, and vault rotation', async (t) => {
  const { world, api, env } = setup(t);
  fakeDiscord(world);
  const tgCalls = fakeTelegram(world);
  await api.post('/connectors/discord_webhook/connect', { fields: { url: discordUrl() } });

  // Once a notification channel exists, the tick auto-enables sched_daily_brief.
  await runTick(env, new Date('2026-10-08T12:00:00Z'));
  const scheds = (await api.get('/schedules')).body.schedules;
  assert.equal(scheds.find((s) => s.id === 'sched_daily_brief').enabled, true);

  // Generate the daily brief and read it back.
  const gen = await api.post('/brief/generate', { send: true });
  assert.equal(gen.status, 200);
  assert.match(gen.body.brief.text, /TITAN daily brief/);
  assert.equal((await api.get('/brief')).body.brief.date, gen.body.brief.date);

  // Regression: dashboard/lib/workerApi.ts's DailyBriefRecord (and BriefCard.tsx, which reads
  // `brief.tasks.done` and `brief.pendingApprovals` directly) requires these as structured fields, not
  // just baked into `.text`. A brief missing `tasks` crashed the whole dashboard with "Cannot read
  // properties of undefined (reading 'done')" in production — see the Pages deploy this fixed.
  const brief = gen.body.brief;
  assert.equal(typeof brief.tasks, 'object');
  assert.equal(typeof brief.tasks.done, 'number');
  assert.equal(typeof brief.tasks.failed, 'number');
  assert.equal(typeof brief.tasks.running, 'number');
  assert.equal(typeof brief.pendingApprovals, 'number');
  assert.equal(typeof brief.healthOk, 'boolean');
  assert.ok(Array.isArray(brief.keysNeedingCare));
  assert.ok(Array.isArray(brief.calendar));

  // Connect Telegram and verify /brief and pulse approval (#issue key) work.
  const tg = await api.post('/connectors/telegram/connect', { fields: { token: telegramToken() } });
  const cid = tg.body.connection.id;
  const secret = tgCalls.find((c) => c.method === 'setWebhook').payload.secret_token;
  const code = (await api.post(`/connections/${cid}/telegram/pair`, {})).body.code;
  await api.call('POST', `/hooks/telegram/${cid}`, JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: `/pair ${code}` } }), { 'X-Telegram-Bot-Api-Secret-Token': secret });
  await api.call('POST', `/hooks/telegram/${cid}`, JSON.stringify({ update_id: 2, message: { message_id: 2, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/brief' } }), { 'X-Telegram-Bot-Api-Secret-Token': secret });
  assert.match(tgCalls.filter((c) => c.method === 'sendMessage').at(-1).payload.text, /TITAN daily brief/);

  // Pulse approval via POST /approvals/pulse and via Telegram.
  const pulseOk = await api.post('/approvals/pulse', { issueNumber: 17, key: 'tool:workspace_write:1a2b3c4d', decision: 'approve' });
  assert.equal(pulseOk.status, 200);
  assert.deepEqual(world.github.comments.at(-1), { issue: 17, body: '/titan approve tool:workspace_write:1a2b3c4d' });

  await api.call('POST', `/hooks/telegram/${cid}`, JSON.stringify({ update_id: 3, message: { message_id: 3, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/deny #18 deliver:run1' } }), { 'X-Telegram-Bot-Api-Secret-Token': secret });
  assert.deepEqual(world.github.comments.at(-1), { issue: 18, body: '/titan deny deliver:run1' });

  // X19 idempotency key and X8 task cancel.
  const t1 = await api.post('/tasks', { brief: 'Check idempotency', idempotencyKey: 'idem-key-1' });
  const t2 = await api.post('/tasks', { brief: 'Check idempotency', idempotencyKey: 'idem-key-1' });
  assert.equal(t1.body.id, t2.body.id);
  assert.equal(t2.body.deduplicated, true);
  const cancelled = await api.post(`/tasks/${t1.body.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancelled, true);

  // A5 & X16 activity timeline includes deploy detection, tasks, and schedules.
  const act = await api.get('/activity?limit=30');
  assert.equal(act.status, 200);
  assert.ok(act.body.items.some((i) => i.kind === 'deploy' && i.title.includes('r3commit1')));
  assert.ok(act.body.items.some((i) => i.kind === 'task'));

  // X32 vault key rotation re-encrypts all vault records cleanly.
  const rotated = await api.post('/admin/vault/rotate', {});
  assert.equal(rotated.status, 200);
  assert.ok(rotated.body.rotated >= 2);
});

test('M5: MCP OAuth 2.1 discovery, dynamic client registration, consent approval, PKCE S256 token exchange, refresh, and revoke', async (t) => {
  const { api, env } = setup(t);

  // 1. Metadata routes are public.
  const prm = await api.get('/.well-known/oauth-protected-resource', {});
  assert.equal(prm.status, 200);
  assert.equal(prm.body.resource, 'https://worker.example/mcp');

  const asm = await api.get('/.well-known/oauth-authorization-server', {});
  assert.equal(asm.status, 200);
  assert.deepEqual(asm.body.code_challenge_methods_supported, ['S256']);

  // 2. Dynamic client registration permits Claude callback and localhost only.
  const badReg = await api.post('/oauth/mcp/register', { client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] }, {});
  assert.equal(badReg.status, 400);

  const reg = await api.post(
    '/oauth/mcp/register',
    {
      client_name: 'Claude Desktop',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:6274/oauth/callback'],
    },
    {},
  );
  assert.equal(reg.status, 201);
  const clientId = reg.body.client_id;

  // 3. PKCE S256 challenge.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // GET /oauth/mcp/authorize redirects to the dashboard consent view.
  const authGet = await api.get(
    `/oauth/mcp/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=status:read%20tasks:write`,
    {},
  );
  assert.equal(authGet.status, 302);
  assert.match(authGet.headers.get('location') ?? '', /mcp_authorize=1/);

  // 4. Admin approves on the consent page -> receives one-time authorization code.
  const approved = await api.post('/oauth/mcp/authorize', {
    client_id: clientId,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scopes: ['status:read', 'tasks:write'],
  });
  assert.equal(approved.status, 200);
  assert.ok(approved.body.code.startsWith('mcpc_'));

  // 5. Wrong PKCE verifier is rejected.
  const badToken = await api.post(
    '/oauth/mcp/token',
    {
      grant_type: 'authorization_code',
      code: approved.body.code,
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: 'wrong_verifier_value_that_will_not_match',
    },
    {},
  );
  assert.equal(badToken.status, 400);
  assert.equal(badToken.body.error, 'invalid_grant');

  // 6. Correct PKCE verifier trades the code for access_token and refresh_token.
  const tok = await api.post(
    '/oauth/mcp/token',
    {
      grant_type: 'authorization_code',
      code: approved.body.code,
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: verifier,
    },
    {},
  );
  assert.equal(tok.status, 200);
  assert.match(tok.body.access_token, /^titan_mcp_/);
  assert.match(tok.body.refresh_token, /^titan_mcpr_/);

  // Code is single-use.
  const replay = await api.post(
    '/oauth/mcp/token',
    {
      grant_type: 'authorization_code',
      code: approved.body.code,
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: verifier,
    },
    {},
  );
  assert.equal(replay.status, 400);

  // 7. Access token opens POST /mcp, and only hashes are stored in D1.
  const ping = await api.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${tok.body.access_token}` });
  assert.equal(ping.status, 200);
  assert.ok(!dumpWithoutVault(env).includes(tok.body.access_token));
  assert.ok(!dumpWithoutVault(env).includes(tok.body.refresh_token));

  // 8. Refresh token rotates both tokens.
  const refreshed = await api.post('/oauth/mcp/token', { grant_type: 'refresh_token', refresh_token: tok.body.refresh_token }, {});
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.access_token, tok.body.access_token);
  assert.equal((await api.post('/mcp', { jsonrpc: '2.0', id: 2, method: 'ping' }, { Authorization: `Bearer ${tok.body.access_token}` })).status, 401);
  assert.equal((await api.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'ping' }, { Authorization: `Bearer ${refreshed.body.access_token}` })).status, 200);

  // 9. OAuth client appears in MCP token list and can be revoked.
  const list = (await api.get('/admin/mcp/tokens')).body.tokens;
  const oauthEntry = list.find((x) => x.kind === 'oauth' && x.clientId === clientId);
  assert.ok(oauthEntry);
  assert.equal((await api.del(`/admin/mcp/tokens/${oauthEntry.id}`)).status, 200);
  assert.equal((await api.post('/mcp', { jsonrpc: '2.0', id: 4, method: 'ping' }, { Authorization: `Bearer ${refreshed.body.access_token}` })).status, 401);
});
