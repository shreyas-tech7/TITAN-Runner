/**
 * @file The pulse engine — `runPulse(deps)` is one whole pulse as a
 * function of its dependencies (GitHub client, agent pools, reviewer model,
 * clock, state directory), with defaults that reproduce the workflow's
 * behaviour. `src/pulse.js` is the thin CLI wrapper around it.
 *
 * One pulse, in order:
 *
 *   1. open the state store, the event log, the lease manager, the budget,
 *      the checkpointer; `pulse.started`
 *   2. read `control.json` — a kill switch means reconcile, heartbeat, exit
 *   3. reconcile: reclaim zombies, wake waiters, expire, drop orphans
 *   4. intake: issues → tasks (authorized only, idempotency keys),
 *      manual task, issue controls (cancel-by-close, `/titan …`)
 *   5. revisit self-improve PRs
 *   6. claim: runnable tasks by effective priority, dependencies satisfied,
 *      lease acquired (O_EXCL), `running`, checkpoint
 *   7. per task: reviewer gate (recorded in the checkpoint, so a resume never
 *      re-asks), plan → execute → synthesize with checkpoints at every step,
 *      drain to `waiting(pulse-budget)` when the budget runs out, deliver
 *      through the idempotent side-effect ledger, terminal transition
 *   8. retention (runs, events, tasks), heartbeat, pulse history,
 *      `pulse.finished`, final forced checkpoint
 *
 * Every state write goes through `state/store.js`; every status change
 * through `task/lifecycle.js`; every side effect through
 * `engine/sideEffects.js`. Nothing here talks to git unless
 * `TITAN_CHECKPOINT=git` (the workflow's setting).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { config, isProviderConfigured } from '../config.js';
import { StateStore } from '../state/store.js';
import { resolveStateDir } from '../state/paths.js';
import { EventLog } from '../observability/events.js';
import { LeaseManager } from '../task/leases.js';
import { reconcile } from '../task/reconcile.js';
import { transition, isTerminal, effectivePriority } from '../task/lifecycle.js';
import { PulseBudget } from './pulseBudget.js';
import { Checkpointer, checkpointModeFromEnv } from './checkpointer.js';
import { SideEffectLedger } from './sideEffects.js';
import { runOrchestration, newCheckpoint } from './orchestrate.js';

import { syncIssuesIntoTasks, reconcileIssueState, addManualTask } from '../issueSync.js';
import { defaultGitHubClient } from '../github.js';
import { proposeSelfImprovement, checkSelfImprovePrStatus } from '../selfImprove.js';
import { reviewAction } from '../reviewer/reviewer.js';
import { capabilityRegistry } from '../orchestrator/capabilityRegistry.js';
import { FreebuffAgent } from '../agents/freebuffAgent.js';
import { OpenCodeAgent } from '../agents/opencodeAgent.js';
import { Phase2Agent } from '../agents/phase2Agent.js';
import { providerHealth } from '../providers/health.js';
import { pruneRuns } from '../state/prune.js';
import { writeJsonAtomic, appendPulseHistory } from '../state/io.js';
import { scrubForState } from '../lib/secretScrub.js';
import { redactString } from '../lib/redact.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('pulse');

const MAX_FILE_PREVIEW_CHARS = 4000;
const MAX_RUN_FILE_CHARS = 6000;

function defaultPools() {
  return { freebuff: new FreebuffAgent(), opencode: new OpenCodeAgent(), phase2: new Phase2Agent() };
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The exact Actions run this pulse executed under — `null` locally. */
function actionsRunUrl() {
  if (!config.github.runId || !config.github.repository) return null;
  return `https://github.com/${config.github.repository}/actions/runs/${config.github.runId}`;
}

