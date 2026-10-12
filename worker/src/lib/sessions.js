/**
 * @file Dashboard sessions (RT5). A session stands in for the admin token in the browser.
 *
 * The person signs in once with the admin token. The Worker gives back a session token. The browser keeps the
 * session token and never keeps the admin token. A session ends after an idle time, or after an absolute time,
 * whichever comes first. The table holds only the SHA-256 hash of the token.
 *
 * Limits come from Worker variables:
 *   TITAN_SESSION_IDLE_MINUTES      default 30, from 5 to 1440
 *   TITAN_SESSION_ABSOLUTE_HOURS    default 12, from 1 to 72
 */
import { nowIso, randomBytes, sha256Hex, toBase64Url } from './util.js';
import { clientAddress } from './auth.js';

export const SESSION_PREFIX = 'tsn_';
const TOUCH_EVERY_MS = 60_000;

const clampInt = (raw, min, max, fallback) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** @returns {{ idleMs: number, absoluteMs: number }} */
export function sessionLimits(env) {
  return {
    idleMs: clampInt(env?.TITAN_SESSION_IDLE_MINUTES, 5, 1440, 30) * 60_000,
    absoluteMs: clampInt(env?.TITAN_SESSION_ABSOLUTE_HOURS, 1, 72, 12) * 3_600_000,
  };
}

/** @returns {Promise<{ token: string, id: string, expiresAt: string, idleSeconds: number, absoluteSeconds: number }>} */
export async function createSession(env, request, now = new Date()) {
  const limits = sessionLimits(env);
  const token = `${SESSION_PREFIX}${toBase64Url(randomBytes(32))}`;
  const id = await sha256Hex(token);
  const expiresAt = nowIso(new Date(now.getTime() + limits.absoluteMs));
  await env.DB.prepare('INSERT INTO sessions (id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, nowIso(now), nowIso(now), expiresAt, clientAddress(request).slice(0, 64), String(request.headers.get('User-Agent') ?? '').slice(0, 200) || null)
    .run();
  return { token, id, expiresAt, idleSeconds: limits.idleMs / 1000, absoluteSeconds: limits.absoluteMs / 1000 };
}

/**
 * Check a session token. A valid session moves its idle clock forward.
 * @returns {Promise<{ ok: true, id: string, expiresAt: string, idleExpiresAt: string } | { ok: false, reason: 'unknown'|'idle'|'absolute' }>}
 */
export async function lookupSession(env, token, now = new Date()) {
  const id = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT id, created_at, last_seen_at, expires_at FROM sessions WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, reason: 'unknown' };
  const limits = sessionLimits(env);
  const t = now.getTime();
  if (Date.parse(row.expires_at) <= t) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run().catch(() => null);
    return { ok: false, reason: 'absolute' };
  }
  const lastSeen = Date.parse(row.last_seen_at);
  if (t - lastSeen > limits.idleMs) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run().catch(() => null);
    return { ok: false, reason: 'idle' };
  }
  if (t - lastSeen > TOUCH_EVERY_MS) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso(now), id).run().catch(() => null);
  }
  const seen = t - lastSeen > TOUCH_EVERY_MS ? t : lastSeen;
  return { ok: true, id, expiresAt: row.expires_at, idleExpiresAt: nowIso(new Date(Math.min(Date.parse(row.expires_at), seen + limits.idleMs))) };
}

export async function endSession(env, id) {
  const res = await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Delete every session whose absolute time has passed or whose idle time has run out. */
export async function pruneSessions(env, now = new Date()) {
  const { idleMs } = sessionLimits(env);
  const res = await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?')
    .bind(nowIso(now), nowIso(new Date(now.getTime() - idleMs))).run();
  return res.meta?.changes ?? 0;
}
