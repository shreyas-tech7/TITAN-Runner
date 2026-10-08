/**
 * @file The callback token (Wave 12, K8). Workflows use it to call `/internal/*`. People never see it.
 *
 * The Worker makes 32 random bytes, keeps only the SHA-256 hash in D1, and writes the plain value to the Actions secret
 * `TITAN_CALLBACK_TOKEN` as a sealed box. The hash row is `pending` while the write runs and `active` only after the
 * write succeeds. If the write fails, the row is revoked and the next try waits one hour. A rotation retires the old
 * token with a 30 minute grace period. The scheduled rotation runs every 30 days.
 *
 * Legacy mode: until 30 minutes after the first callback token becomes active, `/internal/*` also accepts the admin
 * token, so workflows that still hold the old secret keep working. The diagnosis shows legacy mode as a problem.
 */
import { CALLBACK_HEADER, ADMIN_HEADER, checkAdminToken } from './lib/auth.js';
import { getSettings, setSetting } from './lib/db.js';
import { githubClient } from './lib/github.js';
import { sealForGithub } from './lib/sealedbox.js';
import { json, jsonError, nowIso, randomHex, sha256Hex } from './lib/util.js';
import { emitEvent } from './notify.js';

export const CALLBACK_SECRET_NAME = 'TITAN_CALLBACK_TOKEN';
export const GRACE_MS = 30 * 60_000;
export const ROTATE_EVERY_MS = 30 * 24 * 3600_000;
export const RETRY_AFTER_FAILURE_MS = 3600_000;

const LEGACY_WINDOW_MS = 30 * 60_000;

/**
 * Find a usable callback token by its plain value. A token is usable when it is pending, active, or retired but inside
 * its grace period, and it is not revoked.
 */
