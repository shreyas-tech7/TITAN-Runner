/**
 * @file The request pipeline: route match, CORS, lockout, token check, handler, and the structured log line (Wave 12, S1 to S3, R5).
 */
import { authenticateInternal } from './callback.js';
import {
  authenticateAdmin, checkLockout, corsHeaders, originAllowed, recordAuthFailure,
} from './lib/auth.js';
import { logSignin } from './lib/signinLog.js';
import { ensureMigrations } from './lib/migrate.js';
import { json, jsonError, newRequestId } from './lib/util.js';
import { authenticateMcp } from './mcpServer.js';
import { groupForPath, matchRoute } from './routes.js';

const LOCKABLE = new Set(['admin', 'internal', 'mcp', 'hook']);

/** The largest body that any route reads (RT5). A larger Content-Length is refused before a handler runs. */
export const MAX_BODY_BYTES = 262_144;

function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {ExecutionContext} [ctx]
 */
export async function handleRequest(request, env, ctx) {
  const started = Date.now();
  const requestId = newRequestId();
  const url = new URL(request.url);
  let matched = null;
  let badPath = false;
  try {
    matched = matchRoute(request.method, url.pathname);
  } catch {
    badPath = true; // a malformed %-escape in a path parameter
  }
  const group = matched?.route.group ?? (badPath ? 'admin' : groupForPath(url.pathname)) ?? 'admin';
  const log = { rid: requestId, group, route: matched?.route.path ?? 'unmatched', method: request.method, token: 'none' };
  let response;

  try {
    response = badPath
      ? jsonError(400, 'bad_path', 'The path holds a bad escape sequence.')
      : await route(request, env, ctx, { url, matched, group, requestId, log });
  } catch (err) {
    console.error(`titan-runner-brain: unhandled error ${requestId}:`, err instanceof Error ? err.message : err);
    response = jsonError(500, 'internal_error', `The Worker hit an error. Quote the request id ${requestId}.`, { requestId });
  }

  const noCors = group === 'hook' || group === 'oauth';
  const out = withHeaders(response, { ...corsHeaders(request, env, group), 'X-Request-Id': requestId, ...(noCors || group === 'public' ? {} : { 'Cache-Control': 'no-store' }) });
  console.log(JSON.stringify({ t: new Date().toISOString(), ...log, status: out.status, ms: Date.now() - started }));
  return out;
}

async function route(request, env, ctx, { url, matched, group, requestId, log }) {
  if (request.method === 'OPTIONS') {
    if (!originAllowed(request, env) || !request.headers.get('Origin')) return new Response(null, { status: request.headers.get('Origin') ? 403 : 204 });
    return new Response(null, { status: 204 });
  }
  if (!matched) return json({ error: 'not found' }, 404);

  // RT5: refuse a body that is too large before any handler reads it.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const length = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return jsonError(413, 'body_too_large', `The body is larger than ${MAX_BODY_BYTES} bytes.`);
  }

  // A browser sends Origin. An origin that is not on the list never reaches a handler (S3).
  if (matched.route.group !== 'hook' && matched.route.group !== 'oauth' && !originAllowed(request, env)) {
    return jsonError(403, 'origin_not_allowed', 'This origin is not on the allowlist.');
  }

  const needsDb = matched.route.group !== 'public' || matched.route.path === '/badge/pulse';
  if (needsDb && env.DB) {
    try {
      await ensureMigrations(env);
    } catch (err) {
      console.error('titan-runner-brain: migrations failed:', err instanceof Error ? err.message : err);
      return jsonError(503, 'migrations_failed', 'The database schema is not ready. Check the deploy log.', { requestId });
    }
  }

  let auth = { kind: 'none' };
  if (LOCKABLE.has(matched.route.group)) {
    const lock = await checkLockout(request, env, matched.route.group);
    if (lock.locked) {
      log.token = 'locked';
      if (matched.route.group === 'admin' || matched.route.group === 'internal') {
        await logSignin(env, request, { route: matched.route.group, result: 'blocked', reason: 'locked_out' });
      }
      const res = jsonError(429, 'locked_out', 'Too many wrong tokens. Try again later.', { retryAfterSeconds: lock.retryAfterSeconds, requestId });
      res.headers.set('Retry-After', String(lock.retryAfterSeconds));
      return res;
    }
  }

  if (matched.route.group === 'admin') {
    const result = await authenticateAdmin(request, env);
    if (result.status === 'ok') {
      auth = { kind: 'admin', via: result.kind === 'session' ? 'session' : 'token', sessionId: result.sessionId };
      log.token = result.kind === 'session' ? 'session' : 'admin';
    } else if (result.status === 'missing' && matched.route.path === '/chat' && request.headers.get('authorization')) {
      const mcp = await authenticateMcp(request, env);
      if (!mcp) {
        await recordAuthFailure(request, env, 'admin').catch(() => null);
        await logSignin(env, request, { route: 'admin', result: 'failure', reason: 'wrong_mcp_token' });
        return json({ error: 'unauthorized' }, 401);
      }
      if (!mcp.scopes.includes('chat:write')) {
        return jsonError(403, 'scope_missing', 'This MCP token lacks the chat:write scope.', { requestId });
      }
      auth = { kind: 'mcp', id: mcp.id, scopes: mcp.scopes };
      log.token = 'mcp';
    } else if (result.status === 'expired') {
      // An ended session is not a guess, so it does not count toward the lockout. The dashboard locks itself.
      await logSignin(env, request, { route: 'admin', result: 'failure', reason: result.reason });
      return jsonError(401, 'session_expired', 'The session ended. Sign in again.', { reason: result.reason });
    } else {
      if (result.status === 'wrong') {
        await recordAuthFailure(request, env, 'admin').catch(() => null);
        await logSignin(env, request, { route: 'admin', result: 'failure', reason: result.reason ?? 'wrong_token' });
      }
      return json({ error: 'unauthorized' }, 401);
    }
  } else if (matched.route.group === 'internal') {
    const result = await authenticateInternal(request, env);
    if (result.status !== 'ok') {
      if (result.status === 'wrong') {
        await recordAuthFailure(request, env, 'internal').catch(() => null);
        await logSignin(env, request, { route: 'internal', result: 'failure', reason: 'wrong_token' });
      }
      if (result.status === 'callback_required') {
        return jsonError(401, 'callback_token_required', 'The admin token no longer opens /internal routes. Send the callback token in X-Titan-Callback.');
      }
      return json({ error: 'unauthorized' }, 401);
    }
    auth = { kind: result.kind };
    log.token = result.kind;
  }

  return matched.route.handler({ request, env, ctx, url, params: matched.params, requestId, auth });
}
