/**
 * @file Small D1 helpers: the settings store and the key audit log. Neither one ever receives a key value.
 */
import { nowIso } from './util.js';

/** @param {{ DB: any }} env @param {string[]} keys @returns {Promise<Record<string, string|null>>} */
export async function getSettings(env, keys) {
  const out = Object.fromEntries(keys.map((k) => [k, null]));
  if (keys.length === 0) return out;
  const marks = keys.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${marks})`).bind(...keys).all();
  for (const row of results ?? []) out[row.key] = row.value;
  return out;
}

export async function getSetting(env, key) {
  return (await getSettings(env, [key]))[key];
}

export async function setSetting(env, key, value, now = new Date()) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
    .bind(key, value === null || value === undefined ? null : String(value), nowIso(now))
    .run();
}

/**
 * Write one audit event for a key action. The fields hold fingerprints and results only.
 * @param {{ DB: any }} env
 * @param {{ action: string, provider?: string|null, fingerprint?: string|null, oldFingerprint?: string|null, result?: string|null, actor?: string, requestId?: string|null, detail?: string|null }} e
 */
export async function recordKeyEvent(env, e, now = new Date()) {
  await env.DB.prepare(
    'INSERT INTO key_events (at, action, provider, fingerprint, old_fingerprint, result, actor, request_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(nowIso(now), e.action, e.provider ?? null, e.fingerprint ?? null, e.oldFingerprint ?? null, e.result ?? null, e.actor ?? 'admin', e.requestId ?? null, e.detail ? String(e.detail).slice(0, 300) : null)
    .run();
}