async function findCallbackRow(env, plain, now) {
  const hash = await sha256Hex(plain);
  return env.DB.prepare(
    `SELECT id, status, expires_at FROM worker_tokens
     WHERE kind = 'callback' AND token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(hash, nowIso(now))
    .first();
}

/** @returns {Promise<boolean>} True while the admin token still opens `/internal/*`. */
export async function isLegacyMode(env, now = new Date()) {
  const row = await env.DB.prepare("SELECT MIN(activated_at) AS first FROM worker_tokens WHERE kind = 'callback' AND activated_at IS NOT NULL").first();
  if (!row?.first) return true;
  return now.getTime() < Date.parse(row.first) + LEGACY_WINDOW_MS;
}

/**
 * Authenticate a call to an `/internal/*` route.
 * @returns {Promise<{ status: 'ok', kind: 'callback'|'admin-legacy' } | { status: 'missing'|'wrong'|'callback_required' }>}
 */
export async function authenticateInternal(request, env, now = new Date()) {
  const cb = request.headers.get(CALLBACK_HEADER);
  if (cb) {
    const row = await findCallbackRow(env, cb, now);
    return row ? { status: 'ok', kind: 'callback' } : { status: 'wrong' };
  }
  const admin = checkAdminToken(request, env);
  if (admin === 'ok') {
    return (await isLegacyMode(env, now)) ? { status: 'ok', kind: 'admin-legacy' } : { status: 'callback_required' };
  }
  return { status: admin === 'wrong' ? 'wrong' : 'missing' };
}

/**
 * Make a new callback token and put it into the repo secret.
 * @returns {Promise<{ ok: boolean, rotated: boolean, error?: string }>}
 */
export async function issueCallbackToken(env, now = new Date(), { reason = 'missing' } = {}) {
  if (!env.GITHUB_PAT) return { ok: false, rotated: false, error: 'GITHUB_PAT is not configured on this Worker yet.' };
  const plain = randomHex(32);
  const hash = await sha256Hex(plain);
  const created = nowIso(now);
  await env.DB.prepare("INSERT INTO worker_tokens (kind, token_hash, status, created_at) VALUES ('callback', ?, 'pending', ?)").bind(hash, created).run();
  try {
    const gh = githubClient(env);
    const { key, key_id: keyId } = await gh.getPublicKey({ forWrite: true });
    await gh.putSecret(CALLBACK_SECRET_NAME, await sealForGithub(plain, key), keyId);
  } catch (err) {
    await env.DB.prepare("UPDATE worker_tokens SET status = 'retired', revoked_at = ? WHERE token_hash = ?").bind(created, hash).run();
    const message = err instanceof Error ? err.message : 'unknown error';
    await setSetting(env, 'callback.retryAfter', nowIso(new Date(now.getTime() + RETRY_AFTER_FAILURE_MS)), now);
    await setSetting(env, 'callback.lastError', message.slice(0, 300), now);
    await emitEvent(env, { type: 'callback.broken', severity: 'error', title: 'The Worker could not set the callback token', body: message.slice(0, 200), dedupeKey: 'callback-write-failed' }, now).catch(() => null);
    return { ok: false, rotated: false, error: message };
  }
  // The write worked. Retire the previous tokens with a grace period, then mark the new one active.
  const graceEnds = nowIso(new Date(now.getTime() + GRACE_MS));
  await env.DB.prepare("UPDATE worker_tokens SET status = 'retired', expires_at = ? WHERE kind = 'callback' AND status = 'active' AND token_hash != ?").bind(graceEnds, hash).run();
  await env.DB.prepare("UPDATE worker_tokens SET status = 'active', activated_at = ? WHERE token_hash = ?").bind(created, hash).run();
  await setSetting(env, 'callback.lastError', '', now);
  await setSetting(env, 'callback.retryAfter', '', now);
  await setSetting(env, 'callback.lastIssueReason', reason, now);
  return { ok: true, rotated: reason !== 'missing' };
}

/** The upkeep step of the 1-minute tick. It makes the first token and rotates it every 30 days. */
export async function tickCallbackToken(env, now = new Date()) {
  if (!env.GITHUB_PAT) return { action: 'skip', reason: 'no_pat' };
  const settings = await getSettings(env, ['callback.retryAfter']);
  if (settings['callback.retryAfter'] && Date.parse(settings['callback.retryAfter']) > now.getTime()) return { action: 'wait' };
  const active = await env.DB.prepare("SELECT created_at FROM worker_tokens WHERE kind = 'callback' AND status = 'active' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1").first();
  if (!active) return { action: 'issue', ...(await issueCallbackToken(env, now, { reason: 'missing' })) };
  if (now.getTime() - Date.parse(active.created_at) > ROTATE_EVERY_MS) return { action: 'rotate', ...(await issueCallbackToken(env, now, { reason: 'scheduled' })) };
  return { action: 'ok' };
}

/** POST /admin/callback-token/rotate. The route never returns the token. */
export async function handleRotateCallback(c) {
  const now = new Date();
  const result = await issueCallbackToken(c.env, now, { reason: 'forced' });
  if (!result.ok) return json({ ok: false, error: 'rotate_failed', message: result.error, requestId: c.requestId }, 502);
  return json({ ok: true, rotatedAt: nowIso(now), previousValidUntil: nowIso(new Date(now.getTime() + GRACE_MS)), requestId: c.requestId });
}

/** GET /admin/callback: the state of the callback path, for Settings and the Health Center. */
export async function handleCallbackState(c) {
  const { env } = c;
  const now = new Date();
  const active = await env.DB.prepare("SELECT created_at, activated_at FROM worker_tokens WHERE kind = 'callback' AND status = 'active' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1").first();
  const settings = await getSettings(env, ['callback.retryAfter', 'callback.lastError']);
  const ping = await env.DB.prepare('SELECT id, requested_at, received_at, auth_kind FROM callback_pings ORDER BY requested_at DESC LIMIT 1').first();
  const legacy = await isLegacyMode(env, now);
  return json({
    hasToken: Boolean(active),
    activeSince: active?.activated_at ?? null,
    legacyMode: legacy,
    retryAfter: settings['callback.retryAfter'] || null,
    lastError: settings['callback.lastError'] || null,
    lastPing: ping
      ? { id: ping.id, requestedAt: ping.requested_at, receivedAt: ping.received_at, authKind: ping.auth_kind, seconds: ping.received_at ? Math.round((Date.parse(ping.received_at) - Date.parse(ping.requested_at)) / 1000) : null }
      : null,
    requestId: c.requestId,
  });
}

/** POST /admin/callback-ping: ask a runner to call back. The dashboard then polls GET /admin/callback. */
export async function handleStartPing(c) {
  const { env } = c;
  if (!env.GITHUB_PAT) return jsonError(503, 'pat_missing', 'GITHUB_PAT is not configured on this Worker yet.');
  const id = `ping_${randomHex(6)}`;
  await env.DB.prepare('INSERT INTO callback_pings (id, requested_at) VALUES (?, ?)').bind(id, nowIso()).run();
  try {
    await githubClient(env).dispatch('callback-ping', { id });
  } catch (err) {
    return jsonError(502, 'dispatch_failed', err instanceof Error ? err.message : 'dispatch failed', { id });
  }
  return json({ ok: true, id, requestId: c.requestId });
}

/** POST /internal/ping: the workflow `callback-ping.yml` calls this. */
export async function handleInternalPing(c) {
  const body = await c.request.json().catch(() => ({}));
  const id = typeof body?.id === 'string' ? body.id.slice(0, 40) : '';
  if (!id) return jsonError(400, 'id_required', 'The ping id is required.');
  const res = await c.env.DB.prepare('UPDATE callback_pings SET received_at = ?, auth_kind = ? WHERE id = ? AND received_at IS NULL').bind(nowIso(), c.auth?.kind ?? 'callback', id).run();
  if ((res.meta?.changes ?? 0) === 0) return jsonError(404, 'unknown_ping', 'No open ping has this id.');
  return json({ ok: true, authKind: c.auth?.kind ?? 'callback' });
}

export { ADMIN_HEADER };
