// Helpers for the connector hub tests (Wave 12, Track C, M, and T): a Worker caller, fake services, and a leak search.
import { createHmac } from 'node:crypto';
import worker from '../../src/index.js';
import { CALLBACK_SECRET_NAME, tickCallbackToken } from '../../src/callback.js';
import { ADMIN } from './world.mjs';

export const KEK = 'a1'.repeat(32);
export const IP = { 'CF-Connecting-IP': '203.0.113.5' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
export { json };

/** Call the Worker. Returns the status, the parsed body, and the headers. */
export function caller(env, ctx = { waitUntil() {} }) {
  const call = async (method, path, body, headers = { 'X-Titan-Auth': ADMIN }) => {
    const init = { method, headers: { ...IP, ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['content-type'] = init.headers['content-type'] ?? 'application/json';
    }
    const res = await worker.fetch(new Request(`https://worker.example${path}`, init), env, ctx);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers, text };
  };
  return {
    call,
    get: (path, headers) => call('GET', path, undefined, headers),
    post: (path, body, headers) => call('POST', path, body ?? {}, headers),
    del: (path, headers) => call('DELETE', path, undefined, headers),
  };
}

/** Make the real callback token through the tick, and return it. */
export async function callbackToken(world, env) {
  await tickCallbackToken(env, new Date());
  const plain = world.github.open(CALLBACK_SECRET_NAME);
  return { 'X-Titan-Callback': plain };
}

/** Every row of every table except the vault, as one string. A secret must not appear in it. */
export function dumpWithoutVault(env) {
  const dump = env.DB.dump();
  const rest = Object.fromEntries(Object.entries(dump).filter(([name]) => name !== 'vault_records'));
  return JSON.stringify(rest);
}

export const hmacHex = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');

/** A fake Discord webhook. */
export function fakeDiscord(world) {
  const sent = [];
  world.addHost('discord.com', async (req) => {
    if (req.method === 'GET') return json({ name: 'TITAN', channel_id: '55', guild_id: '66', token: 'x', id: '1' });
    sent.push(await req.json());
    return new Response(null, { status: 204 });
  });
  return sent;
}

export const discordUrl = (suffix = 'A'.repeat(24)) => ['https://discord.com/api/webhooks/', '123456789012345678', '/', suffix].join('');

/** A fake Telegram Bot API. It records every call. */
export function fakeTelegram(world) {
  const calls = [];
  world.addHost('api.telegram.org', async (req) => {
    const m = new URL(req.url).pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    calls.push({ method: m?.[2], payload, token: m?.[1] });
    if (m?.[2] === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, username: 'titan_test_bot', first_name: 'TITAN' } });
    if (m?.[2] === 'setWebhook') return json({ ok: true, result: true });
    if (m?.[2] === 'deleteWebhook') return json({ ok: true, result: true });
    return json({ ok: true, result: { message_id: calls.length } });
  });
  return calls;
}

export const telegramToken = () => ['123456789', ':', 'A'.repeat(35)].join('');

/** A fake Google OAuth server and Calendar API. */
export function fakeGoogle(world, { scopeOverride, refreshError } = {}) {
  const log = { tokens: [], calendar: [] };
  let n = 0;
  world.addHost('oauth2.googleapis.com', async (req) => {
    const form = new URLSearchParams(await req.text());
    log.tokens.push(Object.fromEntries(form.entries()));
    if (form.get('grant_type') === 'refresh_token') {
      if (refreshError) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      n += 1;
      return json({ access_token: `access-refreshed-${n}`, expires_in: 3600, token_type: 'Bearer', scope: scopeOverride ?? 'https://www.googleapis.com/auth/calendar.readonly' });
    }
    if (form.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
    n += 1;
    return json({ access_token: `access-${n}`, refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer', scope: scopeOverride ?? 'https://www.googleapis.com/auth/calendar.readonly' });
  });
  world.addHost('www.googleapis.com', async (req) => {
    log.calendar.push({ auth: req.headers.get('authorization'), path: new URL(req.url).pathname + new URL(req.url).search });
    return json({ items: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-10-09T10:00:00Z' }, end: { dateTime: '2026-10-09T11:00:00Z' } }] });
  });
  return log;
}
