/**
 * @file The pulse keeper (Wave 12, R1).
 *
 * GitHub runs a `schedule` workflow when it has room, not when the cron says. The live pulse ran about every 5 hours
 * and not every 15 minutes. The Worker has a reliable 1-minute cron, so it keeps the pulse alive: when the last heartbeat
 * is older than 15 minutes, and the last dispatch is older than 14 minutes, the tick fires a `titan-pulse` dispatch. The
 * workflow keeps its concurrency group, so two pulses never run at once. The cron stays as a backup.
 */
import { getSettings, setSetting } from './lib/db.js';
import { githubClient } from './lib/github.js';
import { json, nowIso } from './lib/util.js';
import { emitEvent } from './notify.js';

export const HEARTBEAT_STALE_MS = 15 * 60_000;
export const DISPATCH_GAP_MS = 14 * 60_000;
export const FAILURE_COOLDOWN_MS = 5 * 60_000;

const KEYS = ['pulse.lastHeartbeatAt', 'pulse.lastDispatchAt', 'pulse.lastAttemptAt', 'pulse.lastKeeperError', 'pulse.lastPulseId', 'pulse.lastPulseStatus'];

/**
 * The keeper rule as a pure function.
 * @param {{ now: Date, lastHeartbeatAt: string|null, lastDispatchAt: string|null, lastAttemptAt?: string|null }} s
 * @returns {{ fire: boolean, reason: string }}
 */
export function keeperDecision({ now, lastHeartbeatAt, lastDispatchAt, lastAttemptAt = null }) {
  const t = now.getTime();
  const hb = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Number.NEGATIVE_INFINITY;
  if (t - hb <= HEARTBEAT_STALE_MS) return { fire: false, reason: 'The heartbeat is fresh.' };
  const dispatch = lastDispatchAt ? Date.parse(lastDispatchAt) : Number.NEGATIVE_INFINITY;
  if (t - dispatch <= DISPATCH_GAP_MS) return { fire: false, reason: 'A dispatch went out less than 14 minutes ago.' };
  const attempt = lastAttemptAt ? Date.parse(lastAttemptAt) : Number.NEGATIVE_INFINITY;
  if (t - attempt <= FAILURE_COOLDOWN_MS) return { fire: false, reason: 'The last dispatch failed less than 5 minutes ago.' };
  return { fire: true, reason: 'The heartbeat is older than 15 minutes.' };
}

/** The pulse time from `state/heartbeat.json` on main. It backs up a heartbeat call that failed. */
async function rawHeartbeatAt(env) {
  try {
    const text = await githubClient(env).rawFile('state/heartbeat.json');
    const at = JSON.parse(text)?.lastPulseAt;
    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}

/** The upkeep step of the 1-minute tick. */
export async function tickKeeper(env, now = new Date()) {
  if (!env.GITHUB_PAT) return { action: 'skip', reason: 'no_pat' };
  const s = await getSettings(env, KEYS);
  let lastHeartbeatAt = s['pulse.lastHeartbeatAt'];
  const early = keeperDecision({ now, lastHeartbeatAt, lastDispatchAt: s['pulse.lastDispatchAt'], lastAttemptAt: s['pulse.lastAttemptAt'] });
  if (!early.fire) return { action: 'quiet', reason: early.reason };

  // The heartbeat call may be broken while pulses still run. Look at the committed state before a dispatch.
  const raw = await rawHeartbeatAt(env);
  if (raw && (!lastHeartbeatAt || Date.parse(raw) > Date.parse(lastHeartbeatAt))) lastHeartbeatAt = raw;
  const decision = keeperDecision({ now, lastHeartbeatAt, lastDispatchAt: s['pulse.lastDispatchAt'], lastAttemptAt: s['pulse.lastAttemptAt'] });
  if (!decision.fire) return { action: 'quiet', reason: decision.reason };

  try {
    await githubClient(env).dispatch('titan-pulse', { source: 'keeper' });
    await setSetting(env, 'pulse.lastDispatchAt', nowIso(now), now);
    await setSetting(env, 'pulse.lastKeeperError', '', now);
    return { action: 'fired', reason: decision.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dispatch failed';
    await setSetting(env, 'pulse.lastAttemptAt', nowIso(now), now);
    await setSetting(env, 'pulse.lastKeeperError', message.slice(0, 300), now);
    await emitEvent(env, { type: 'pulse.late', severity: 'error', title: 'The pulse keeper could not start a pulse', body: message.slice(0, 200), dedupeKey: 'keeper-failed' }, now).catch(() => null);
    return { action: 'failed', reason: message };
  }
}

/** POST /internal/pulse-heartbeat: the pulse calls this at its end. The Worker uses its own clock. */
export async function handlePulseHeartbeat(c) {
  const body = await c.request.json().catch(() => ({}));
  const now = new Date();
  await setSetting(c.env, 'pulse.lastHeartbeatAt', nowIso(now), now);
  if (typeof body?.pulseId === 'string') await setSetting(c.env, 'pulse.lastPulseId', body.pulseId.slice(0, 80), now);
  if (typeof body?.status === 'string') await setSetting(c.env, 'pulse.lastPulseStatus', body.status.slice(0, 40), now);
  return json({ ok: true });
}

/** POST /admin/pulse/run: the same dispatch that the keeper uses, for a person (backlog X3). */
export async function handleRunPulseNow(c) {
  if (!c.env.GITHUB_PAT) return json({ error: 'pat_missing', message: 'GITHUB_PAT is not configured on this Worker yet.' }, 503);
  try {
    await githubClient(c.env).dispatch('titan-pulse', { source: 'dashboard' });
    await setSetting(c.env, 'pulse.lastDispatchAt', nowIso());
    return json({ ok: true, requestId: c.requestId });
  } catch (err) {
    return json({ error: 'dispatch_failed', message: err instanceof Error ? err.message : 'dispatch failed', requestId: c.requestId }, 502);
  }
}

/** GET /admin/pulse: the keeper state for the dashboard banner. */
export async function handlePulseState(c) {
  const s = await getSettings(c.env, KEYS);
  const now = Date.now();
  const hb = s['pulse.lastHeartbeatAt'];
  const dispatch = s['pulse.lastDispatchAt'];
  return json({
    lastHeartbeatAt: hb,
    heartbeatAgeMinutes: hb ? Math.round((now - Date.parse(hb)) / 60_000) : null,
    lastDispatchAt: dispatch,
    keeperError: s['pulse.lastKeeperError'] || null,
    keeperHealthy: !s['pulse.lastKeeperError'],
    lastPulseId: s['pulse.lastPulseId'],
    lastPulseStatus: s['pulse.lastPulseStatus'],
    requestId: c.requestId,
  });
}

/** GET /badge/pulse: the shields.io endpoint format. It shows "up" or "late" and the age. Nothing else (V2). */
export async function handlePulseBadge(env) {
  const s = await getSettings(env, ['pulse.lastHeartbeatAt']);
  let at = s['pulse.lastHeartbeatAt'];
  if (!at && env.GITHUB_OWNER) at = await rawHeartbeatAt(env);
  const age = at ? Math.round((Date.now() - Date.parse(at)) / 60_000) : null;
  const up = age !== null && age <= 30;
  return json({ schemaVersion: 1, label: 'pulse', message: age === null ? 'late' : `${up ? 'up' : 'late'} ${age}m`, color: up ? 'brightgreen' : 'orange', cacheSeconds: 120 }, 200, { 'Cache-Control': 'public, max-age=120' });
}
