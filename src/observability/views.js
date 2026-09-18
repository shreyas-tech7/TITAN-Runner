/**
 * @file Derived views — small JSON files under `state/views/` that answer
 * the questions an operator (or the dashboard) asks without reading the
 * raw state and the event log:
 *
 *   queue.json      what is in the queue and why it is (or is not) moving:
 *                   counts by status and wait reason, the next wake-up,
 *                   the oldest pending task, approvals pending, dead-letters
 *   analytics.json  outcomes and cost over the retained event window:
 *                   tasks by terminal outcome, success rate, model calls per
 *                   completed task, retries by failure class, parks, loops,
 *                   verification pass rate and judge coverage, pulse
 *                   durations (p50/p95), calls per pulse
 *   providers.json  breaker state per provider with the human `explain()` line
 *                   and today's quota use
 *
 * Views are rebuilt at the end of every pulse from the state the pulse just
 * wrote; they are never read back by the engine, so a stale or missing view
 * can never change a decision.
 */
import { readEventsDir } from './events.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VIEWS_VERSION = 1;

function percentile(xs, p) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * @param {{ tasks: object[] }} tasksFile
 * @param {{ now: () => Date }} opts
 */
export function buildQueueView(tasksFile, opts) {
  const now = opts.now();
  const tasks = tasksFile.tasks ?? [];
  const byStatus = {};
  const byWaitReason = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    if (t.status === 'waiting' && t.waitReason) byWaitReason[t.waitReason] = (byWaitReason[t.waitReason] ?? 0) + 1;
  }
  const waking = tasks.filter((t) => t.status === 'waiting' && t.wakeAt && t.waitReason !== 'approval' && t.waitReason !== 'dependency').map((t) => ({ id: t.id, wakeAt: t.wakeAt, waitReason: t.waitReason })).sort((a, b) => a.wakeAt.localeCompare(b.wakeAt));
  const pending = tasks.filter((t) => t.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const approvals = tasks.filter((t) => t.status === 'waiting' && t.waitReason === 'approval').map((t) => ({ id: t.id, title: t.title, issueNumber: t.issueNumber ?? null, since: t.wakeAt ?? t.createdAt }));
  const deadLettered = tasks.filter((t) => t.status === 'dead-lettered').map((t) => ({ id: t.id, title: t.title, code: t.failure?.code ?? null, class: t.failure?.class ?? null, at: t.completedAt ?? null }));
  return {
    version: VIEWS_VERSION,
    updatedAt: now.toISOString(),
    total: tasks.length,
    byStatus,
    byWaitReason,
    active: tasks.filter((t) => ['pending', 'running', 'waiting', 'paused'].includes(t.status)).length,
    running: tasks.filter((t) => t.status === 'running').map((t) => ({ id: t.id, title: t.title, since: t.claimedAt ?? t.startedAt ?? null, lease: t.lease?.owner ?? null })),
    nextWake: waking[0] ?? null,
    oldestPending: pending[0] ? { id: pending[0].id, title: pending[0].title, createdAt: pending[0].createdAt, ageMinutes: Math.round((now.getTime() - Date.parse(pending[0].createdAt)) / 60_000) } : null,
    approvalsPending: approvals,
    deadLettered,
  };
}

/**
 * @param {object[]} events The retained (uncompacted) events, oldest first.
 * @param {{ now: () => Date, archive?: object[] }} opts `archive`: compacted daily summaries.
 */
