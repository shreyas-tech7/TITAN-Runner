/**
 * @file Schedules (Wave 12, A2), the daily brief (A3), pulse approval comments (A4, T4),
 * the activity timeline (A5, X16), and vault key rotation (X32).
 */
import { GitHubError, PERMISSIONS, githubClient } from './lib/github.js';
import { getSetting, getSettings, setSetting } from './lib/db.js';
import { decryptValue, encryptValue, vaultReady } from './lib/vault.js';
import { json, jsonError, nowIso, randomHex, readJson } from './lib/util.js';
import { invokeAction, listApprovals } from './connectors/broker.js';
import { listConnections } from './connectors/store.js';
import { runInstantChat } from './chat.js';
import { handleListKeys } from './keys.js';
import { emitEvent } from './notify.js';
import { queueTask } from './tasks.js';

const CHANNEL_CONNECTORS = new Set(['discord_webhook', 'slack_webhook', 'ntfy', 'telegram', 'webhook_out']);

// ---------------------------------------------------------------------
// 5-field cron parser with time zone support (A2)
// ---------------------------------------------------------------------

function parseField(field, min, max) {
  const allowed = new Set();
  for (const part of String(field).split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
    const rangePart = stepMatch ? stepMatch[1] : part;
    if (!Number.isInteger(step) || step < 1) return null;

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const dash = rangePart.match(/^(\d+)-(\d+)$/);
      if (dash) {
        start = Number.parseInt(dash[1], 10);
        end = Number.parseInt(dash[2], 10);
      } else if (/^\d+$/.test(rangePart)) {
        start = Number.parseInt(rangePart, 10);
        end = stepMatch ? max : start;
      } else {
        return null;
      }
    }
    if (max === 6 && start === 7) start = 0;
    if (max === 6 && end === 7) end = 6;
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) allowed.add(v === 7 && max === 6 ? 0 : v);
  }
  return allowed.size > 0 ? allowed : null;
}

export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow, domWild: parts[2] === '*', dowWild: parts[4] === '*' };
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const bag = {};
  for (const p of fmt.formatToParts(date)) bag[p.type] = p.value;
  return {
    minute: Number.parseInt(bag.minute, 10),
    hour: Number.parseInt(bag.hour, 10) % 24,
    dom: Number.parseInt(bag.day, 10),
    month: Number.parseInt(bag.month, 10),
    dow: DOW_MAP[bag.weekday] ?? 0,
  };
}

/**
 * Compute the next `count` run times for a 5-field cron expression in `tz`.
 * @param {string} cron
 * @param {string} [tz]
 * @param {Date} [from]
 * @param {number} [count]
 * @returns {string[]} ISO timestamps.
 */
export function nextCronRuns(cron, tz = 'America/Chicago', from = new Date(), count = 3) {
  const spec = parseCron(cron);
  if (!spec || !isValidTimeZone(tz)) return [];
  const out = [];
  // Start at the next whole minute after `from`.
  let cursor = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const maxSteps = 525_600; // 1 year in minutes
  for (let i = 0; i < maxSteps && out.length < count; i += 1, cursor += 60_000) {
    const d = new Date(cursor);
    const p = zonedParts(d, tz);
    if (!spec.minute.has(p.minute) || !spec.hour.has(p.hour) || !spec.month.has(p.month)) continue;
    const domMatch = spec.dom.has(p.dom);
    const dowMatch = spec.dow.has(p.dow);
    const dayOk = spec.domWild && spec.dowWild
      ? true
      : spec.domWild
        ? dowMatch
        : spec.dowWild
          ? domMatch
          : domMatch || dowMatch;
    if (dayOk) out.push(d.toISOString());
  }
  return out;
}

// ---------------------------------------------------------------------
// Daily brief (A3)
// ---------------------------------------------------------------------

