/**
 * @file D1 retention (Wave 12, R4) and data export and delete (R6). The numbers are in docs/CONFIG.md.
 */
import { pruneAuthFailures } from './lib/auth.js';
import { pruneLoginLimits } from './lib/loginGuard.js';
import { pruneRateLimits } from './lib/rateLimit.js';
import { pruneSessions } from './lib/sessions.js';
import { pruneSignins } from './lib/signinLog.js';
import { pruneOps } from './ops.js';
import { getSetting } from './lib/db.js';
import { json, jsonError, nowIso, readJson } from './lib/util.js';
import { emitEvent } from './notify.js';

export const RETENTION_DAYS = Object.freeze({
  connector_calls: 30,
  auth_failures: 1,
  key_events: 365,
  events: 30,
  chat_default: 30,
  subagents_done: 90,
  subagents_failed: 180,
  callback_pings: 30,
  approvals: 30,
  hook_events: 7,
  notify_deliveries: 30,
  signin_log: 90,
  unused_mcp_clients: 7,
});

const day = 24 * 3600_000;

async function tryRun(env, label, sql, args, out) {
  try {
    const res = await env.DB.prepare(sql).bind(...args).run();
    out[label] = res.meta?.changes ?? 0;
  } catch (err) {
    // A table from a later release may not exist yet. That is not an error.
    out[label] = /no such table/i.test(err instanceof Error ? err.message : '') ? 'no table' : 'error';
  }
}

/** Run in the 6-hour cron. @returns {Promise<Record<string, number|string>>} How many rows each rule removed. */
export async function pruneOldRows(env, now = new Date()) {
  const out = {};
  const iso = (days) => nowIso(new Date(now.getTime() - days * day));
  const chatDaysRaw = Number.parseInt((await getSetting(env, 'retention.chatDays').catch(() => null)) ?? '', 10);
  const chatDays = Number.isFinite(chatDaysRaw) && chatDaysRaw > 0 ? chatDaysRaw : RETENTION_DAYS.chat_default;

  try {
    out.auth_failures = await pruneAuthFailures(env, now);
  } catch {
    out.auth_failures = 'error';
  }
  // RT5: sessions, the sign-in log, and the limiter tables.
  for (const [label, fn] of [
    ['sessions', () => pruneSessions(env, now)],
    ['signin_log', () => pruneSignins(env, now, RETENTION_DAYS.signin_log)],
    ['login_limits', () => pruneLoginLimits(env, now)],
    ['rate_limits', () => pruneRateLimits(env, now)],
  ]) {
    try {
      out[label] = await fn();
    } catch (err) {
      out[label] = /no such table/i.test(err instanceof Error ? err.message : '') ? 'no table' : 'error';
    }
  }
  try {
    Object.assign(out, Object.fromEntries(Object.entries(await pruneOps(env, now)).map(([k, v]) => [`ops_${k}`, v])));
  } catch (err) {
    out.ops = /no such table/i.test(err instanceof Error ? err.message : '') ? 'no table' : 'error';
  }
  await tryRun(env, 'unused_mcp_clients', 'DELETE FROM mcp_oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM mcp_tokens WHERE client_id IS NOT NULL)', [iso(RETENTION_DAYS.unused_mcp_clients)], out);
  await tryRun(env, 'connector_calls', 'DELETE FROM connector_calls WHERE at < ?', [iso(RETENTION_DAYS.connector_calls)], out);
  await tryRun(env, 'hook_events', 'DELETE FROM hook_events WHERE at < ?', [iso(RETENTION_DAYS.hook_events)], out);
  await tryRun(env, 'hook_nonces', 'DELETE FROM hook_nonces WHERE at < ?', [nowIso(new Date(now.getTime() - 20 * 60_000))], out);
  await tryRun(env, 'connector_rate', 'DELETE FROM connector_rate WHERE window_start < ?', [Math.floor(now.getTime() / 60_000) - 120], out);
  await tryRun(env, 'approvals', "DELETE FROM approvals WHERE status != 'pending' AND created_at < ?", [iso(RETENTION_DAYS.approvals)], out);
  await tryRun(env, 'notify_deliveries', 'DELETE FROM notify_deliveries WHERE at < ?', [iso(RETENTION_DAYS.notify_deliveries)], out);
  await tryRun(env, 'oauth_states', 'DELETE FROM oauth_states WHERE expires_at < ?', [nowIso(now)], out);
  await tryRun(env, 'mcp_oauth_codes', 'DELETE FROM mcp_oauth_codes WHERE expires_at < ?', [nowIso(now)], out);
  await tryRun(env, 'chat_messages', 'DELETE FROM chat_messages WHERE at < ?', [iso(chatDays)], out);
  await tryRun(env, 'chat_threads', 'DELETE FROM chat_threads WHERE updated_at < ?', [iso(chatDays)], out);
  await tryRun(env, 'key_events', 'DELETE FROM key_events WHERE at < ?', [iso(RETENTION_DAYS.key_events)], out);
  await tryRun(env, 'events', 'DELETE FROM events WHERE at < ?', [iso(RETENTION_DAYS.events)], out);
  await tryRun(env, 'callback_pings', 'DELETE FROM callback_pings WHERE requested_at < ?', [iso(RETENTION_DAYS.callback_pings)], out);
  await tryRun(env, 'subagents_done', "DELETE FROM subagents WHERE status = 'done' AND COALESCE(finished_at, queued_at) < ?", [iso(RETENTION_DAYS.subagents_done)], out);
  await tryRun(env, 'subagents_failed', "DELETE FROM subagents WHERE status = 'failed' AND COALESCE(finished_at, queued_at) < ?", [iso(RETENTION_DAYS.subagents_failed)], out);
  await tryRun(env, 'revoked_tokens', "DELETE FROM worker_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?", [iso(30)], out);

  // X11: warn when a provider key is older than 90 days.
  try {
    const { results: staleKeys } = await env.DB.prepare('SELECT provider, saved_at FROM provider_keys WHERE saved_at IS NOT NULL AND saved_at < ?').bind(iso(90)).all();
    for (const k of staleKeys ?? []) {
      await emitEvent(
        env,
        {
          type: 'notify.custom',
          severity: 'warn',
          title: `Provider key for ${k.provider} is over 90 days old`,
          body: `Saved at ${k.saved_at}. Consider testing or rotating it on /keys.`,
          source: 'retention',
          dedupeKey: `stale-key:${k.provider}:${nowIso(now).slice(0, 10)}`,
        },
        now,
      );
    }
  } catch {
    // ignore if table not present
  }

  return out;
}