function writeRunRecord(store, task, result, durationMs, now) {
  const record = scrubForState({
    runId: result.runId,
    taskId: task.id,
    taskTitle: task.title,
    issueUrl: task.issueUrl,
    createdAt: now().toISOString(),
    durationMs,
    state: result.ok ? 'complete' : 'failed',
    actionsRunUrl: actionsRunUrl(),
    sharedContext: String(result.graph.sharedContext ?? '').slice(0, MAX_RUN_FILE_CHARS),
    tasks: [...result.tasksById.values()].map((t) => ({
      id: t.id,
      title: t.title,
      aspect: t.aspect,
      state: t.state,
      assignment: t.assignment,
      attempts: (t.attempts ?? []).map((a) => ({ modelId: a.modelId, pool: a.pool, ok: a.ok, ms: a.ms, tokensUsed: a.tokensUsed ?? null })),
      outputPreview: typeof t.output === 'string' ? t.output.slice(0, MAX_FILE_PREVIEW_CHARS) : null,
      error: t.error,
    })),
    files: result.synthesis.files.map((f) => ({ path: f.path, sourceTaskId: f.sourceTaskId, conflict: f.conflict })),
    markdownSummary: String(result.synthesis.markdownSummary ?? '').slice(0, MAX_RUN_FILE_CHARS),
  });
  const path = join(store.paths.runs, `${result.runId}.json`);
  writeJsonAtomic(path, record);
  store.written.add(path);
}

function issueCommentFor(result) {
  const lines = [
    result.ok ? 'TITAN-Runner finished this task.' : 'TITAN-Runner finished this task, but one or more subtasks failed.',
    '',
    result.synthesis.markdownSummary.slice(0, 60000),
  ];
  if (result.synthesis.files.length > 0) {
    lines.push('', '<details><summary>Files produced</summary>', '');
    for (const f of result.synthesis.files) {
      lines.push(`**\`${f.path}\`**`, '```', f.content.slice(0, 3000), '```', '');
    }
    lines.push('</details>');
  }
  lines.push('', '---', '_Generated by [TITAN-Runner](../../README.md), an automated pulse._');
  return lines.join('\n');
}

/** Every provider id this repo knows about, registry-backed or agent-pool-backed. */
const ALL_PROVIDER_IDS = ['groq', 'together', 'openrouter', 'gemini', 'huggingface', 'freebuff', 'opencode'];

function primeProviderHealth() {
  for (const id of ALL_PROVIDER_IDS) {
    if (id === 'freebuff') {
      providerHealth.markNoPublicApi('freebuff', 'Freebuff has no official public HTTP API for third-party integration.');
      continue;
    }
    if (isProviderConfigured(id)) providerHealth.markConfigured(id);
    else providerHealth.markNotConfigured(id);
  }
}

/**
 * @typedef {object} PulseDeps
 * @property {ReturnType<import('../github.js').createGitHubClient>} [github]
 * @property {() => Record<string, object>} [poolsFactory]
 * @property {Record<string, object>} [pools]
 * @property {Function} [reviewerChat]
 * @property {() => Date} [now]
 * @property {string} [manualTask]
 * @property {boolean} [dryRun]
 * @property {string} [stateDir]
 * @property {string} [pulseId]
 * @property {number} [budgetMs]
 * @property {number} [leaseTtlMs]
 * @property {'none'|'git'} [checkpointMode]
 * @property {(event: object) => void} [onEvent]
 * @property {boolean} [echoEvents]
 */

/**
 * @param {PulseDeps} [deps]
 * @returns {Promise<object>} The summary the CLI prints.
 */