export async function generateDailyBrief(env, { now = new Date(), send = false } = {}) {
  const dateStr = nowIso(now).slice(0, 10);
  const connections = await listConnections(env);

  // 1. Weather (Open-Meteo if connected)
  let weatherLine = 'Weather: Open-Meteo is not connected.';
  let weather = null; // structured value for the dashboard's DailyBriefRecord.weather
  const meteo = connections.find((c) => c.connectorId === 'open_meteo' && c.status === 'connected');
  if (meteo) {
    try {
      const lat = Number(meteo.config?.latitude ?? 41.88);
      const lon = Number(meteo.config?.longitude ?? -87.63);
      const r = await invokeAction(env, { connectionId: meteo.id, actionId: 'forecast', input: { latitude: lat, longitude: lon, days: 1 }, caller: { kind: 'admin' } });
      if (r.state === 'done' && r.data?.current) {
        weather = `${r.data.current.temperature_2m}°C, wind ${r.data.current.wind_speed_10m ?? 0} km/h (${r.data.timezone ?? 'local'})`;
        weatherLine = `Weather: ${weather}.`;
      }
    } catch {
      weatherLine = 'Weather: Open-Meteo check did not answer.';
    }
  }

  // 2. Calendar for today (if connected; stays in Worker D1 because it is personal)
  let calendarLine = 'Calendar: Google Calendar is not connected.';
  let calendar = []; // structured value for the dashboard's DailyBriefRecord.calendar
  const cal = connections.find((c) => c.connectorId === 'google_calendar' && c.status === 'connected');
  if (cal) {
    try {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 86_400_000);
      const r = await invokeAction(env, {
        connectionId: cal.id,
        actionId: 'list_events',
        input: { calendarId: 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(), maxResults: 5 },
        caller: { kind: 'admin' },
      });
      const items = r.data?.items ?? [];
      calendar = items.map((e) => e.summary || 'Busy');
      calendarLine = items.length === 0
        ? 'Calendar: No events on the primary calendar today.'
        : `Calendar: ${items.length} event(s) today (${calendar.slice(0, 3).join(', ')}).`;
    } catch {
      calendarLine = 'Calendar: Could not read today events.';
    }
  }

  // 3. Tasks and approvals
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const { results: taskCounts } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM subagents WHERE queued_at > ? GROUP BY status').bind(since).all();
  const bag = Object.fromEntries((taskCounts ?? []).map((r) => [r.status, r.n]));
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first();
  const tasksLine = `Tasks (24h): ${bag.done ?? 0} done, ${(bag.queued ?? 0) + (bag.dispatched ?? 0) + (bag.running ?? 0)} active, ${bag.failed ?? 0} failed. Approvals waiting: ${waiting?.n ?? 0}.`;

  // 4. Key states
  let keysLine = 'Keys: status not checked.';
  let keysNeedingCare = []; // structured value for the dashboard's DailyBriefRecord.keysNeedingCare
  try {
    const keysRes = await (await handleListKeys({ env, requestId: 'brief' })).json();
    const list = keysRes.providers ?? [];
    const proven = list.filter((p) => p.state === 'proven').length;
    const ok = list.filter((p) => p.state === 'provider_ok').length;
    const needsCare = list.filter((p) => p.state === 'invalid' || p.state === 'error');
    keysNeedingCare = needsCare.map((p) => p.id);
    keysLine = `Keys: ${proven} proven, ${ok} checked, ${needsCare.length} needing attention.`;
  } catch {
    // keep defaults
  }

  // 5. Latest research digest title & health line
  const latestLearning = await env.DB.prepare('SELECT topic, created_at FROM learning_paths ORDER BY id DESC LIMIT 1').first().catch(() => null);
  const researchDigest = latestLearning?.topic ? String(latestLearning.topic).slice(0, 100) : null;
  const researchLine = researchDigest
    ? `Research digest: ${researchDigest}.`
    : 'Research digest: See state/research-digest.json on the dashboard.';

  const pulseSettings = await getSettings(env, ['pulse.lastHeartbeatAt', 'pulse.lastKeeperError']);
  const hb = pulseSettings['pulse.lastHeartbeatAt'];
  const ageMin = hb ? Math.round((now.getTime() - Date.parse(hb)) / 60_000) : null;
  const healthOk = !pulseSettings['pulse.lastKeeperError'];
  const healthLine = healthOk
    ? `Health: Worker and D1 ok. Last pulse ${ageMin === null ? 'not recorded yet' : `${ageMin}m ago`}.`
    : `Health: Keeper warning (${pulseSettings['pulse.lastKeeperError']}).`;

  const baseText = [
    `TITAN daily brief for ${dateStr}`,
    `- ${weatherLine}`,
    `- ${calendarLine}`,
    `- ${tasksLine}`,
    `- ${keysLine}`,
    `- ${researchLine}`,
    `- ${healthLine}`,
  ].join('\n');

  let aiSummary = null;
  const chatAttempt = await runInstantChat(env, {
    prompt: `Write a two-sentence plain-English morning summary of this status:\n${baseText}`,
    system: 'Write in clear, short sentences. Do not use em dashes or semicolons.',
  }).catch(() => ({ ok: false }));
  if (chatAttempt?.ok && chatAttempt.text) {
    aiSummary = chatAttempt.text.trim();
  }

  // The dashboard's BriefCard (dashboard/lib/workerApi.ts's DailyBriefRecord) reads these as structured
  // fields, not the formatted text lines above — `bag`/`waiting` were already computed for `tasksLine`.
  const brief = {
    generatedAt: nowIso(now),
    date: dateStr,
    weather,
    calendar,
    tasks: {
      done: bag.done ?? 0,
      failed: bag.failed ?? 0,
      running: (bag.queued ?? 0) + (bag.dispatched ?? 0) + (bag.running ?? 0),
    },
    pendingApprovals: waiting?.n ?? 0,
    keysNeedingCare,
    researchDigest,
    healthOk,
    aiSummary,
    text: aiSummary ? `${baseText}\n\nSummary: ${aiSummary}` : baseText,
  };

  await setSetting(env, 'brief.latest', JSON.stringify(brief));

  if (send) {
    // Public notification text excludes personal calendar details unless a rule opts into allowPersonal.
    const publicBody = [weatherLine, tasksLine, keysLine, researchLine, healthLine].join('\n');
    await emitEvent(env, {
      type: 'brief.daily',
      severity: 'info',
      title: `TITAN daily brief (${dateStr})`,
      body: publicBody.slice(0, 500),
      source: 'brief',
      dedupeKey: `brief:${dateStr}`,
    });
  }

  return brief;
}

