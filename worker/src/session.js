/**
 * @file Sign in, sign out, the session check, and the sign-in log view (RT5).
 *
 *   POST /auth/login              public. Body {"token": "<admin token>"}. Gives back a session token.
 *   POST /auth/logout             admin. Ends the session.
 *   GET  /auth/session            admin. Says when the session ends.
 *   GET  /admin/security/signins  admin. The sign-in log and a 24 hour summary.
 *
 * The login route has its own limits (`lib/loginGuard.js`) and writes every attempt to the sign-in log.
 */
import { ADMIN_HEADER } from './lib/auth.js';
import { checkLoginGuard, recordLoginFailure, recordLoginSuccess } from './lib/loginGuard.js';
import { createSession, endSession, lookupSession, sessionLimits } from './lib/sessions.js';
import { listSignins, logSignin, summarizeSignins } from './lib/signinLog.js';
import { clampInt, json, jsonError, readJson, timingSafeEqual } from './lib/util.js';

/** POST /auth/login */
export async function handleLogin(c) {
  const { request, env } = c;
  const now = new Date();
  if (!env.TITAN_ADMIN_TOKEN) return jsonError(503, 'admin_token_not_set', 'The Worker has no admin token yet. Set TITAN_ADMIN_TOKEN.');

  const guard = await checkLoginGuard(env, request, now);
  if (guard.locked) {
    await logSignin(env, request, { route: 'login', result: 'blocked', reason: guard.reason, now });
    const res = jsonError(429, 'locked_out', 'Too many wrong tokens. Try again later.', { retryAfterSeconds: guard.retryAfterSeconds, requestId: c.requestId });
    res.headers.set('Retry-After', String(guard.retryAfterSeconds));
    return res;
  }

  const parsed = await readJson(request, 2048);
  const token = parsed.ok && typeof parsed.value.token === 'string' ? parsed.value.token : '';
  if (!token || token.length > 512) {
    await recordLoginFailure(env, request, now);
    await logSignin(env, request, { route: 'login', result: 'failure', reason: parsed.ok ? 'missing_token' : 'bad_body', now });
    return jsonError(parsed.ok ? 401 : 400, parsed.ok ? 'unauthorized' : 'invalid_body', parsed.ok ? undefined : 'Send a JSON body with a token field.');
  }
  if (!timingSafeEqual(token, env.TITAN_ADMIN_TOKEN)) {
    await recordLoginFailure(env, request, now);
    await logSignin(env, request, { route: 'login', result: 'failure', reason: 'wrong_token', now });
    return json({ error: 'unauthorized' }, 401);
  }

  await recordLoginSuccess(env, request);
  const session = await createSession(env, request, now);
  await logSignin(env, request, { route: 'login', result: 'success', reason: 'ok', now });
  return json({
    session: session.token,
    expires_at: session.expiresAt,
    idle_timeout_seconds: session.idleSeconds,
    absolute_timeout_seconds: session.absoluteSeconds,
  });
}

/** POST /auth/logout */
export async function handleLogout(c) {
  if (c.auth.via !== 'session') return json({ ok: true, ended: false, note: 'The admin token has no session to end.' });
  const ended = await endSession(c.env, c.auth.sessionId);
  return json({ ok: true, ended });
}

/** GET /auth/session */
export async function handleSessionInfo(c) {
  const limits = sessionLimits(c.env);
  if (c.auth.via !== 'session') {
    return json({ kind: 'token', idle_timeout_seconds: limits.idleMs / 1000, absolute_timeout_seconds: limits.absoluteMs / 1000 });
  }
  const token = c.request.headers.get(ADMIN_HEADER);
  const s = await lookupSession(c.env, token);
  if (!s.ok) return jsonError(401, 'session_expired', 'The session ended.');
  return json({
    kind: 'session',
    expires_at: s.expiresAt,
    idle_expires_at: s.idleExpiresAt,
    idle_timeout_seconds: limits.idleMs / 1000,
    absolute_timeout_seconds: limits.absoluteMs / 1000,
  });
}

/** GET /admin/security/signins?limit=100&result=failure */
export async function handleSigninLog(c) {
  const q = c.url.searchParams;
  const entries = await listSignins(c.env, { limit: clampInt(q.get('limit'), 1, 500, 100), result: q.get('result') });
  const summary = await summarizeSignins(c.env);
  return json({ generatedAt: new Date().toISOString(), summary, entries });
}
