/**
 * @file The notification router (Wave 12, C7). It reads the `events` table and sends each event through the channels that
 * the rules name. A channel is a connection of Telegram, Discord, Slack, ntfy, or an outbound webhook.
 *
 * Rules
 *   - A rule has an event pattern (`task.failed`, `task.*`, or `*`), a minimum severity, quiet hours, and a dedupe window.
 *   - The time zone of a rule is `America/Chicago` unless the rule says another. An `error` event ignores quiet hours.
 *   - An event with the type `hook.received` holds text from outside. It goes out only through a rule with `allow_personal`.
 *   - Each send goes through the broker, so the rate limit and the call log apply.
 */
import { nowIso, randomHex } from '../lib/util.js';
import { invokeAction } from './broker.js';
import { manifestById } from './core.js';
import { getConnection, listConnections } from './store.js';

export const SEVERITY = Object.freeze({ info: 0, warn: 1, error: 2 });
export const DEFAULT_TZ = 'America/Chicago';
export const DEFAULT_RULE_EVENTS = Object.freeze(['approval.needed', 'task.failed', 'key.invalid', 'callback.broken', 'pulse.late', 'connector.needs_reconnect']);
const BATCH = 10;
const CHANNELS = Object.freeze({
  telegram: (e) => ({ actionId: 'send_message', input: { text: `${e.title}${e.body ? `\n${e.body}` : ''}`.slice(0, 3900) } }),
  discord_webhook: (e) => ({ actionId: 'send', input: { text: `${e.title}${e.body ? `\n${e.body}` : ''}`.slice(0, 1900) } }),
  slack_webhook: (e) => ({ actionId: 'send', input: { text: `${e.title}${e.body ? `\n${e.body}` : ''}`.slice(0, 2900) } }),
  ntfy: (e) => ({ actionId: 'publish', input: { message: (e.body || e.title).slice(0, 1900), title: e.title.slice(0, 95), priority: e.severity === 'error' ? 'high' : e.severity === 'warn' ? 'default' : 'low' } }),
  webhook_out: (e) => ({ actionId: 'send_json', input: { payload: { event: e.type, severity: e.severity, title: e.title, body: e.body ?? '', at: e.at } } }),
});

export const isChannel = (connectorId) => connectorId in CHANNELS;

/** @param {string} pattern @param {string} type */
export function patternMatches(pattern, type) {
  if (pattern === '*' || pattern === type) return true;
  return pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1));
}

