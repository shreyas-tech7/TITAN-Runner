/**
 * @file Telegram, two-way (Wave 12, Track T).
 *
 * T1  connect: `getMe`, then `setWebhook` with `https://<worker>/hooks/telegram/<connectionId>` and a `secret_token`.
 *     The Worker checks the header `X-Telegram-Bot-Api-Secret-Token` on each update.
 * T2  pair: the dashboard shows a code that works for 10 minutes. The owner sends `/pair <code>` to the bot. The Worker saves
 *     that chat id. The bot never answers another chat. For another chat the Worker logs metadata only.
 * T3  commands: /status /task /tasks /approve /deny /brief /keys /chat /help. Plain text offers a button that makes a task.
 * T4  approvals with buttons: `callback_data` is `a:<id>:<y|n>:<mac>`. The mac is 16 hex characters of HMAC-SHA256 over
 *     `<id>:<y|n>` with the webhook secret. That is 29 bytes, and Telegram allows 64. The Worker also checks the owner chat id.
 */
import { recordAuthFailure } from '../lib/auth.js';
import { getSetting, getSettings, setSetting } from '../lib/db.js';
import { equalConstantTime, hmacHex } from '../lib/hmac.js';
import { SafeFetchError, safeFetch } from '../lib/safeFetch.js';
import { json, jsonError, nowIso, randomHex, sha256Hex } from '../lib/util.js';
import { handleListKeys } from '../keys.js';
import { queueTask } from '../tasks.js';
import { decideApproval } from './broker.js';
import { getConnection, listConnections, loadSecrets, saveSecrets, updateConnection } from './store.js';

const TG_HOST = 'api.telegram.org';
export const PAIR_MINUTES = 10;
const PAIR_TRIES = 5;
const MAX_UPDATE_BYTES = 64 * 1024;
const MAC_LENGTH = 16;