export function buildAnalyticsView(events, opts) {
  const now = opts.now();
  const terminal = { complete: 0, failed: 0, blocked: 0, cancelled: 0, expired: 0, 'dead-lettered': 0, 'pr-open': 0 };
  const retriesByClass = {};
  const dlqByCode = {};
  let parks = 0;
  let loops = 0;
  let toolCalls = 0;
  let toolDenied = 0;
  let verifyPass = 0;
  let verifyFail = 0;
  let unjudged = 0;
  let remediations = 0;
  let policyApprove = 0;
  let policyDeny = 0;
  const pulseDurations = [];
  const pulseCalls = [];
  const taskCalls = new Map();
  const activeMs = [];
  let modelCalls = 0;
  let upstreamCalls = 0;
  let tokens = 0;

  for (const e of events) {
    switch (e.type) {
      case 'task.transition':
        if (e.to in terminal) terminal[e.to] += 1;
        if (e.to === 'dead-lettered') dlqByCode[e.failureClass ?? 'unknown'] = (dlqByCode[e.failureClass ?? 'unknown'] ?? 0) + 1;
        if (e.to === 'waiting' && (e.waitReason === 'provider' || e.waitReason === 'quota')) parks += 1;
        break;
      case 'step.retry':
        retriesByClass[e.failureClass ?? 'unknown'] = (retriesByClass[e.failureClass ?? 'unknown'] ?? 0) + 1;
        break;
      case 'step.attempt-failed':
        if (e.code === 'LOOP_DETECTED' || e.code === 'NO_PROGRESS' || e.code === 'TOOL_LIMIT') loops += 1;
        break;
      case 'tool.call':
        toolCalls += 1;
        if (e.outcome === 'TOOL_DENIED') toolDenied += 1;
        break;
      case 'verify.finished':
        if (e.outcome === 'pass') verifyPass += 1;
        else verifyFail += 1;
        if (e.unjudged) unjudged += 1;
        break;
      case 'remediate.started':
        remediations += 1;
        break;
      case 'policy.decision':
        if (e.outcome === 'approve') policyApprove += 1;
        if (e.outcome === 'deny') policyDeny += 1;
        break;
      case 'pulse.finished':
        if (Number.isFinite(e.durationMs)) pulseDurations.push(e.durationMs);
        if (Number.isFinite(e.calls)) {
          pulseCalls.push(e.calls);
          modelCalls += e.calls;
        }
        if (Number.isFinite(e.upstreamCalls)) upstreamCalls += e.upstreamCalls;
        if (Number.isFinite(e.tokens)) tokens += e.tokens;
        break;
      case 'run.finished':
        if (e.taskId && Number.isFinite(e.calls)) taskCalls.set(e.taskId, (taskCalls.get(e.taskId) ?? 0) + e.calls);
        break;
      default:
        break;
    }
  }
  // Active time per completed task from the usage the engine records.
  for (const e of events) {
    if (e.type === 'task.transition' && e.to === 'complete' && Number.isFinite(e.activeMs)) activeMs.push(e.activeMs);
  }

  const archive = opts.archive ?? [];
  const archived = { days: archive.length, events: archive.reduce((s, a) => s + (a.events ?? 0), 0), calls: archive.reduce((s, a) => s + (a.calls ?? 0), 0) };
  const finished = terminal.complete + terminal.failed + terminal.blocked + terminal.cancelled + terminal.expired + terminal['dead-lettered'] + terminal['pr-open'];
  const succeeded = terminal.complete + terminal['pr-open'];
  const callsPerCompleted = [...taskCalls.values()];
  return {
    version: VIEWS_VERSION,
    updatedAt: now.toISOString(),
    window: { events: events.length, from: events[0]?.ts ?? null, to: events.at(-1)?.ts ?? null, archived },
    tasks: { finished, succeeded, successRate: finished > 0 ? Math.round((succeeded / finished) * 1000) / 1000 : null, byOutcome: terminal, deadLetteredByClass: dlqByCode },
    reliability: { retriesByClass, parks, loops, remediations },
    verification: { runs: verifyPass + verifyFail, passRate: verifyPass + verifyFail > 0 ? Math.round((verifyPass / (verifyPass + verifyFail)) * 1000) / 1000 : null, unjudged },
    tools: { calls: toolCalls, denied: toolDenied },
    policy: { approvalsRequested: policyApprove, denials: policyDeny },
    cost: { modelCalls, upstreamCalls, tokens, callsPerCompletedTask: callsPerCompleted.length > 0 ? Math.round((callsPerCompleted.reduce((s, n) => s + n, 0) / callsPerCompleted.length) * 10) / 10 : null, callsPerPulse: pulseCalls.length > 0 ? Math.round((modelCalls / pulseCalls.length) * 10) / 10 : null },
    pulses: { count: pulseDurations.length, p50Ms: percentile(pulseDurations, 50), p95Ms: percentile(pulseDurations, 95), maxMs: pulseDurations.length > 0 ? Math.max(...pulseDurations) : null },
  };
}

/**
 * @param {{ health: { breakerState: Function, explain: Function, get: Function }, ids: string[], quota: { snapshot: Function }|null, now: () => Date }} opts
 */
export function buildProvidersView(opts) {
  const now = opts.now();
  const quota = opts.quota?.snapshot() ?? {};
  const providers = {};
  for (const id of opts.ids) {
    const breaker = opts.health.breakerState(id);
    const rec = opts.health.get(id);
    providers[id] = {
      breaker: breaker.state, until: breaker.until, reason: breaker.reason, explain: opts.health.explain(id),
      status: rec?.status ?? 'unknown', consecutiveFailures: rec?.consecutiveFailures ?? 0, lastFailureClass: rec?.lastFailureClass ?? null,
      quota: quota[id] ? { usedMinute: quota[id].usedMinute, usedDay: quota[id].usedDay, dayLeft: quota[id].dayLeft, perDay: quota[id].perDay } : null,
    };
  }
  return { version: VIEWS_VERSION, updatedAt: now.toISOString(), providers };
}

/** Read the compacted daily summaries the event log keeps under `events/archive/`. */
export function readEventArchive(eventsDir) {
  const dir = join(eventsDir, 'archive');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Rebuild every view. Called once at the end of a pulse.
 * @param {{ store: object, tasksFile: object, health: object, providerIds: string[], quota: object|null, now: () => Date }} args
 * @returns {{ queue: object, analytics: object, providers: object }}
 */
export function writeViews(args) {
  const queue = buildQueueView(args.tasksFile, { now: args.now });
  const events = readEventsDir(args.store.eventsDir);
  const analytics = buildAnalyticsView(events, { now: args.now, archive: readEventArchive(args.store.eventsDir) });
  const providers = buildProvidersView({ health: args.health, ids: args.providerIds, quota: args.quota, now: args.now });
  args.store.writeView('queue.json', queue);
  args.store.writeView('analytics.json', analytics);
  args.store.writeView('providers.json', providers);
  return { queue, analytics, providers };
}

export default { buildQueueView, buildAnalyticsView, buildProvidersView, readEventArchive, writeViews, VIEWS_VERSION };
