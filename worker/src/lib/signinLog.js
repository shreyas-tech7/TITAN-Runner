/**
 * @file The sign-in log (RT5). One row for each sign-in attempt and each wrong token on a protected route.
 *
 * The log holds the time, the IP address, the user agent, the route, the result, and the reason. It lives in D1 only.
 * The Worker shows it behind a sign-in (`GET /admin/security/signins`). It never goes to `state/` or to the public site.
 */
import { clientAddress } from './auth.js';
import { nowIso } from './util.js';

/** Results: `success`, `failure`, or `blocked`. */
export const RESULTS = Object.freeze(['success', 'failure', 'blocked']);

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * Write one row. It never throws, because a log problem must not block a request.
 * @param {Record<string, any>} env
 * @param {Request} request
 * @param {{ route: string, result: 'success'|'failure'|'blocked', reason: string, now?: Date }} entry
 */
export async function logSignin(env, request, entry) {
  if (!env?.DB) return;
  const now = entry.now ?? new Date();
  const ip = clean(clientAddress(request), 64) || 'unknown';
  try {
    // A client that keeps knocking while locked would fill the table. Log one blocked row each 5 minutes.
    if (entry.result === 'blocked') {
      const recent = await env.DB.prepare("SELECT 1 AS hit FROM signin_log WHERE ip = ? AND result = 'blocked' AND at > ? LIMIT 1")
        .bind(ip, nowIso(new Date(now.getTime() - 5 * 60_000))).first();
      if (recent) return;
    }
    await env.DB.prepare('INSERT INTO signin_log (at, ip, user_agent, route, result, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(nowIso(now), ip, clean(request.headers.get('User-Agent'), 200) || null, clean(entry.route, 40), entry.result, clean(entry.reason, 60))
      .run();
  } catch (err) {
    console.error('titan-runner-brain: sign-in log write failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * @param {Record<string, any>} env
 * @param {{ limit?: number, result?: string|null }} [opts]
 */
export async function listSignins(env, opts = {}) {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const result = RESULTS.includes(opts.result) ? opts.result : null;
  const { results } = result
    ? await env.DB.prepare('SELECT id, at, ip, user_agent, route, result, reason FROM signin_log WHERE result = ? ORDER BY id DESC LIMIT ?').bind(result, limit).all()
    : await env.DB.prepare('SELECT id, at, ip, user_agent, route, result, reason FROM signin_log ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (results ?? []).map((r) => ({ id: r.id, at: r.at, ip: r.ip, userAgent: r.user_agent, route: r.route, result: r.result, reason: r.reason }));
}

/** Counts for the last 24 hours. */
export async function summarizeSignins(env, now = new Date()) {
  const since = nowIso(new Date(now.getTime() - 24 * 3600_000));
  const { results } = await env.DB.prepare('SELECT result, COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM signin_log WHERE at > ? GROUP BY result').bind(since).all();
  const out = { success: 0, failure: 0, blocked: 0, distinctIps: 0 };
  let ips = 0;
  for (const r of results ?? []) {
    if (r.result in out) out[r.result] = r.n;
    ips = Math.max(ips, r.ips);
  }
  const all = await env.DB.prepare('SELECT COUNT(DISTINCT ip) AS ips FROM signin_log WHERE at > ?').bind(since).first();
  out.distinctIps = all?.ips ?? ips;
  return out;
}

/** Delete rows older than `days`. */
export async function pruneSignins(env, now = new Date(), days = 90) {
  const res = await env.DB.prepare('DELETE FROM signin_log WHERE at < ?').bind(nowIso(new Date(now.getTime() - days * 24 * 3600_000))).run();
  return res.meta?.changes ?? 0;
}
