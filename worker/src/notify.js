/**
 * @file The event log and the entry point of the notification router (Wave 12, C7).
 *
 * Release 1 records every event in the `events` table. Release 2 adds the rules and the channels on top of the
 * same function, so no caller changes. An event holds a title and a short text. It never holds a secret, and it
 * never holds personal data.
 */
import { nowIso } from './lib/util.js';

export const EVENT_TYPES = Object.freeze([
  'task.done', 'task.failed', 'approval.needed', 'key.invalid', 'key.proven', 'callback.broken', 'pulse.late',
  'connector.needs_reconnect', 'brief.daily', 'schedule.fired', 'hook.received', 'notify.custom',
]);

const DEDUPE_WINDOW_MS = 30 * 60_000;

/**
 * Record an event. An event with the same dedupe key inside the window is dropped.
 * @param {{ DB: any }} env
 * @param {{ type: string, severity?: 'info'|'warn'|'error', title: string, body?: string, source?: string, dedupeKey?: string }} event
 * @returns {Promise<{ recorded: boolean, id?: number }>}
 */
export async function emitEvent(env, event, now = new Date()) {
  if (!env?.DB || !EVENT_TYPES.includes(event.type)) return { recorded: false };
  if (event.dedupeKey) {
    const since = nowIso(new Date(now.getTime() - DEDUPE_WINDOW_MS));
    const hit = await env.DB.prepare('SELECT id FROM events WHERE dedupe_key = ? AND at > ? LIMIT 1').bind(event.dedupeKey, since).first();
    if (hit) return { recorded: false };
  }
  const res = await env.DB.prepare('INSERT INTO events (at, type, severity, title, body, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(nowIso(now), event.type, event.severity ?? 'info', String(event.title).slice(0, 200), event.body ? String(event.body).slice(0, 500) : null, event.source ?? null, event.dedupeKey ?? null)
    .run();
  return { recorded: true, id: res.meta?.last_row_id };
}