// ---------------------------------------------------------------------
// Export and delete (R6)
// ---------------------------------------------------------------------

/** Tables that never leave the Worker in an export: encrypted records, token hashes, and OAuth state. */
const EXPORT_SKIP_TABLES = new Set(['vault_records', 'worker_tokens', 'mcp_tokens', 'mcp_oauth_codes', 'mcp_oauth_clients', 'oauth_states', 'hook_nonces', 'approvals', 'auth_failures', 'd1_migrations', 'sqlite_sequence', '_cf_KV']);
const SENSITIVE_COLUMN = /hash|secret|ciphertext|^iv$|token/i;
const ROWS_PER_TABLE = 5000;

/** GET /admin/export: every table as JSON (or audit events as CSV when ?format=csv, X22), without vault data and without token hashes. */
export async function handleExport(c) {
  const { env, request } = c;
  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  if (format === 'csv') {
    const { results: keyEvents } = await env.DB.prepare('SELECT id, at, provider, action, source, result, http_status, fingerprint, message FROM key_events ORDER BY id DESC LIMIT 2000').all();
    const { results: events } = await env.DB.prepare('SELECT id, at, type, severity, title, source FROM events ORDER BY id DESC LIMIT 2000').all();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['kind,id,at,type_or_action,subject,status_or_severity,detail'];
    for (const k of keyEvents ?? []) {
      lines.push(['key_event', k.id, k.at, k.action, k.provider, k.result, k.message ?? k.fingerprint ?? ''].map(esc).join(','));
    }
    for (const e of events ?? []) {
      lines.push(['event', e.id, e.at, e.type, e.source ?? '', e.severity, e.title].map(esc).join(','));
    }
    return new Response(`${lines.join('\n')}\n`, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="titan-audit.csv"',
      },
    });
  }
  const { results: tables } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const out = {};
  const skipped = [];
  for (const { name } of tables ?? []) {
    if (EXPORT_SKIP_TABLES.has(name) || name.startsWith('sqlite_') || name.startsWith('_cf_')) {
      skipped.push(name);
      continue;
    }
    const { results } = await env.DB.prepare(`SELECT * FROM "${name.replace(/"/g, '')}" LIMIT ${ROWS_PER_TABLE}`).all();
    out[name] = (results ?? []).map((row) => Object.fromEntries(Object.entries(row).filter(([col]) => !SENSITIVE_COLUMN.test(col))));
  }
  return json({ exportedAt: nowIso(), service: 'titan-runner-brain', skippedTables: skipped, tables: out, requestId: c.requestId }, 200, {
    'Content-Disposition': 'attachment; filename="titan-export.json"',
  });
}

const AREAS = Object.freeze({
  chat: ['chat_messages', 'chat_threads'],
  calls: ['connector_calls'],
  audit: ['key_events', 'events'],
});

/** POST /admin/delete-area: delete chat history, call logs, or audit events after a typed confirm. */
export async function handleDeleteArea(c) {
  const parsed = await readJson(c.request, 2048);
  if (!parsed.ok) return parsed.response;
  const area = String(parsed.value.area ?? '');
  const tables = AREAS[area];
  if (!tables) return jsonError(400, 'unknown_area', `The area must be one of: ${Object.keys(AREAS).join(', ')}.`);
  if (parsed.value.confirm !== `delete ${area}`) return jsonError(400, 'confirm_required', `Send {"confirm": "delete ${area}"} to delete this area.`);
  const deleted = {};
  for (const table of tables) {
    try {
      const res = await c.env.DB.prepare(`DELETE FROM ${table}`).run();
      deleted[table] = res.meta?.changes ?? 0;
    } catch {
      deleted[table] = 'no table';
    }
  }
  return json({ ok: true, area, deleted, requestId: c.requestId });
}