/** One call to the Bot API. The token sits in the path, so no message may carry the URL. */
export async function tgCall(env, token, method, payload = {}) {
  let res;
  try {
    res = await safeFetch(env, `https://${TG_HOST}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, { allow: [TG_HOST], timeoutMs: 8000, maxBytes: 200_000 });
  } catch (err) {
    if (err instanceof SafeFetchError) throw new Error(`Telegram ${method} failed: ${err.message}`);
    throw err;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(`Telegram refused ${method}: ${String(body?.description ?? res.status).slice(0, 120)}`);
  return body.result;
}

// ---------------------------------------------------------------------
// Connect, disconnect, pair
// ---------------------------------------------------------------------

export async function telegramAfterConnect(env, connection, secrets, { origin }) {
  const me = await tgCall(env, secrets.token, 'getMe');
  const webhookSecret = randomHex(32);
  await tgCall(env, secrets.token, 'setWebhook', {
    url: `${origin}/hooks/telegram/${connection.id}`,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await saveSecrets(env, connection, { webhook_secret: webhookSecret });
  await updateConnection(env, connection.id, {
    secretNames: [...new Set([...connection.secretNames, 'webhook_secret'])],
    meta: { ...connection.meta, botUsername: String(me.username ?? '').slice(0, 64), botName: String(me.first_name ?? '').slice(0, 64) },
  });
  return { webhookSet: true, botUsername: me.username ?? null, next: 'Choose "Pair my chat", then send /pair and the code to your bot.' };
}

export async function telegramBeforeDisconnect(env, connection) {
  const secrets = await loadSecrets(env, connection);
  if (!secrets.token) return { telegramWebhook: 'no token' };
  await tgCall(env, secrets.token, 'deleteWebhook', { drop_pending_updates: true });
  return { telegramWebhook: 'removed' };
}

/** POST /connections/:cid/telegram/pair. The code is shown one time. */
export async function createPairCode(env, connectionId) {
  const connection = await getConnection(env, connectionId);
  if (!connection || connection.connectorId !== 'telegram') return null;
  const code = randomHex(4);
  const expiresAt = new Date(Date.now() + PAIR_MINUTES * 60_000).toISOString();
  await setSetting(env, `tg.pair.${connectionId}`, JSON.stringify({ hash: await sha256Hex(code), expiresAt, tries: 0 }));
  return { code, expiresAt, minutes: PAIR_MINUTES, botUsername: connection.meta?.botUsername ?? null };
}

async function tryPair(env, connection, code, chatId) {
  const raw = await getSetting(env, `tg.pair.${connection.id}`);
  if (!raw) return false;
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!state.hash || state.expiresAt < nowIso() || state.tries >= PAIR_TRIES) {
    await setSetting(env, `tg.pair.${connection.id}`, '');
    return false;
  }
  if (!equalConstantTime(await sha256Hex(code), state.hash)) {
    await setSetting(env, `tg.pair.${connection.id}`, JSON.stringify({ ...state, tries: state.tries + 1 }));
    return false;
  }
  await setSetting(env, `tg.pair.${connection.id}`, '');
  await updateConnection(env, connection.id, { config: { ...connection.config, chat_id: String(chatId) }, lastError: null });
  return true;
}

export async function unpair(env, connectionId) {
  const connection = await getConnection(env, connectionId);
  if (!connection || connection.connectorId !== 'telegram') return false;
  const { chat_id: _drop, ...rest } = connection.config;
  await updateConnection(env, connectionId, { config: rest });
  return true;
}

// ---------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------

const macOf = async (secret, id, d) => (await hmacHex(secret, `${id}:${d}`)).slice(0, MAC_LENGTH);

async function approvalKeyboard(secret, id) {
  return { inline_keyboard: [[{ text: 'Approve', callback_data: `a:${id}:y:${await macOf(secret, id, 'y')}` }, { text: 'Deny', callback_data: `a:${id}:n:${await macOf(secret, id, 'n')}` }]] };
}

/** Send the approval message with buttons to the owner chat of each paired Telegram connection. */
export async function notifyApprovalViaTelegram(env, { id, summary, risk, requestedBy }) {
  const connections = (await listConnections(env, 'telegram')).filter((c) => c.config.chat_id && c.status !== 'needs_reconnect');
  for (const connection of connections) {
    const secrets = await loadSecrets(env, connection);
    if (!secrets.token || !secrets.webhook_secret) continue;
    await tgCall(env, secrets.token, 'sendMessage', {
      chat_id: connection.config.chat_id,
      text: `Approval needed (${risk})\n${summary}\nAsked by ${requestedBy}\nKey: ${id}`,
      reply_markup: await approvalKeyboard(secrets.webhook_secret, id),
      disable_web_page_preview: true,
    });
  }
}

// ---------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------

const HELP = [
  '/status  pulse, tasks, and approvals',
  '/task <text>  queue a task',
  '/tasks  the last five tasks',
  '/approve <key>  approve a call that waits',
  '/deny <key>  deny a call that waits',
  '/brief  the daily brief',
  '/keys  the state of each provider key',
  '/chat <text>  ask TITAN',
  '/help  this list',
].join('\n');

async function statusText(env) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { results } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM subagents WHERE queued_at > ? GROUP BY status').bind(since).all();
  const counts = Object.fromEntries((results ?? []).map((r) => [r.status, r.n]));
  const s = await getSettings(env, ['pulse.lastHeartbeatAt']);
  const hb = s['pulse.lastHeartbeatAt'];
  const age = hb ? Math.round((Date.now() - Date.parse(hb)) / 60_000) : null;
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first();
  return [
    `Pulse: ${age === null ? 'no heartbeat yet' : `${age} min ago`}`,
    `Tasks in 24 hours: ${counts.done ?? 0} done, ${(counts.queued ?? 0) + (counts.dispatched ?? 0) + (counts.running ?? 0)} active, ${counts.failed ?? 0} failed`,
    `Approvals waiting: ${waiting?.n ?? 0}`,
  ].join('\n');
}

async function tasksText(env) {
  const { results } = await env.DB.prepare('SELECT id, status, brief FROM subagents ORDER BY queued_at DESC LIMIT 5').all();
  if (!results?.length) return 'No tasks yet.';
  return results.map((r) => `${String(r.id).slice(0, 8)} ${r.status}: ${String(r.brief).replace(/\s+/g, ' ').slice(0, 50)}`).join('\n');
}

async function keysText(env) {
  const res = await handleListKeys({ env, requestId: 'telegram' });
  const body = await res.json().catch(() => null);
  if (!body?.providers) return 'The key states are not available now.';
  return body.providers.map((p) => `${p.id}: ${p.state}`).join('\n');
}

/** Run one command from the owner. @returns {Promise<{ text: string, markup?: any }>} */
export async function runCommand(env, connection, secrets, text, origin) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.replace(/@\w+$/, '').toLowerCase();
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/start':
    case '/help':
      return { text: HELP };
    case '/status':
      return { text: await statusText(env) };
    case '/tasks':
      return { text: await tasksText(env) };
    case '/task': {
      if (!arg) return { text: 'Write the task after the command. Example: /task Summarize the open issues.' };
      const id = await queueTask(env, { brief: arg, taskType: 'auto', source: 'telegram' });
      return { text: `Queued task ${id.slice(0, 8)}.` };
    }
    case '/approve':
    case '/deny': {
      if (!arg) return { text: `Write the key after the command. Example: ${cmd} 1a2b3c4d` };
      try {
        const r = await decideApproval(env, arg, cmd === '/approve' ? 'approve' : 'deny', 'telegram:owner', origin);
        return { text: cmd === '/approve' ? (r.status === 'executed' ? 'Approved and done.' : `Approved. The call ended as ${r.status}.`) : 'Denied.' };
      } catch (err) {
        return { text: err instanceof Error ? err.message : 'That did not work.' };
      }
    }
    case '/brief':
      return { text: 'The daily brief is not set up yet. Use /status for a short summary.' };
    case '/keys':
      return { text: await keysText(env) };
    case '/chat':
      return { text: 'Chat is not ready yet. Use /task <text> to start a task.' };
    default:
      return { text: HELP };
  }
}

async function handleMessage(env, connection, secrets, message, origin) {
  const chatId = String(message.chat?.id ?? '');
  const text = String(message.text ?? '').slice(0, 4000);
  const reply = (body) => tgCall(env, secrets.token, 'sendMessage', { chat_id: chatId, disable_web_page_preview: true, ...body });

  const pair = text.match(/^\/pair(?:@\w+)?\s+([0-9a-f]{8})\s*$/i);
  if (pair) {
    if (message.chat?.type !== 'private') return;
    if (await tryPair(env, connection, pair[1].toLowerCase(), chatId)) await reply({ text: 'Paired. This chat is now the owner chat. Send /help for the commands.' });
    return;
  }
  if (!connection.config.chat_id || chatId !== connection.config.chat_id) {
    // Another chat gets no answer. The log holds metadata only.
    console.log(JSON.stringify({ t: nowIso(), tg: 'ignored_chat', connection: connection.id, chatType: message.chat?.type ?? 'unknown' }));
    return;
  }
  if (text.startsWith('/')) {
    const out = await runCommand(env, connection, secrets, text, origin);
    await reply({ text: out.text.slice(0, 4000), ...(out.markup ? { reply_markup: out.markup } : {}) });
    return;
  }
  // Plain text: offer a task. The text waits for 10 minutes under a short key.
  const short = randomHex(4);
  await setSetting(env, `tg.pending.${connection.id}.${short}`, JSON.stringify({ text: text.slice(0, 2000), until: Date.now() + 10 * 60_000 }));
  const mac = await macOf(secrets.webhook_secret, `p${short}`, 'y');
  await reply({ text: 'Chat is not ready yet. Do you want a task from this message?', reply_markup: { inline_keyboard: [[{ text: 'Make a task', callback_data: `p:${short}:y:${mac}` }]] } });
}

async function handleCallback(env, connection, secrets, query, origin) {
  const chatId = String(query.message?.chat?.id ?? '');
  const answer = (text) => tgCall(env, secrets.token, 'answerCallbackQuery', { callback_query_id: query.id, text: text.slice(0, 190) }).catch(() => null);
  if (!connection.config.chat_id || chatId !== connection.config.chat_id || String(query.from?.id ?? '') !== chatId) {
    console.log(JSON.stringify({ t: nowIso(), tg: 'ignored_callback', connection: connection.id }));
    return;
  }
  const m = String(query.data ?? '').match(/^([ap]):([0-9a-f]{8}):([yn]):([0-9a-f]{16})$/);
  if (!m) return void (await answer('That button is not valid.'));
  const [, kind, id, d, mac] = m;
  const expected = await macOf(secrets.webhook_secret, kind === 'p' ? `p${id}` : id, d);
  if (!equalConstantTime(mac, expected)) {
    console.log(JSON.stringify({ t: nowIso(), tg: 'bad_mac', connection: connection.id }));
    return void (await answer('That button is not valid.'));
  }
  const clear = () => tgCall(env, secrets.token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => null);
  if (kind === 'p') {
    const raw = await getSetting(env, `tg.pending.${connection.id}.${id}`);
    await setSetting(env, `tg.pending.${connection.id}.${id}`, '');
    let pending = null;
    try {
      pending = raw ? JSON.parse(raw) : null;
    } catch {
      pending = null;
    }
    if (!pending || pending.until < Date.now()) return void (await answer('That request expired. Send the text again.'));
    const taskId = await queueTask(env, { brief: pending.text, taskType: 'auto', source: 'telegram' });
    await answer(`Queued task ${taskId.slice(0, 8)}.`);
    return void (await clear());
  }
  try {
    const r = await decideApproval(env, id, d === 'y' ? 'approve' : 'deny', 'telegram:button', origin);
    await answer(d === 'y' ? (r.status === 'executed' ? 'Approved and done.' : `Approved. It ended as ${r.status}.`) : 'Denied.');
  } catch (err) {
    await answer(err instanceof Error ? err.message : 'That did not work.');
  }
  await clear();
}

/** POST /hooks/telegram/:connectionId (group hook) */
export async function handleTelegramUpdate(c) {
  const { request, env } = c;
  const connection = await getConnection(env, c.params.connectionId);
  if (!connection || connection.connectorId !== 'telegram') return json({ error: 'not found' }, 404);
  const secrets = await loadSecrets(env, connection);
  const given = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!secrets.webhook_secret || !equalConstantTime(given, secrets.webhook_secret)) {
    await recordAuthFailure(request, env, 'hook').catch(() => null);
    return jsonError(401, 'bad_secret', 'The secret token is wrong.');
  }
  const raw = await request.text();
  if (raw.length > MAX_UPDATE_BYTES) return jsonError(413, 'too_large', 'The update is too large.');
  let update;
  try {
    update = JSON.parse(raw);
  } catch {
    return jsonError(400, 'bad_json', 'The body is not JSON.');
  }
  const last = Number(connection.meta?.lastUpdateId ?? -1);
  if (Number.isInteger(update.update_id)) {
    if (update.update_id <= last) return json({ ok: true, duplicate: true });
    connection.meta = { ...connection.meta, lastUpdateId: update.update_id };
    await updateConnection(env, connection.id, { meta: connection.meta });
  }
  const origin = new URL(request.url).origin;
  try {
    if (update.callback_query) await handleCallback(env, connection, secrets, update.callback_query, origin);
    else if (update.message?.text) await handleMessage(env, connection, secrets, update.message, origin);
  } catch (err) {
    // Telegram retries an update that gets a 5xx answer. A failed command is not worth a retry loop.
    console.error('titan-runner-brain: telegram update failed:', err instanceof Error ? err.message : err);
  }
  return json({ ok: true });
}