export async function runPulse(deps = {}) {
  const now = deps.now ?? (() => new Date());
  const github = deps.github ?? defaultGitHubClient;
  const dryRun = deps.dryRun ?? config.dryRun;
  const manualTask = deps.manualTask ?? process.env.TITAN_MANUAL_TASK ?? '';
  const stateDir = resolveStateDir(deps.stateDir);
  // The lease owner id. Includes a per-process nonce so two processes that
  // happen to share a run id (a local overlap, a harness) can never mistake
  // each other's lease for their own re-entrant one.
  const pulseId = deps.pulseId ?? (config.github.runId ? `run-${config.github.runId}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}-${randomUUID().slice(0, 6)}` : `local-${randomUUID().slice(0, 8)}`);
  const pulseStartedAt = Date.now();

  const events = new EventLog({ dir: join(stateDir, 'events'), pulseId, now, retentionDays: positiveInt(process.env.TITAN_EVENTS_RETENTION_DAYS, 14), echo: deps.echoEvents ?? process.env.TITAN_ECHO_EVENTS === '1' });
  if (deps.onEvent) events.subscribe(deps.onEvent);
  const store = new StateStore({ stateDir, now, events });
  store.ensureLayout();
  // The shared provider-health and capability stores must live in the same
  // directory the pulse saves to — a no-op in production, essential when a
  // test or the harness hands in a scratch state dir.
  providerHealth.usePath(store.paths.providers);
  capabilityRegistry.usePath(store.paths.agents);
  const leases = new LeaseManager({ dir: store.leasesDir, owner: pulseId, ttlMs: deps.leaseTtlMs ?? positiveInt(process.env.TITAN_LEASE_TTL_MS, 5 * 60_000), now });
  const budget = new PulseBudget({ budgetMs: deps.budgetMs ?? positiveInt(process.env.TITAN_PULSE_BUDGET_MS, 7 * 60_000) });
  const checkpointer = new Checkpointer({ mode: deps.checkpointMode ?? checkpointModeFromEnv(), stateDir, events });
  const maxAttempts = positiveInt(process.env.TITAN_TASK_MAX_ATTEMPTS, 3);

  const ctx = {
    github, now, events, store, leases, budget, checkpointer, pulseId,
    pools: deps.pools ?? null,
    poolsFactory: deps.poolsFactory ?? defaultPools,
    reviewerOpts: { ...(deps.reviewerChat ? { chatFn: deps.reviewerChat } : {}), reviewsDir: store.paths.reviews },
  };

  primeProviderHealth();
  const control = store.loadControl();
  const heartbeat = store.loadHeartbeat();
  const tasksFile = store.loadTasks();
  const loadedSnapshot = JSON.stringify(tasksFile.tasks);
  ctx.loadedSnapshot = loadedSnapshot;

  events.append('pulse.started', { budgetMs: budget.budgetMs, tasks: tasksFile.tasks.length, killSwitch: control.killSwitch, drain: control.drain, autonomy: control.autonomy, repairs: store.repairs.length });

  const counts = { claimed: 0, completed: 0, failed: 0, parked: 0, skippedLeased: 0 };
  /** Tasks this pulse leased — their version wins in any merge on save. */
  const owned = new Set();
  ctx.owned = owned;
  let pulseError = null;
  let reconcileCounts = null;

  try {
    reconcileCounts = reconcile(tasksFile, { leases, store, events, now });
    if (Object.values(reconcileCounts).some((v) => v > 0)) events.append('reconcile.finished', { ...reconcileCounts });

    if (control.killSwitch) {
      events.append('pulse.halted', { reason: 'kill switch', by: control.updatedBy ?? null, outcome: 'no-work', audit: true });
      log.warn('kill switch is on — reconciled state, claiming nothing', { by: control.updatedBy, reason: control.reason });
    } else {
      if (!dryRun) {
        const intake = await syncIssuesIntoTasks(tasksFile, { listIssues: github.listOpenTaskIssues.bind(github), now, events, maxAttempts });
        if (intake.added > 0) log.info('synced issues into task queue', { added: intake.added });
        if (intake.ignored > 0) log.info('ignored issues from unauthorized authors', { ignored: intake.ignored });
        for (const dupId of intake.duplicates) {
          const dup = tasksFile.tasks.find((t) => t.id === dupId);
          if (dup?.issueNumber) {
            const ledger = new SideEffectLedger({ github, ledger: {}, events, now, taskId: dup.id });
            await ledger.comment(dup.issueNumber, `dup:${dup.id}`, `TITAN-Runner did not run this task: it is a duplicate of ${dup.duplicateOf}${dup.error ? '' : '.'}\n\n${dup.error ?? ''}`);
          }
        }
        const controls = await reconcileIssueState(tasksFile, intake.issues, { listComments: github.listIssueComments.bind(github), now, events });
        if (controls.cancelled > 0) log.info('cancelled tasks whose issue was closed', { cancelled: controls.cancelled });
        if (controls.commands > 0) log.info('applied authorized control commands', { commands: controls.commands, retried: controls.retried });
      }

      if (manualTask && manualTask.trim().length > 0) {
        const id = addManualTask(tasksFile, manualTask.trim(), { now, events, maxAttempts });
        log.info('added manual task from workflow_dispatch input', { id });
      }

      for (const task of tasksFile.tasks.filter((t) => t.status === 'pr-open')) {
        await revisitSelfImprovePr(task, ctx);
      }

      if (!control.drain) {
        await claimAndRun(tasksFile, ctx, counts, control);
      } else {
        events.append('pulse.draining', { reason: control.reason ?? 'drain control is on', outcome: 'no-claims', audit: true });
      }
    }

    capabilityRegistry.list();
    capabilityRegistry.save();
    providerHealth.save();
    for (const pool of Object.values(ctx.pools ?? {})) {
      if (typeof pool.flush === 'function') pool.flush();
    }

    const pruneResult = pruneRuns({ maxFiles: config.retention.maxRunFiles, runsDir: store.paths.runs, digestsDir: store.paths.digests });
    if (pruneResult.prunedCount > 0) log.info('pruned old run records into a digest', pruneResult);
    const archived = store.archiveOldTasks(tasksFile, { maxAgeDays: positiveInt(process.env.TITAN_TASK_RETENTION_DAYS, 30) });
    if (archived > 0) events.append('retention.tasks-archived', { count: archived });
    const compacted = events.compact();
    if (compacted.compacted > 0) events.append('retention.events-compacted', { count: compacted.compacted });
  } catch (err) {
    pulseError = redactString(err instanceof Error ? err.message : String(err));
    log.error('pulse failed', { error: pulseError, stack: err instanceof Error ? redactString(String(err.stack)).slice(0, 1500) : undefined });
    events.append('pulse.error', { outcome: 'error', error: pulseError });
  }

  const durationMs = Date.now() - pulseStartedAt;
  const finishedAt = now().toISOString();
  try {
    store.saveTasks(tasksFile, { loadedSnapshot, ownedIds: owned });
  } catch (err) {
    pulseError = pulseError ?? redactString(String(err));
    log.error('saving tasks failed', { error: String(err) });
  }
  store.saveHeartbeat({
    version: 1,
    lastPulseAt: finishedAt,
    lastPulseStatus: pulseError ? 'error' : 'ok',
    lastPulseDurationMs: durationMs,
    lastPulseTasksClaimed: counts.claimed,
    lastPulseTasksCompleted: counts.completed,
    lastPulseTasksFailed: counts.failed,
    lastPulseError: pulseError,
    consecutivePulseFailures: pulseError ? (heartbeat.consecutivePulseFailures ?? 0) + 1 : 0,
    totalPulses: (heartbeat.totalPulses ?? 0) + 1,
    cadenceMinutes: heartbeat.cadenceMinutes ?? 15,
    pulseId,
    budget: budget.snapshot(),
  });
  appendPulseHistory({ at: finishedAt, durationMs, status: pulseError ? 'error' : 'ok', tasksClaimed: counts.claimed, tasksCompleted: counts.completed, tasksFailed: counts.failed }, store.paths.pulseHistory);
  store.written.add(store.paths.pulseHistory);

  events.append('pulse.finished', { durationMs, outcome: pulseError ? 'error' : 'ok', ...counts, budget: budget.snapshot(), reconcile: reconcileCounts, checkpoint: checkpointer.summary() });
  await checkpointer.checkpoint('pulse-end', { force: true });

  return {
    pulse: 'complete',
    pulseId,
    durationMs,
    tasksClaimed: counts.claimed,
    tasksCompleted: counts.completed,
    tasksFailed: counts.failed,
    tasksParked: counts.parked,
    dryRun,
    error: pulseError,
    budget: budget.snapshot(),
    checkpoint: checkpointer.summary(),
  };
}

