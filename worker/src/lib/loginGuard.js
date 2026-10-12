/**
 * @file Sign-in limits (RT5): per client (from CF-Connecting-IP) and overall, with lockout and backoff.
 *
 * Per client: 5 wrong tokens in 15 minutes lock that client. The first lock lasts 2 minutes. Each new lock in the same
 * day doubles the time (2, 4, 8, 16, 32, then 60 minutes at most). A good sign-in clears the client.
 *
 * Overall: if all clients together send 60 wrong tokens in 10 minutes, the whole sign-in route goes into a 10 minute
 * throttle. During the throttle only a client that signed in well in the last 30 days may try. The owner keeps access
 * and a spread out attack cannot guess.
 *
 * Limits come from Worker variables: `TITAN_LOGIN_MAX_FAILURES` (default 5) and `TITAN_LOGIN_GLOBAL_MAX` (default 60).
 */
import { clientAddress } from './auth.js';
import { clientKey } from './rateLimit.js';
import { nowIso } from './util.js';

const IP_WINDOW_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 10 * 60_000;
const GLOBAL_LOCK_MS = 10 * 60_000;
const MAX_LOCK_MINUTES = 60;
const KNOWN_CLIENT_DAYS = 30;

const clampInt = (raw, min, max, fallback) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const loginLimits = (env) => ({
  maxFailures: clampInt(env?.TITAN_LOGIN_MAX_FAILURES, 1, 50, 5),
  globalMax: clampInt(env?.TITAN_LOGIN_GLOBAL_MAX, 5, 1000, 60),
});

/** True when this address signed in well in the last 30 days. */
async function isKnownClient(env, request, now) {
  const row = await env.DB.prepare("SELECT 1 AS hit FROM signin_log WHERE ip = ? AND route = 'login' AND result = 'success' AND at > ? LIMIT 1")
    .bind(clientAddress(request).slice(0, 64), nowIso(new Date(now.getTime() - KNOWN_CLIENT_DAYS * 24 * 3600_000))).first();
  return Boolean(row);
}

const secondsLeft = (until, now) => Math.max(1, Math.ceil((Date.parse(until) - now.getTime()) / 1000));

/**
 * @returns {Promise<{ locked: false } | { locked: true, reason: 'locked_ip'|'locked_global', retryAfterSeconds: number }>}
 */
export async function checkLoginGuard(env, request, now = new Date()) {
  if (!env?.DB) return { locked: false };
  const ip = await env.DB.prepare('SELECT locked_until FROM login_limits WHERE key = ?').bind(await clientKey(request, env, 'login')).first();
  if (ip?.locked_until && Date.parse(ip.locked_until) > now.getTime()) {
    return { locked: true, reason: 'locked_ip', retryAfterSeconds: secondsLeft(ip.locked_until, now) };
  }
  const global = await env.DB.prepare("SELECT locked_until FROM login_limits WHERE key = 'global'").first();
  if (global?.locked_until && Date.parse(global.locked_until) > now.getTime() && !(await isKnownClient(env, request, now))) {
    return { locked: true, reason: 'locked_global', retryAfterSeconds: secondsLeft(global.locked_until, now) };
  }
  return { locked: false };
}

/** Count one wrong token for this client and for everyone. */
export async function recordLoginFailure(env, request, now = new Date()) {
  if (!env?.DB) return;
  const limits = loginLimits(env);
  const t = now.getTime();
  const key = await clientKey(request, env, 'login');
  const row = await env.DB.prepare('SELECT window_start, failures, strikes FROM login_limits WHERE key = ?').bind(key).first();
  const inWindow = row && t - Date.parse(row.window_start) <= IP_WINDOW_MS;
  let failures = inWindow ? row.failures + 1 : 1;
  const windowStart = inWindow ? row.window_start : nowIso(now);
  let strikes = row?.strikes ?? 0;
  let lockedUntil = null;
  if (failures >= limits.maxFailures) {
    strikes += 1;
    lockedUntil = nowIso(new Date(t + Math.min(MAX_LOCK_MINUTES, 2 ** strikes) * 60_000));
    failures = 0;
  }
  await env.DB.prepare(
    `INSERT INTO login_limits (key, window_start, failures, strikes, locked_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, failures = excluded.failures, strikes = excluded.strikes, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
  ).bind(key, windowStart, failures, strikes, lockedUntil, nowIso(now)).run();

  const g = await env.DB.prepare("SELECT window_start, failures, locked_until FROM login_limits WHERE key = 'global'").first();
  const gIn = g && t - Date.parse(g.window_start) <= GLOBAL_WINDOW_MS;
  const gFailures = gIn ? g.failures + 1 : 1;
  const gStart = gIn ? g.window_start : nowIso(now);
  let gLocked = g?.locked_until && Date.parse(g.locked_until) > t ? g.locked_until : null;
  if (gFailures >= limits.globalMax && !gLocked) gLocked = nowIso(new Date(t + GLOBAL_LOCK_MS));
  await env.DB.prepare(
    `INSERT INTO login_limits (key, window_start, failures, strikes, locked_until, updated_at) VALUES ('global', ?, ?, 0, ?, ?)
     ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
  ).bind(gStart, gFailures, gLocked, nowIso(now)).run();
}

/** A good sign-in clears the client. */
export async function recordLoginSuccess(env, request) {
  if (!env?.DB) return;
  await env.DB.prepare('DELETE FROM login_limits WHERE key = ?').bind(await clientKey(request, env, 'login')).run();
}

/** Delete limiter rows that nobody touched for two days. The global row stays. */
export async function pruneLoginLimits(env, now = new Date()) {
  const res = await env.DB.prepare("DELETE FROM login_limits WHERE key != 'global' AND updated_at < ?")
    .bind(nowIso(new Date(now.getTime() - 2 * 24 * 3600_000))).run();
  return res.meta?.changes ?? 0;
}
