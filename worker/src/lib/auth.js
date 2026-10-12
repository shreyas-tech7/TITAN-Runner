/**
 * @file Tokens, lockout, and CORS (Wave 12, S1, S2, S3).
 *
 * Each token type has one job (decision W12-D6):
 *   - admin:    people. The header `X-Titan-Auth`. It opens the `admin` routes.
 *   - callback: workflows. The header `X-Titan-Callback`. It opens the `internal` routes. The Worker manages it.
 *   - mcp:      tools. The Authorization header with a Bearer value. It opens `/mcp` only, within its scopes.
 *   - hook:     inbound webhooks. A secret for one hook. It opens that one `/hooks/...` route only.
 * The route table that gives each route its group is in `routes.js` and in docs/RUNTIME.md.
 */
import { lookupSession, SESSION_PREFIX } from './sessions.js';
import { nowIso, sha256Hex, timingSafeEqual } from './util.js';

export const ADMIN_HEADER = 'X-Titan-Auth';
export const CALLBACK_HEADER = 'X-Titan-Callback';

/**
 * Wrong token attempts: 10 in 10 minutes lock the client out of that route group for 15 minutes.
 * Each new lock doubles (RT5 backoff): 15 minutes, 30, 60, and so on, to a ceiling of 24 hours.
 */
export const LOCKOUT = Object.freeze({ maxFailures: 10, windowMs: 10 * 60_000, lockMs: 15 * 60_000, maxLockMs: 24 * 3600_000 });

/** The dashboard origin. CORS allows this origin only (RT5). */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['https://shreyas-tech7.github.io']);

/** Local dashboard origins. They count only when `TITAN_DEV_ORIGINS` is `1`. The deployed Worker never sets it. */
export const DEV_ORIGINS = Object.freeze(['http://localhost:3000', 'http://127.0.0.1:3000']);

export function allowedOrigins(env) {
  const extra = typeof env?.TITAN_ALLOWED_ORIGINS === 'string' ? env.TITAN_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const dev = env?.TITAN_DEV_ORIGINS === '1' ? DEV_ORIGINS : [];
  return [...DEFAULT_ALLOWED_ORIGINS, ...dev, ...extra];
}

/**
 * CORS headers for a response. Hook routes and OAuth callbacks never get CORS. A browser never calls them.
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {string} group The route group.
 */
export function corsHeaders(request, env, group) {
  const headers = { Vary: 'Origin' };
  if (group === 'hook' || group === 'oauth' || group === 'ops') return headers;
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Titan-Auth, Authorization, Mcp-Protocol-Version, Mcp-Session-Id';
    headers['Access-Control-Expose-Headers'] = 'X-Request-Id';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

/** True when the request may go on: no Origin header (a tool), or an allowed origin. */
export function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  return !origin || allowedOrigins(env).includes(origin);
}

// ---------------------------------------------------------------------
// The admin token
// ---------------------------------------------------------------------

/** @returns {'ok'|'missing'|'wrong'} */
export function checkAdminToken(request, env) {
  const token = request.headers.get(ADMIN_HEADER);
  if (!token) return 'missing';
  return env.TITAN_ADMIN_TOKEN && timingSafeEqual(token, env.TITAN_ADMIN_TOKEN) ? 'ok' : 'wrong';
}

export function isAuthed(request, env) {
  return checkAdminToken(request, env) === 'ok';
}

/**
 * The admin check for the `admin` routes. The header X-Titan-Auth holds either the admin token (scripts, curl) or a
 * session token that starts with `tsn_` (the dashboard). An expired session is not a wrong token, so it does not
 * count toward the lockout.
 * @returns {Promise<{ status: 'ok'|'missing'|'wrong'|'expired', kind?: 'token'|'session', sessionId?: string, reason?: string }>}
 */
export async function authenticateAdmin(request, env, now = new Date()) {
  const token = request.headers.get(ADMIN_HEADER);
  if (!token) return { status: 'missing' };
  if (token.startsWith(SESSION_PREFIX)) {
    if (!env?.DB) return { status: 'wrong' };
    const session = await lookupSession(env, token, now);
    if (session.ok) return { status: 'ok', kind: 'session', sessionId: session.id };
    return session.reason === 'unknown' ? { status: 'wrong', reason: 'unknown_session' } : { status: 'expired', reason: `session_${session.reason}` };
  }
  return checkAdminToken(request, env) === 'ok' ? { status: 'ok', kind: 'token' } : { status: 'wrong', reason: 'wrong_token' };
}

// ---------------------------------------------------------------------
// Lockout (S2)
// ---------------------------------------------------------------------

export function clientAddress(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** The key is a hash of the address, the group, and a secret pepper. The raw address is never stored. */
export async function lockoutKey(request, env, group) {
  const pepper = env.CONNECTOR_KEK ?? env.TITAN_ADMIN_TOKEN ?? 'titan';
  return sha256Hex(`${clientAddress(request)}|${group}|${pepper}`);
}

/**
 * @returns {Promise<{ locked: boolean, retryAfterSeconds: number }>}
 */
export async function checkLockout(request, env, group, now = new Date()) {
  if (!env?.DB) return { locked: false, retryAfterSeconds: 0 };
  const key = await lockoutKey(request, env, group);
  const row = await env.DB.prepare('SELECT locked_until FROM auth_failures WHERE key = ?').bind(key).first();
  if (row?.locked_until && Date.parse(row.locked_until) > now.getTime()) {
    return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(row.locked_until) - now.getTime()) / 1000)) };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

/**
 * Count one wrong token. After 10 in 10 minutes the client is locked for 15 minutes. Each new lock in the same day
 * doubles the time, to a ceiling of 24 hours.
 */
export async function recordAuthFailure(request, env, group, now = new Date()) {
  if (!env?.DB) return;
  const key = await lockoutKey(request, env, group);
  const row = await env.DB.prepare('SELECT window_start, failures, strikes FROM auth_failures WHERE key = ?').bind(key).first();
  const t = now.getTime();
  const inWindow = row && t - Date.parse(row.window_start) <= LOCKOUT.windowMs;
  let failures = inWindow ? row.failures + 1 : 1;
  const windowStart = inWindow ? row.window_start : nowIso(now);
  let strikes = row?.strikes ?? 0;
  let lockedUntil = null;
  if (failures >= LOCKOUT.maxFailures) {
    lockedUntil = nowIso(new Date(t + Math.min(LOCKOUT.maxLockMs, LOCKOUT.lockMs * 2 ** Math.min(strikes, 10))));
    strikes += 1;
    failures = 0;
  }
  await env.DB.prepare(
    `INSERT INTO auth_failures (key, route_group, window_start, failures, locked_until, updated_at, strikes) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at, strikes = excluded.strikes`,
  )
    .bind(key, group, windowStart, failures, lockedUntil, nowIso(now), strikes)
    .run();
}

/** Delete lockout rows older than one day. */
export async function pruneAuthFailures(env, now = new Date()) {
  const cutoff = nowIso(new Date(now.getTime() - 24 * 3600_000));
  const res = await env.DB.prepare('DELETE FROM auth_failures WHERE updated_at < ?').bind(cutoff).run();
  return res.meta?.changes ?? 0;
}