/* -------------------------------------------------------------------------- */
/* Claiming                                                                    */
/* -------------------------------------------------------------------------- */

function dependencyState(task, byId) {
  const deps = (task.dependsOn ?? []).map((id) => byId.get(id));
  if (deps.some((d) => !d)) return 'missing';
  if (deps.some((d) => isTerminal(d.status) && d.status !== 'complete')) return 'failed';
  if (deps.every((d) => d.status === 'complete')) return 'ready';
  return 'waiting';
}

async function claimAndRun(tasksFile, ctx, counts, control) {
  const { now, events, leases, budget, store } = ctx;
  const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
  const dependents = new Map();
  for (const t of tasksFile.tasks) for (const d of t.dependsOn ?? []) dependents.set(d, (dependents.get(d) ?? 0) + 1);

  const runnable = tasksFile.tasks
    .filter((t) => t.status === 'pending')
    .map((t) => ({ task: t, score: effectivePriority(t, { now, dependents: dependents.get(t.id) ?? 0 }) }))
    .sort((a, b) => b.score - a.score);

  const maxTasks = config.orchestrator.maxTasksPerPulse;
  for (const { task, score } of runnable) {
    if (counts.claimed >= maxTasks) break;
    if (!budget.canClaim()) {
      events.append('claim.skipped', { taskId: task.id, outcome: 'pulse-budget', remainingMs: budget.remainingMs() });
      break;
    }
    const depState = dependencyState(task, byId);
    if (depState === 'waiting' || depState === 'missing') {
      if (depState === 'missing') {
        transition(task, 'dead-lettered', { now, events, reason: 'depends on an unknown task', error: `Dead-lettered: depends on ${(task.dependsOn ?? []).join(', ')}, which does not exist.`, failure: { class: 'permanent', code: 'DEPENDENCY_MISSING', message: 'unknown dependency', at: now().toISOString() } });
      } else {
        transition(task, 'waiting', { now, events, reason: 'waiting on dependencies', waitReason: 'dependency', wakeAt: now().toISOString() });
      }
      continue;
    }
    if (depState === 'failed') {
      transition(task, 'dead-lettered', { now, events, reason: 'a dependency failed', error: 'Dead-lettered: a task this one depends on did not complete.', failure: { class: 'permanent', code: 'DEPENDENCY_FAILED', message: 'dependency failed', at: now().toISOString() } });
      continue;
    }

    const acquired = leases.acquire(task.id);
    if (!acquired.ok) {
      counts.skippedLeased += 1;
      events.append('claim.skipped', { taskId: task.id, outcome: 'leased-elsewhere', heldBy: acquired.heldBy });
      continue;
    }
    task.lease = acquired.lease;
    ctx.owned.add(task.id);
    task.claimedAt = now().toISOString();
    transition(task, 'running', { now, events, reason: `claimed (priority ${score.toFixed(1)})`, by: ctx.pulseId });
    counts.claimed += 1;
    const resumed = store.loadCheckpoint(task.id) != null;
    events.append('claim.acquired', { taskId: task.id, score: Math.round(score * 10) / 10, attempt: task.attempts, resumed });
    store.saveTasks(tasksFile, { loadedSnapshot: ctx.loadedSnapshot, ownedIds: ctx.owned });
    await ctx.checkpointer.checkpoint(`claim:${task.id}`);

    await processTask(task, ctx, control);

    leases.release(task.id);
    if (task.status === 'complete' || task.status === 'pr-open') counts.completed += 1;
    else if (task.status === 'waiting') counts.parked += 1;
    else if (isTerminal(task.status)) counts.failed += 1;
    store.saveTasks(tasksFile, { loadedSnapshot: ctx.loadedSnapshot, ownedIds: ctx.owned });
    await ctx.checkpointer.checkpoint(`task:${task.id}:${task.status}`);
  }
}