/** GET /brief */
export async function handleGetBrief(c) {
  const raw = await getSetting(c.env, 'brief.latest');
  if (raw) {
    try {
      return json({ brief: JSON.parse(raw), requestId: c.requestId });
    } catch {
      // fall through
    }
  }
  const brief = await generateDailyBrief(c.env, { send: false });
  return json({ brief, requestId: c.requestId });
}

/** POST /brief/generate */
export async function handleGenerateBrief(c) {
  const parsed = await readJson(c.request, 2048).catch(() => ({ ok: true, value: {} }));
  const send = parsed.ok && parsed.value?.send === true;
  const brief = await generateDailyBrief(c.env, { send });
  return json({ ok: true, brief, sent: send, requestId: c.requestId });
}

// ---------------------------------------------------------------------
// Schedules CRUD & tick (A2)
// ---------------------------------------------------------------------

function formatScheduleRow(row, now = new Date()) {
  const nextRuns = nextCronRuns(row.cron, row.tz || 'America/Chicago', now, 3);
  return {
    id: row.id,
    label: row.label,
    cron: row.cron,
    tz: row.tz || 'America/Chicago',
    brief: row.brief,
    taskType: row.task_type || 'general',
    kind: row.kind || 'task',
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ?? null,
    nextRunAt: row.next_run_at ?? nextRuns[0] ?? null,
    nextRuns,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Run in the 1-minute tick. Queues at most 3 due schedules. */
export async function tickSchedules(env, now = new Date()) {
  // Auto-enable the daily brief once when the first notification channel is connected (A3).
  const autoDone = await getSetting(env, 'brief.autoEnabledOnce');
  if (!autoDone) {
    const conns = await listConnections(env);
    if (conns.some((c) => CHANNEL_CONNECTORS.has(c.connectorId) && c.status === 'connected')) {
      const next = nextCronRuns('30 7 * * *', 'America/Chicago', now, 1)[0] ?? null;
      await env.DB.prepare("UPDATE schedules SET enabled = 1, next_run_at = COALESCE(next_run_at, ?), updated_at = ? WHERE id = 'sched_daily_brief'")
        .bind(next, nowIso(now))
        .run();
      await setSetting(env, 'brief.autoEnabledOnce', nowIso(now));
    }
  }

  // Ensure every enabled schedule has a next_run_at timestamp.
  const { results: unset } = await env.DB.prepare('SELECT id, cron, tz FROM schedules WHERE enabled = 1 AND next_run_at IS NULL').all();
  for (const r of unset ?? []) {
    const next = nextCronRuns(r.cron, r.tz || 'America/Chicago', now, 1)[0] ?? null;
    if (next) await env.DB.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').bind(next, r.id).run();
  }

  const { results: due } = await env.DB.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 3')
    .bind(nowIso(now))
    .all();

  const fired = [];
  for (const row of due ?? []) {
    const next = nextCronRuns(row.cron, row.tz || 'America/Chicago', now, 1)[0] ?? null;
    await env.DB.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .bind(nowIso(now), next, nowIso(now), row.id)
      .run();
    if (row.kind === 'daily_brief') {
      await generateDailyBrief(env, { now, send: true });
      fired.push({ id: row.id, kind: 'daily_brief' });
    } else {
      const taskId = await queueTask(env, { brief: row.brief, taskType: row.task_type || 'general', source: `schedule:${row.id}` });
      await emitEvent(env, {
        type: 'schedule.fired',
        severity: 'info',
        title: `Schedule fired: ${row.label}`,
        body: String(row.brief).slice(0, 200),
        source: 'schedule',
        dedupeKey: `sched:${row.id}:${nowIso(now).slice(0, 16)}`,
      });
      fired.push({ id: row.id, kind: 'task', taskId });
    }
  }
  return { fired: fired.length, items: fired };
}

/** GET /schedules */
export async function handleListSchedules(c) {
  const { results } = await c.env.DB.prepare('SELECT * FROM schedules ORDER BY created_at ASC').all();
  return json({ schedules: (results ?? []).map((r) => formatScheduleRow(r)), requestId: c.requestId });
}

/** POST /schedules */
export async function handleSaveSchedule(c) {
  const parsed = await readJson(c.request, 8192);
  if (!parsed.ok) return parsed.response;
  const v = parsed.value;
  const label = String(v.label ?? '').trim().slice(0, 80);
  const cron = String(v.cron ?? '').trim();
  const tz = String(v.tz ?? 'America/Chicago').trim();
  const brief = String(v.brief ?? '').trim().slice(0, 2000);
  const taskType = String(v.taskType ?? 'general').trim().slice(0, 40) || 'general';
  const enabled = v.enabled !== false;

  if (!label) return jsonError(422, 'invalid_fields', 'A schedule needs a label.', { requestId: c.requestId });
  if (!parseCron(cron)) return jsonError(422, 'invalid_cron', 'The cron expression must have 5 valid fields (minute hour day month weekday).', { requestId: c.requestId });
  if (!isValidTimeZone(tz)) return jsonError(422, 'invalid_tz', `The time zone "${tz}" is not valid.`, { requestId: c.requestId });
  if (!brief) return jsonError(422, 'invalid_fields', 'A schedule needs a task brief.', { requestId: c.requestId });

  const id = typeof v.id === 'string' && v.id.trim() ? v.id.trim() : `sched_${randomHex(6)}`;
  const now = nowIso();
  const next = nextCronRuns(cron, tz, new Date(), 1)[0] ?? null;

  await c.env.DB.prepare(
    `INSERT INTO schedules (id, label, cron, tz, brief, task_type, kind, enabled, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'task', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, cron = excluded.cron, tz = excluded.tz, brief = excluded.brief,
       task_type = excluded.task_type, enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
  )
    .bind(id, label, cron, tz, brief, taskType, enabled ? 1 : 0, next, now, now)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
  return json({ schedule: formatScheduleRow(row), requestId: c.requestId }, 201);
}

/** POST /schedules/:id/toggle */
export async function handleToggleSchedule(c) {
  const row = await c.env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(c.params.id).first();
  if (!row) return jsonError(404, 'not_found', 'This schedule does not exist.', { requestId: c.requestId });
  const nextEnabled = row.enabled ? 0 : 1;
  const nextRun = nextEnabled ? (nextCronRuns(row.cron, row.tz || 'America/Chicago', new Date(), 1)[0] ?? null) : null;
  await c.env.DB.prepare('UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .bind(nextEnabled, nextRun, nowIso(), row.id)
    .run();
  const updated = await c.env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(row.id).first();
  return json({ schedule: formatScheduleRow(updated), requestId: c.requestId });
}

/** POST /schedules/:id/run */
export async function handleRunScheduleNow(c) {
  const row = await c.env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(c.params.id).first();
  if (!row) return jsonError(404, 'not_found', 'This schedule does not exist.', { requestId: c.requestId });
  const now = new Date();
  const nextRun = row.enabled ? (nextCronRuns(row.cron, row.tz || 'America/Chicago', now, 1)[0] ?? null) : row.next_run_at;
  await c.env.DB.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .bind(nowIso(now), nextRun, nowIso(now), row.id)
    .run();

  if (row.kind === 'daily_brief') {
    const brief = await generateDailyBrief(c.env, { now, send: true });
    return json({ ok: true, kind: 'daily_brief', brief, requestId: c.requestId });
  }
  const taskId = await queueTask(c.env, { brief: row.brief, taskType: row.task_type || 'general', source: `schedule:${row.id}` });
  await emitEvent(c.env, {
    type: 'schedule.fired',
    severity: 'info',
    title: `Schedule ran: ${row.label}`,
    body: String(row.brief).slice(0, 200),
    source: 'schedule',
  });
  return json({ ok: true, kind: 'task', taskId, requestId: c.requestId });
}

/** DELETE /schedules/:id */
export async function handleDeleteSchedule(c) {
  if (c.params.id === 'sched_daily_brief') {
    return jsonError(400, 'builtin_schedule', 'The daily brief schedule is built in. Pause it instead of deleting it.', { requestId: c.requestId });
  }
  const res = await c.env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(c.params.id).run();
  if ((res.meta?.changes ?? 0) === 0) return jsonError(404, 'not_found', 'This schedule does not exist.', { requestId: c.requestId });
  return json({ ok: true, deleted: c.params.id, requestId: c.requestId });
}

// ---------------------------------------------------------------------
// Pulse approval comment (A4 & T4)
// ---------------------------------------------------------------------

export async function postPulseApprovalComment(env, { issueNumber, key, decision }) {
  const num = Number.parseInt(String(issueNumber ?? ''), 10);
  if (!Number.isInteger(num) || num <= 0) {
    return { ok: false, status: 400, error: 'invalid_issue', message: 'Provide a valid GitHub issue number.' };
  }
  const cleanKey = String(key ?? '').trim();
  if (!cleanKey || !/^[A-Za-z0-9:_-]{2,80}$/.test(cleanKey)) {
    return { ok: false, status: 400, error: 'invalid_key', message: 'Provide a valid approval key, such as tool:workspace_write:1a2b3c4d.' };
  }
  const verb = decision === 'deny' ? 'deny' : 'approve';
  const commentBody = `/titan ${verb} ${cleanKey}`;
  try {
    const res = await githubClient(env).commentOnIssue(num, commentBody);
    return { ok: true, status: 200, issueNumber: num, key: cleanKey, decision: verb, commentId: res?.id ?? null };
  } catch (err) {
    if (err instanceof GitHubError && err.status === 403) {
      return {
        ok: false,
        status: 403,
        error: 'pat_permission_missing',
        permission: PERMISSIONS.issuesWrite,
        message: `The GITHUB_PAT lacks the "${PERMISSIONS.issuesWrite}" permission. Edit the token on GitHub to let TITAN post /titan ${verb} comments.`,
      };
    }
    return {
      ok: false,
      status: 502,
      error: 'github_failed',
      message: err instanceof Error ? err.message : 'GitHub did not accept the comment.',
    };
  }
}

/** POST /approvals/pulse */
export async function handlePulseApproval(c) {
  const parsed = await readJson(c.request, 4096);
  if (!parsed.ok) return parsed.response;
  const out = await postPulseApprovalComment(c.env, parsed.value ?? {});
  if (!out.ok) return jsonError(out.status, out.error, out.message, { permission: out.permission, requestId: c.requestId });
  return json({ ...out, requestId: c.requestId });
}

// ---------------------------------------------------------------------
// Activity timeline (A5 & X16)
// ---------------------------------------------------------------------

/** Record a deploy event when TITAN_COMMIT changes (A5, X16). */
export async function recordDeployIfChanged(env) {
  const commit = env.TITAN_COMMIT;
  if (!commit || commit === 'unknown') return;
  const seen = await getSetting(env, 'deploy.lastCommit');
  if (seen === commit) return;
  await setSetting(env, 'deploy.lastCommit', commit);
  await env.DB.prepare(
    "INSERT INTO events (at, type, severity, title, body, source, dedupe_key, routed) VALUES (?, 'deploy.detected', 'info', ?, ?, 'deploy', ?, 1)",
  )
    .bind(nowIso(), `Worker deployed at commit ${String(commit).slice(0, 12)}`, env.TITAN_BUILD_TIME ? `Built at ${env.TITAN_BUILD_TIME}` : null, `deploy:${commit}`)
    .run()
    .catch(() => null);
}

/** GET /activity */
export async function handleActivity(c) {
  const { env, requestId } = c;
  await recordDeployIfChanged(env).catch(() => null);
  const q = new URL(c.request.url).searchParams;
  const kindFilter = q.get('kind') || '';
  const limit = Math.min(Math.max(Number.parseInt(q.get('limit') ?? '50', 10) || 50, 1), 200);

  const items = [];

  if (!kindFilter || kindFilter === 'task') {
    const { results: tasks } = await env.DB.prepare('SELECT id, task_type, brief, status, source, provider, queued_at, finished_at FROM subagents ORDER BY queued_at DESC LIMIT 40').all();
    for (const t of tasks ?? []) {
      items.push({
        id: `task:${t.id}`,
        kind: 'task',
        at: t.finished_at || t.queued_at,
        title: `Task ${String(t.id).slice(0, 8)} (${t.status}): ${String(t.brief).slice(0, 80)}`,
        detail: `Source: ${t.source}${t.provider ? ` via ${t.provider}` : ''}`,
        status: t.status,
      });
    }
  }

  if (!kindFilter || kindFilter === 'key') {
    const { results: keys } = await env.DB.prepare('SELECT id, at, action, provider, fingerprint, result FROM key_events ORDER BY id DESC LIMIT 40').all();
    for (const k of keys ?? []) {
      items.push({
        id: `key:${k.id}`,
        kind: 'key',
        at: k.at,
        title: `Key ${k.action}: ${k.provider ?? 'unknown'} (${k.result ?? 'ok'})`,
        detail: k.fingerprint ? `Fingerprint ${k.fingerprint}` : null,
        status: k.result ?? 'ok',
      });
    }
  }

  if (!kindFilter || kindFilter === 'connector') {
    const { results: calls } = await env.DB.prepare('SELECT id, at, connector_id, action_id, caller, outcome, ms FROM connector_calls ORDER BY id DESC LIMIT 40').all();
    for (const call of calls ?? []) {
      items.push({
        id: `conn:${call.id}`,
        kind: 'connector',
        at: call.at,
        title: `Connector ${call.connector_id}.${call.action_id}: ${call.outcome}`,
        detail: `Caller: ${call.caller}${call.ms != null ? ` (${call.ms} ms)` : ''}`,
        status: call.outcome,
      });
    }
  }

  if (!kindFilter || kindFilter === 'approval') {
    const approvals = await listApprovals(env);
    for (const a of approvals.slice(0, 40)) {
      items.push({
        id: `approval:${a.id}`,
        kind: 'approval',
        at: a.decidedAt || a.createdAt,
        title: `Approval ${a.status}: ${a.summary}`,
        detail: `Asked by ${a.requestedBy}`,
        status: a.status,
      });
    }
  }

  if (!kindFilter || kindFilter === 'schedule') {
    const { results: scheds } = await env.DB.prepare('SELECT id, label, last_run_at, cron FROM schedules WHERE last_run_at IS NOT NULL ORDER BY last_run_at DESC LIMIT 20').all();
    for (const s of scheds ?? []) {
      items.push({
        id: `sched:${s.id}:${s.last_run_at}`,
        kind: 'schedule',
        at: s.last_run_at,
        title: `Schedule ran: ${s.label}`,
        detail: `Cron ${s.cron}`,
        status: 'done',
      });
    }
  }

  if (!kindFilter || kindFilter === 'deploy' || kindFilter === 'event') {
    const { results: evs } = await env.DB.prepare('SELECT id, at, type, severity, title, body FROM events ORDER BY id DESC LIMIT 40').all();
    for (const e of evs ?? []) {
      const isDeploy = e.type === 'deploy.detected';
      if (kindFilter === 'deploy' && !isDeploy) continue;
      items.push({
        id: `event:${e.id}`,
        kind: isDeploy ? 'deploy' : 'event',
        at: e.at,
        title: e.title,
        detail: e.body ?? e.type,
        status: e.severity,
      });
    }
  }

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return json({ items: items.slice(0, limit), requestId });
}

// ---------------------------------------------------------------------
// Vault key rotation with re-encryption (C2 step 7 & X32)
// ---------------------------------------------------------------------

function contextForVaultRow(row, connMap) {
  if (row.scope === 'provider_key') {
    return { connectionId: `providerkey:${row.owner_id}`, connectorId: 'provider-key' };
  }
  return { connectionId: row.owner_id, connectorId: connMap.get(row.owner_id) ?? row.scope };
}

/** POST /admin/vault/rotate */
export async function handleVaultRotate(c) {
  const { env, requestId } = c;
  if (!vaultReady(env)) return jsonError(503, 'vault_not_ready', 'CONNECTOR_KEK is not set on this Worker.', { requestId });
  const { results: conns } = await env.DB.prepare('SELECT id, connector_id FROM connections').all();
  const connMap = new Map((conns ?? []).map((x) => [x.id, x.connector_id]));
  const { results: rows } = await env.DB.prepare('SELECT * FROM vault_records').all();
  let rotated = 0;
  const now = nowIso();
  for (const row of rows ?? []) {
    const ctx = contextForVaultRow(row, connMap);
    let plain = null;
    try {
      plain = await decryptValue(env, ctx, row);
    } catch {
      if (env.CONNECTOR_KEK_PREV) {
        plain = await decryptValue(env, ctx, { ...row, kek_version: 0 });
      } else {
        throw new Error(`Could not decrypt vault record ${row.id}. Set CONNECTOR_KEK_PREV if you rotated CONNECTOR_KEK.`);
      }
    }
    const sealed = await encryptValue(env, ctx, plain);
    await env.DB.prepare('UPDATE vault_records SET iv = ?, ciphertext = ?, kek_version = ?, updated_at = ? WHERE id = ?')
      .bind(sealed.iv, sealed.ciphertext, sealed.kek_version, now, row.id)
      .run();
    rotated += 1;
  }
  return json({ ok: true, rotated, total: (rows ?? []).length, requestId });
}
