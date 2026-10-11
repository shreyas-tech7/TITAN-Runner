/**
 * @file A fixed-window counter in D1 for public routes that write (RT5).
 *
 * `hitRateLimit()` counts one hit and tells the caller if the hit is inside the limit. The key holds a hash of the
 * client address, never the address.
 */
import { clientAddress } from './auth.js';
import { nowIso, sha256Hex } from './util.js';

/** A stable key for one client and one scope. The raw address is never stored. */
export async function clientKey(request, env, scope) {
  const pepper = env.CONNECTOR_KEK ?? env.TITAN_ADMIN_TOKEN ?? 'titan';
  return `${scope}:${await sha256Hex(`${clientAddress(request)}|${scope}|${pepper}`)}`;
}

/**
 * Count one hit.
 * @param {Record<string, any>} env
 * @param {string} key
 * @param {{ max: number, windowMs: number, now?: Date }} opts
 * @returns {Promise<{ allowed: boolean, count: number, retryAfterSeconds: number }>}
 */
export async function hitRateLimit(env, key, { max, windowMs, now = new Date() }) {
  if (!env?.DB) return { allowed: true, count: 0, retryAfterSeconds: 0 };
  const t = now.getTime();
  const cutoff = nowIso(new Date(t - windowMs));
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < ? THEN excluded.window_start ELSE rate_limits.window_start END,
       updated_at = excluded.updated_at`,
  )
    .bind(key, nowIso(now), nowIso(now), cutoff, cutoff)
    .run();
  const row = await env.DB.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').bind(key).first();
  const count = row?.count ?? 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(row?.window_start ?? nowIso(now)) + windowMs - t) / 1000));
  return { allowed: count <= max, count, retryAfterSeconds };
}

/** Delete counters that are older than two days. */
export async function pruneRateLimits(env, now = new Date()) {
  const cutoff = nowIso(new Date(now.getTime() - 2 * 24 * 3600_000));
  const res = await env.DB.prepare('DELETE FROM rate_limits WHERE updated_at < ?').bind(cutoff).run();
  return res.meta?.changes ?? 0;
}