/** The local time as minutes since midnight in a time zone. */
export function minutesInZone(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

const toMinutes = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? '');
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** True when `date` falls inside the quiet hours. The range may cross midnight. */
export function inQuietHours(rule, date) {
  const start = toMinutes(rule.quiet_start);
  const end = toMinutes(rule.quiet_end);
  if (start === null || end === null || start === end) return false;
  const now = minutesInZone(date, rule.tz || DEFAULT_TZ);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function deliveredRecently(env, rule, connectionId, event, now) {
  const since = nowIso(new Date(now.getTime() - rule.dedupe_minutes * 60_000));
  const hit = await env.DB.prepare(
    `SELECT 1 AS hit FROM notify_deliveries d JOIN events e ON e.id = d.event_id
     WHERE d.rule_id = ? AND d.connection_id = ? AND d.ok = 1 AND d.at > ? AND e.type = ? AND e.title = ? LIMIT 1`,
  )
    .bind(rule.id, connectionId, since, event.type, event.title)
    .first();
  return Boolean(hit);
}

/** Send one event through one connection. @returns {Promise<{ ok: boolean, error?: string }>} */
export async function deliver(env, connection, event, origin) {
  const make = CHANNELS[connection.connectorId];
  if (!make) return { ok: false, error: 'This connection is not a notification channel.' };
  const call = make(event);
  try {
    const res = await invokeAction(env, { connectionId: connection.id, actionId: call.actionId, input: call.input, caller: { kind: 'owner', id: 'router' }, origin });
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'The channel refused the message.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'error' };
  }
}

/**
 * Route the next unrouted events. The free plan limits the work of one tick, so only a few events go out each time.
 * @returns {Promise<{ routed: number, sent: number, failed: number, skipped: number }>}
 */
export async function routeEvents(env, now = new Date(), origin = env.WORKER_URL ?? '') {
  const { results: events } = await env.DB.prepare('SELECT * FROM events WHERE routed = 0 ORDER BY id ASC LIMIT ?').bind(BATCH).all();
  if (!events?.length) return { routed: 0, sent: 0, failed: 0, skipped: 0 };
  const { results: rules } = await env.DB.prepare('SELECT * FROM notify_rules WHERE enabled = 1').all();
  const out = { routed: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of events) {
    const event = { id: row.id, type: row.type, severity: row.severity, title: row.title, body: row.body, at: row.at };
    // A message that a tool sent with titan_notify goes to every channel. The person chose to connect those channels.
    if (event.type === 'notify.custom') {
      for (const connection of await listConnections(env)) {
        if (!isChannel(connection.connectorId) || connection.status === 'needs_reconnect') continue;
        const res = await deliver(env, connection, event, origin);
        if (res.ok) out.sent += 1;
        else out.failed += 1;
      }
    }
    for (const rule of rules ?? []) {
      if (!patternMatches(rule.event_pattern, event.type)) continue;
      if ((SEVERITY[event.severity] ?? 0) < (SEVERITY[rule.min_severity] ?? 0)) continue;
      if (event.type === 'hook.received' && !rule.allow_personal) {
        out.skipped += 1;
        continue;
      }
      if (event.severity !== 'error' && inQuietHours(rule, now)) {
        out.skipped += 1;
        continue;
      }
      let ids = [];
      try {
        ids = JSON.parse(rule.connection_ids);
      } catch {
        ids = [];
      }
      for (const connectionId of ids) {
        const connection = await getConnection(env, connectionId);
        if (!connection) continue;
        if (await deliveredRecently(env, rule, connectionId, event, now)) {
          out.skipped += 1;
          continue;
        }
        const res = await deliver(env, connection, event, origin);
        await env.DB.prepare('INSERT INTO notify_deliveries (event_id, rule_id, connection_id, at, ok, error) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(event.id, rule.id, connectionId, nowIso(now), res.ok ? 1 : 0, res.error ?? null)
          .run();
        if (res.ok) out.sent += 1;
        else out.failed += 1;
      }
    }
    await env.DB.prepare('UPDATE events SET routed = 1 WHERE id = ?').bind(row.id).run();
    out.routed += 1;
  }
  return out;
}

// ---------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------

const publicRule = (r) => ({
  id: r.id, label: r.label, eventPattern: r.event_pattern, minSeverity: r.min_severity, connectionIds: JSON.parse(r.connection_ids || '[]'),
  quietStart: r.quiet_start, quietEnd: r.quiet_end, tz: r.tz, dedupeMinutes: r.dedupe_minutes, allowPersonal: Boolean(r.allow_personal), enabled: Boolean(r.enabled), createdAt: r.created_at,
});

export async function listRules(env) {
  const { results } = await env.DB.prepare('SELECT * FROM notify_rules ORDER BY created_at').all();
  return (results ?? []).map(publicRule);
}

/** @returns {Promise<{ rule?: any, errors?: string[] }>} */
export async function saveRule(env, input) {
  const errors = [];
  const label = String(input.label ?? '').trim().slice(0, 60) || 'Rule';
  const pattern = String(input.eventPattern ?? '');
  if (!/^(\*|[a-z]+\.\*|[a-z]+\.[a-z_]+)$/.test(pattern)) errors.push('The event pattern must be a type such as task.failed, a prefix such as task.*, or *.');
  const minSeverity = String(input.minSeverity ?? 'info');
  if (!(minSeverity in SEVERITY)) errors.push('The minimum severity must be info, warn, or error.');
  const tz = String(input.tz || DEFAULT_TZ);
  if (!validTimeZone(tz)) errors.push('The time zone is not valid.');
  for (const key of ['quietStart', 'quietEnd']) if (input[key] && toMinutes(input[key]) === null) errors.push(`${key === 'quietStart' ? 'The quiet start' : 'The quiet end'} must look like 22:00.`);
  const dedupe = Number.isInteger(input.dedupeMinutes) ? input.dedupeMinutes : 30;
  if (dedupe < 0 || dedupe > 1440) errors.push('The dedupe window must be 0 to 1440 minutes.');
  const ids = Array.isArray(input.connectionIds) ? input.connectionIds.map(String) : [];
  if (ids.length === 0 || ids.length > 10) errors.push('Name 1 to 10 channels.');
  for (const id of ids) {
    const c = await getConnection(env, id);
    if (!c || !isChannel(c.connectorId) || !manifestById(c.connectorId)) errors.push(`The connection ${id} is not a notification channel.`);
  }
  if (errors.length > 0) return { errors };
  const id = input.id && /^r_[0-9a-f]{8}$/.test(input.id) ? input.id : `r_${randomHex(4)}`;
  await env.DB.prepare(
    `INSERT INTO notify_rules (id, label, event_pattern, min_severity, connection_ids, quiet_start, quiet_end, tz, dedupe_minutes, allow_personal, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, event_pattern = excluded.event_pattern, min_severity = excluded.min_severity, connection_ids = excluded.connection_ids,
       quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, tz = excluded.tz, dedupe_minutes = excluded.dedupe_minutes, allow_personal = excluded.allow_personal, enabled = excluded.enabled`,
  )
    .bind(id, label, pattern, minSeverity, JSON.stringify(ids), input.quietStart || null, input.quietEnd || null, tz, dedupe, input.allowPersonal ? 1 : 0, input.enabled === false ? 0 : 1, nowIso())
    .run();
  const row = await env.DB.prepare('SELECT * FROM notify_rules WHERE id = ?').bind(id).first();
  return { rule: publicRule(row) };
}

export async function deleteRule(env, id) {
  const res = await env.DB.prepare('DELETE FROM notify_rules WHERE id = ?').bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Make the default rules for one channel: one rule for each important event type. Existing identical rules stay. */
export async function applyPreset(env, connectionId) {
  const existing = await listRules(env);
  const made = [];
  for (const type of DEFAULT_RULE_EVENTS) {
    if (existing.some((r) => r.eventPattern === type && r.connectionIds.includes(connectionId))) continue;
    const { rule, errors } = await saveRule(env, { label: type, eventPattern: type, minSeverity: 'info', connectionIds: [connectionId], dedupeMinutes: 30 });
    if (errors) return { errors };
    made.push(rule);
  }
  return { made };
}

/** The "Send test" button of a channel. */
export async function sendTest(env, connectionId, origin) {
  const connection = await getConnection(env, connectionId);
  if (!connection || !isChannel(connection.connectorId)) return { ok: false, error: 'This connection is not a notification channel.' };
  return deliver(env, connection, { id: 0, type: 'schedule.fired', severity: 'info', title: 'TITAN test notification', body: 'If you can read this, the channel works.', at: nowIso() }, origin);
}