/* -------------------------------------------------------------------------- */
/* One task                                                                    */
/* -------------------------------------------------------------------------- */

async function processTask(task, ctx, control) {
  const { github, now, events, store, leases, budget } = ctx;
  const existing = store.loadCheckpoint(task.id);
  const cp = existing ?? newCheckpoint(task.id);
  task.runId = cp.runId;
  const pools = ctx.pools ?? ctx.poolsFactory();
  const startedMs = Date.now();

  const persist = async (checkpoint, reason) => {
    store.saveCheckpoint(checkpoint);
    leases.renew(task.id);
    await ctx.checkpointer.checkpoint(`cp:${task.id}:${reason}`);
  };

  const ledger = new SideEffectLedger({
    github, ledger: cp.sideEffects, events, now, taskId: task.id,
    onRecord: async () => { await persist(cp, 'side-effect'); },
  });
  // A resumed task may have died between an effect landing on GitHub and
  // the ledger being saved: check GitHub for the marker before re-firing.
  ledger.forceRemoteCheck = existing != null;

  // ---- gate (once per run; recorded so a resume never re-asks) ----------
  if (!cp.gate) {
    const review = await reviewAction({
      toolId: task.type === 'self-improve' ? 'self-improve-task' : 'orchestrate-task',
      args: { title: task.title },
      description: task.prompt,
      effect: 'external',
    }, ctx.reviewerOpts);
    cp.gate = { verdict: review.verdict, classification: review.classification, layer: review.layer, reason: review.reason ?? null };
    events.append('gate.verdict', { taskId: task.id, runId: cp.runId, outcome: review.verdict, classification: review.classification, layer: review.layer, audit: true });
    await persist(cp, 'gate');
  }
  if (cp.gate.verdict === 'block') {
    const error = cp.gate.reason ?? 'Blocked by the Reviewer Gate.';
    await ledger.comment(task.issueNumber, `blocked:${cp.runId}`, `TITAN-Runner declined this task: ${redactString(error)}`);
    transition(task, 'blocked', { now, events, reason: 'reviewer gate', error, failure: { class: 'policy_blocked', code: 'GATE_BLOCK', message: error, at: now().toISOString() } });
    store.deleteCheckpoint(task.id);
    return;
  }

  // ---- plan / execute / synthesize ----------------------------------------
  let result;
  try {
    result = await runOrchestration({
      task, checkpoint: cp, pools, capabilityRegistry, events, now,
      shouldDrain: () => budget.shouldDrain() || task.cancelRequested === true || task.pauseRequested === true,
      onCheckpoint: (checkpoint, reason) => persist(checkpoint, reason),
      taskTimeoutMs: config.orchestrator.taskTimeoutMs,
      maxSubtasks: config.orchestrator.maxSubtasksPerRun,
    });
  } catch (err) {
    const message = redactString(err instanceof Error ? err.message : String(err));
    log.error('task orchestration threw', { taskId: task.id, error: message });
    await ledger.comment(task.issueNumber, `error:${cp.runId}`, `TITAN-Runner hit an internal error on this task: ${message}`);
    transition(task, 'failed', { now, events, reason: 'internal error', error: message, failure: { class: 'permanent', code: 'INTERNAL', message, at: now().toISOString() } });
    store.deleteCheckpoint(task.id);
    return;
  }

  if (result.drained) {
    if (task.cancelRequested) {
      task.cancelRequested = false;
      transition(task, 'cancelled', { now, events, reason: 'cancel command honoured at a step boundary', error: 'Cancelled by an authorized command.' });
      store.deleteCheckpoint(task.id);
      return;
    }
    if (task.pauseRequested) {
      task.pauseRequested = false;
      transition(task, 'waiting', { now, events, reason: 'pause command honoured at a step boundary', waitReason: 'budget', wakeAt: now().toISOString() });
      transition(task, 'paused', { now, events, reason: 'paused by an authorized command' });
      return;
    }
    transition(task, 'waiting', { now, events, reason: 'pulse budget exhausted; checkpoint retained', waitReason: 'pulse-budget', wakeAt: now().toISOString() });
    return;
  }

  writeRunRecord(store, task, result, Date.now() - startedMs, now);

  // ---- deliver (idempotent) -------------------------------------------------
  cp.phase = 'delivering';
  await persist(cp, 'delivering');

  if (task.type === 'self-improve') {
    const { ran, result: outcome } = await ledger.once(`pr:${cp.runId}`, () => proposeSelfImprovement(task, result.synthesis, { github, reviewerOpts: ctx.reviewerOpts }));
    const final = ran ? outcome : { status: 'pr-open', prNumber: task.prNumber, prUrl: task.prUrl, reason: 'recorded on a previous pulse' };
    if (final.status === 'pr-open') {
      task.prNumber = final.prNumber ?? task.prNumber ?? null;
      task.prUrl = final.prUrl ?? task.prUrl ?? null;
      await ledger.comment(task.issueNumber, `pr-comment:${cp.runId}`, `TITAN-Runner opened a draft pull request for this self-improvement task: ${task.prUrl ?? '(PR URL unavailable in dry-run)'}\n\nIt will not be merged automatically — CI (full test suite + the denylist gate) must pass, and a maintainer decides whether to merge.`);
      transition(task, 'pr-open', { now, events, reason: 'draft PR opened' });
    } else {
      const error = final.reason ?? final.status;
      await ledger.comment(task.issueNumber, `pr-refused:${cp.runId}`, `TITAN-Runner did not open a pull request for this task: ${redactString(error)}`);
      transition(task, 'failed', { now, events, reason: `self-improve ${final.status}`, error, failure: { class: final.status === 'refused' || final.status === 'blocked' ? 'policy_blocked' : 'permanent', code: String(final.status).toUpperCase(), message: error, at: now().toISOString() } });
    }
    store.deleteCheckpoint(task.id);
    return;
  }

  await ledger.comment(task.issueNumber, `done:${cp.runId}`, issueCommentFor(result));
  if (result.ok) {
    await ledger.closeIssue(task.issueNumber, `close:${cp.runId}`);
    transition(task, 'complete', { now, events, reason: 'all steps complete' });
  } else {
    const failedStep = [...result.tasksById.values()].find((t) => t.state === 'failed');
    const message = failedStep?.error?.message ?? 'one or more steps failed';
    transition(task, 'failed', { now, events, reason: 'a step failed', error: message, failure: { class: failedStep?.error?.class ?? 'permanent', code: failedStep?.error?.code ?? 'STEP_FAILED', message, at: now().toISOString() } });
  }
  store.deleteCheckpoint(task.id);
}

async function revisitSelfImprovePr(task, ctx) {
  const { github, now, events } = ctx;
  const outcome = await checkSelfImprovePrStatus(task, { github });
  if (outcome.status === 'closed-failed') {
    const error = 'CI failed on the self-improve PR; it has been closed.';
    if (task.issueNumber) await github.commentOnIssue(task.issueNumber, `The pull request for this task failed CI and has been closed: ${task.prUrl ?? ''}`);
    transition(task, 'failed', { now, events, reason: 'self-improve PR failed CI', error, failure: { class: 'permanent', code: 'PR_CI_FAILED', message: error, at: now().toISOString() } });
  } else if (outcome.status === 'merged') {
    if (task.issueNumber) {
      await github.commentOnIssue(task.issueNumber, `The pull request for this task was merged: ${task.prUrl ?? ''}`);
      await github.closeIssue(task.issueNumber);
    }
    transition(task, 'complete', { now, events, reason: 'self-improve PR merged' });
  }
}

export default runPulse;
