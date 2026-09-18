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
 *      re-asks), plan → execute (tool calls policy-gated) → synthesize →
 *      verify (checks, then an independent judge) → remediate (bounded),
 *      with checkpoints at every step; delivery policy-gated by autonomy
 *      (`policy/engine.js`: dry-run, propose, approval, autonomous),
 *      drain to `waiting(pulse-budget)` when the budget or the pulse's
 *      model-call ceiling runs out, park to `waiting(provider | quota)` when
 *      the provider side is the problem (dead-letter past the park ceiling),
 *      dead-letter a poisoned or over-budget task, deliver through the
 *      idempotent side-effect ledger, terminal transition
 *   8. retention (runs, events, tasks), quota ledger, heartbeat, pulse
 *      history, `pulse.finished`, final forced checkpoint
 *
 * Budgets (env, all optional): TITAN_PULSE_BUDGET_MS, TITAN_PULSE_MAX_MODEL_CALLS,
 * TITAN_TASK_MAX_MODEL_CALLS, TITAN_TASK_MAX_TOKENS, TITAN_TASK_MAX_WALL_MS,
 * TITAN_MAX_PARKS. Model calls are counted at the adapter (every pool);
 * upstream calls at the registry (its routing decisions become events).
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
import { runOrchestration, newCheckpoint, usageOf } from './orchestrate.js';
import { QuotaLedger } from '../reliability/quota.js';
import { QUOTA_SCHEMA } from '../state/schema.js';
import { registry as defaultRegistry, FAILOVER_ORDER } from '../providers/registry.js';
import { onAdapterCall } from '../agents/AgentAdapter.js';
import { now as clockNow } from '../lib/clock.js';
import { ToolRegistry } from '../tools/registry.js';
import { builtinTools } from '../tools/builtin.js';
import { decide as policyDecide, effectiveAutonomy } from '../policy/engine.js';
import { writeViews } from '../observability/views.js';

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
  const v = result.verification ?? null;
  const headline = result.ok
    ? `TITAN-Runner finished this task${v ? (v.unjudged ? ' (verified by checks; no independent judge was available)' : ` (verified by ${v.judge?.provider ?? 'a judge model'})`) : ''}.`
    : result.failedVerification
      ? `TITAN-Runner finished the work, but it did not pass verification: ${redactString(v?.reason ?? 'unknown')}`
      : 'TITAN-Runner finished this task, but one or more subtasks failed.';
  const lines = [headline, '', result.synthesis.markdownSummary.slice(0, 60000)];
  if (v) {
    const failed = (v.checks ?? []).filter((c) => !c.ok);
    lines.push('', '<details><summary>Verification</summary>', '', `Verdict: **${v.verdict}** — ${redactString(v.reason ?? '')}`);
    if (v.judge) lines.push(`Judge: ${v.judge.provider ?? 'unknown'} → ${v.judge.verdict ?? 'no verdict'}${v.judge.reason ? ` (${redactString(v.judge.reason)})` : ''}`);
    for (const c of failed) lines.push(`- ${c.id}: ${redactString(c.detail)}`);
    lines.push('</details>');
  }
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

/**
 * The registry-shaped `chat()` the verification judge uses: the phase2
 * pool's registry (the real one in production, the fake's in a simulation)
 * so the judge can be pinned to a provider that produced none of the work.
 */
function judgeChatFor(pools) {
  const reg = pools?.phase2?.registryDep;
  return reg && typeof reg.chat === 'function' ? reg.chat.bind(reg) : null;
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
 * @property {{ pulseMaxCalls?: number, taskMaxCalls?: number, taskMaxTokens?: number, taskMaxWallMs?: number, maxParks?: number, maxRemediations?: number, maxToolCalls?: number }} [limits]
 * @property {import('../tools/registry.js').ToolRegistry|null} [tools] The tool registry (default: the built-ins over `repoRoot`); null disables tools.
 * @property {string} [repoRoot] The checkout the read tools see (default: cwd).
 * @property {{ enabled?: boolean, strict?: boolean, chat?: Function|null }} [judge] Verification judge settings (default from env).
 */

/**
 * @param {PulseDeps} [deps]
 * @returns {Promise<object>} The summary the CLI prints.
 */
export async function runPulse(deps = {}) {
  const now = deps.now ?? clockNow;
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
  const limits = {
    pulseMaxCalls: deps.limits?.pulseMaxCalls ?? positiveInt(process.env.TITAN_PULSE_MAX_MODEL_CALLS, 120),
    taskMaxCalls: deps.limits?.taskMaxCalls ?? positiveInt(process.env.TITAN_TASK_MAX_MODEL_CALLS, 40),
    taskMaxTokens: deps.limits?.taskMaxTokens ?? positiveInt(process.env.TITAN_TASK_MAX_TOKENS, 200_000),
    taskMaxWallMs: deps.limits?.taskMaxWallMs ?? positiveInt(process.env.TITAN_TASK_MAX_WALL_MS, 60 * 60_000),
    maxParks: deps.limits?.maxParks ?? positiveInt(process.env.TITAN_MAX_PARKS, 6),
    maxRemediations: deps.limits?.maxRemediations ?? positiveInt(process.env.TITAN_MAX_REMEDIATIONS, 1),
    maxToolCalls: deps.limits?.maxToolCalls ?? positiveInt(process.env.TITAN_MAX_TOOL_CALLS_PER_STEP, 6),
  };

  // Tools: the built-in registry over the checkout, unless the caller hands
  // in its own (tests) or turns them off (`TITAN_TOOLS=off`).
  let tools = null;
  if (deps.tools !== null && process.env.TITAN_TOOLS !== 'off') {
    tools = deps.tools ?? new ToolRegistry();
    if (!deps.tools) for (const def of builtinTools({ repoRoot: deps.repoRoot ?? process.cwd(), workspaceRoot: join(stateDir, 'workspaces') })) tools.register(def);
  }
  const judgeSettings = {
    enabled: deps.judge?.enabled ?? process.env.TITAN_VERIFY_JUDGE !== '0',
    strict: deps.judge?.strict ?? process.env.TITAN_VERIFY_STRICT === '1',
    chat: deps.judge?.chat ?? null,
    candidates: FAILOVER_ORDER,
  };

  // The quota ledger and the routing-decision sink are attached to every
  // registry this pulse can route through (the shared production one, and a
  // fake pool's own) for the duration of the pulse, and detached at the end
  // so an in-process caller running several pulses never leaks one into the
  // next.
  const quota = new QuotaLedger({ path: store.paths.quota, now, writeJson: (path, data) => store.writeJson(path, data, { backup: false, schema: QUOTA_SCHEMA }) });
  const usage = { modelCalls: 0, upstreamCalls: 0, tokens: 0, routingFailures: 0 };
  const registries = new Set([defaultRegistry]);
  for (const pool of Object.values(deps.pools ?? {})) {
    if (typeof pool?.registry?.useQuota === 'function') registries.add(pool.registry);
  }
  const decisionSink = (d) => {
    usage.upstreamCalls += d.tried.length;
    if (!d.chosen) usage.routingFailures += 1;
    events.append('routing.decision', {
      taskId: ctx.activeTaskId ?? null, service: d.service, provider: d.chosen, outcome: d.chosen ? 'routed' : 'failed',
      tried: d.tried, skipped: d.skipped.map((x) => x.id), failureClass: d.failureClass ?? null, durationMs: Math.round(d.ms),
    });
  };
  for (const r of registries) {
    r.useQuota(quota);
    r.useDecisionSink(decisionSink);
  }
  const offAdapterCalls = onAdapterCall((call) => {
    usage.modelCalls += 1;
    if (Number.isFinite(call.tokensUsed)) usage.tokens += call.tokensUsed;
    ctx.activeUsage?.(call);
  });
  const detach = () => {
    offAdapterCalls();
    for (const r of registries) {
      r.useQuota(null);
      r.useDecisionSink(null);
    }
  };

  const ctx = {
    github, now, events, store, leases, budget, checkpointer, pulseId, limits, quota, usage, tools, judgeSettings, stateDir,
    pools: deps.pools ?? null,
    poolsFactory: deps.poolsFactory ?? defaultPools,
    reviewerOpts: { ...(deps.reviewerChat ? { chatFn: deps.reviewerChat } : {}), reviewsDir: store.paths.reviews },
    /** Set while a task is being processed: attributes adapter calls to it. */
    activeUsage: null,
    activeTaskId: null,
  };

  primeProviderHealth();
  const control = store.loadControl();
  const heartbeat = store.loadHeartbeat();
  const tasksFile = store.loadTasks();
  const loadedSnapshot = JSON.stringify(tasksFile.tasks);
  ctx.loadedSnapshot = loadedSnapshot;

  events.append('pulse.started', { budgetMs: budget.budgetMs, maxModelCalls: limits.pulseMaxCalls, tasks: tasksFile.tasks.length, killSwitch: control.killSwitch, drain: control.drain, safeMode: control.safeMode, autonomy: control.autonomy, tools: tools?.size ?? 0, repairs: store.repairs.length });

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
    quota.save();

    const pruneResult = pruneRuns({ maxFiles: config.retention.maxRunFiles, runsDir: store.paths.runs, digestsDir: store.paths.digests });
    if (pruneResult.prunedCount > 0) log.info('pruned old run records into a digest', pruneResult);
    const archived = store.archiveOldTasks(tasksFile, { maxAgeDays: positiveInt(process.env.TITAN_TASK_RETENTION_DAYS, 30) });
    if (archived > 0) events.append('retention.tasks-archived', { count: archived });
    const compacted = events.compact();
    if (compacted.compacted > 0) events.append('retention.events-compacted', { count: compacted.compacted });
    // Derived views (state/views/*.json): rebuilt from what this pulse wrote;
    // never read back by the engine, so a failure here is logged, not fatal.
    try {
      writeViews({ store, tasksFile, health: providerHealth, providerIds: ALL_PROVIDER_IDS, quota, now });
    } catch (err) {
      log.warn('views not rebuilt', { error: redactString(err instanceof Error ? err.message : String(err)) });
      events.append('views.failed', { outcome: 'error', error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  } catch (err) {
    pulseError = redactString(err instanceof Error ? err.message : String(err));
    log.error('pulse failed', { error: pulseError, stack: err instanceof Error ? redactString(String(err.stack)).slice(0, 1500) : undefined });
    events.append('pulse.error', { outcome: 'error', error: pulseError });
  }

  const durationMs = Date.now() - pulseStartedAt;
  const finishedAt = now().toISOString();
  try {
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
      modelCalls: usage.modelCalls,
    });
    appendPulseHistory({ at: finishedAt, durationMs, status: pulseError ? 'error' : 'ok', tasksClaimed: counts.claimed, tasksCompleted: counts.completed, tasksFailed: counts.failed, modelCalls: usage.modelCalls }, store.paths.pulseHistory);
    store.written.add(store.paths.pulseHistory);

    const quotaUsed = Object.fromEntries(Object.entries(quota.snapshot()).filter(([, q]) => q.usedDay > 0).map(([id, q]) => [id, { usedDay: q.usedDay, dayLeft: q.dayLeft, usedMinute: q.usedMinute }]));
    events.append('pulse.finished', { durationMs, outcome: pulseError ? 'error' : 'ok', ...counts, calls: usage.modelCalls, upstreamCalls: usage.upstreamCalls, tokens: usage.tokens, routingFailures: usage.routingFailures, quota: quotaUsed, budget: budget.snapshot(), reconcile: reconcileCounts, checkpoint: checkpointer.summary() });
    await checkpointer.checkpoint('pulse-end', { force: true });
  } finally {
    detach();
  }

  return {
    pulse: 'complete',
    pulseId,
    durationMs,
    tasksClaimed: counts.claimed,
    tasksCompleted: counts.completed,
    tasksFailed: counts.failed,
    tasksParked: counts.parked,
    modelCalls: usage.modelCalls,
    upstreamCalls: usage.upstreamCalls,
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
    if (ctx.usage.modelCalls >= ctx.limits.pulseMaxCalls) {
      events.append('claim.skipped', { taskId: task.id, outcome: 'pulse-call-budget', calls: ctx.usage.modelCalls, max: ctx.limits.pulseMaxCalls });
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
  ctx.activeTaskId = task.id;
  try {
    await processTaskInner(task, ctx, control);
  } finally {
    ctx.activeTaskId = null;
    ctx.activeUsage = null;
  }
}

/** A short, reviewer-safe line for the issue when the engine gives a task up for good. */
function deadLetterNote(reason) {
  return `TITAN-Runner has stopped working on this task: ${reason} An authorized user can retry it later with \`/titan retry\`.`;
}

async function processTaskInner(task, ctx, control) {
  const { github, now, events, store, leases, budget, limits } = ctx;
  const existing = store.loadCheckpoint(task.id);
  const cp = existing ?? newCheckpoint(task.id);
  task.runId = cp.runId;
  const pools = ctx.pools ?? ctx.poolsFactory();
  const startedMs = Date.now();

  // ---- usage and budgets ----------------------------------------------------
  // Usage accumulates across pulses in the checkpoint; this pulse's calls
  // are attributed live through the adapter hook and folded in at every
  // persist, so a crash loses at most one step's worth of accounting.
  const base = usageOf(cp);
  const live = { calls: 0, tokens: 0 };
  ctx.activeUsage = (call) => {
    live.calls += 1;
    if (Number.isFinite(call.tokensUsed)) live.tokens += call.tokensUsed;
  };
  const usageNow = () => ({ calls: base.calls + live.calls, tokens: base.tokens + live.tokens, wallMs: base.wallMs + (Date.now() - startedMs) });
  const overBudget = () => {
    const u = usageNow();
    if (u.calls > limits.taskMaxCalls) return `model calls ${u.calls} exceed the task ceiling of ${limits.taskMaxCalls}`;
    if (u.tokens > limits.taskMaxTokens) return `tokens ${u.tokens} exceed the task ceiling of ${limits.taskMaxTokens}`;
    if (u.wallMs > limits.taskMaxWallMs) return `active time ${Math.round(u.wallMs / 1000)} s exceeds the task ceiling of ${Math.round(limits.taskMaxWallMs / 1000)} s`;
    return null;
  };
  const pulseCallsSpent = () => ctx.usage.modelCalls >= limits.pulseMaxCalls;

  const persist = async (checkpoint, reason) => {
    checkpoint.usage = usageNow();
    task.usage = checkpoint.usage;
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
  // Policy: what this task may cause to happen outside the process. The
  // effective autonomy is the stricter of the control file and the task.
  const policyTask = () => ({ autonomy: task.autonomy, approvals: task.approvals ?? null });
  const autonomy = effectiveAutonomy(control, policyTask());
  const policy = (action) => {
    const d = policyDecide({ action, control, task: policyTask() });
    events.append('policy.decision', { taskId: task.id, runId: cp.runId, action: action.kind === 'tool' ? `tool:${action.toolId}` : action.kind, effect: action.effect, outcome: d.decision, reason: d.reason, approvalKey: d.approvalKey, autonomy: d.autonomy, audit: true });
    return d;
  };
  // Dry-run autonomy and safe mode keep every comment inside the process:
  // the run record and the event log still hold everything that happened.
  if (autonomy === 'dry-run') ledger.suppressed = 'autonomy is dry-run';
  else if (control.safeMode) ledger.suppressed = 'safe mode is on';
  cp.tools = cp.tools ?? {};
  const toolContext = { control, task: policyTask(), taskId: task.id, ledger: cp.tools, events, now };
  const judge = { ...ctx.judgeSettings, chat: ctx.judgeSettings.chat ?? judgeChatFor(pools) };
  const askApproval = async (key, what) => {
    await ledger.comment(task.issueNumber, `approval:${key}`, `TITAN-Runner needs an authorized user's approval before it continues with this task.\n\n${what}\n\nReply \`/titan approve ${key}\` to allow it or \`/titan deny ${key}\` to stop it. (Autonomy: ${autonomy}.)`);
    transition(task, 'waiting', { now, events, reason: `waiting for approval of ${key}`, waitReason: 'approval', wakeAt: now().toISOString() });
  };

  const deadLetter = async (code, cls, message, note) => {
    const at = now().toISOString();
    await ledger.comment(task.issueNumber, `dead-letter:${cp.runId}`, deadLetterNote(note));
    transition(task, 'dead-lettered', { now, events, reason: code.toLowerCase().replace(/_/g, ' '), error: message, failure: { class: cls, code, message, at } });
    task.usage = usageNow();
    store.deleteCheckpoint(task.id);
  };

  // A resumed task that already spent its budget is not given another run.
  const overBefore = overBudget();
  if (overBefore) {
    await deadLetter('TASK_BUDGET', 'budget_exhausted', `Dead-lettered: ${overBefore}.`, `${overBefore}.`);
    return;
  }

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
    task.usage = usageNow();
    store.deleteCheckpoint(task.id);
    return;
  }

  // ---- plan / execute / synthesize ----------------------------------------
  let result;
  try {
    result = await runOrchestration({
      task, checkpoint: cp, pools, capabilityRegistry, events, now,
      shouldDrain: () => budget.shouldDrain() || pulseCallsSpent() || overBudget() != null || task.cancelRequested === true || task.pauseRequested === true,
      onCheckpoint: (checkpoint, reason) => persist(checkpoint, reason),
      taskTimeoutMs: config.orchestrator.taskTimeoutMs,
      maxSubtasks: config.orchestrator.maxSubtasksPerRun,
      tools: ctx.tools, toolContext, maxToolCalls: limits.maxToolCalls,
      judge, maxRemediations: limits.maxRemediations, scratchDir: join(ctx.stateDir, 'workspaces'),
      onJudgeCall: () => { ctx.usage.modelCalls += 1; live.calls += 1; },
    });
  } catch (err) {
    const message = redactString(err instanceof Error ? err.message : String(err));
    log.error('task orchestration threw', { taskId: task.id, error: message });
    await ledger.comment(task.issueNumber, `error:${cp.runId}`, `TITAN-Runner hit an internal error on this task: ${message}`);
    transition(task, 'failed', { now, events, reason: 'internal error', error: message, failure: { class: 'permanent', code: 'INTERNAL', message, at: now().toISOString() } });
    task.usage = usageNow();
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
    const over = overBudget();
    if (over) {
      await deadLetter('TASK_BUDGET', 'budget_exhausted', `Dead-lettered: ${over}.`, `${over}.`);
      return;
    }
    await persist(cp, 'drained');
    if (pulseCallsSpent()) {
      transition(task, 'waiting', { now, events, reason: `pulse model-call ceiling (${limits.pulseMaxCalls}) reached; checkpoint retained`, waitReason: 'pulse-budget', wakeAt: now().toISOString() });
      return;
    }
    transition(task, 'waiting', { now, events, reason: 'pulse budget exhausted; checkpoint retained', waitReason: 'pulse-budget', wakeAt: now().toISOString() });
    return;
  }

  // ---- parked on approval: ask once, wait for /titan approve ----------------
  if (result.parked?.reason === 'approval') {
    await persist(cp, 'approval');
    await askApproval(result.parked.approvalKey, `A step asked to run a tool that needs approval at this autonomy level: ${redactString(result.parked.why)}`);
    return;
  }

  // ---- parked: the provider side is the problem; wait, do not fail ---------
  if (result.parked) {
    task.parks = (task.parks ?? 0) + 1;
    const { reason, wakeInMs, why, failureClass, code } = result.parked;
    if (task.parks > limits.maxParks) {
      const message = `Dead-lettered: parked ${task.parks} times waiting on ${reason} (${why}).`;
      await deadLetter('PARK_CEILING', reason === 'quota' ? 'budget_exhausted' : 'provider_down', message, `it waited ${task.parks} times for ${reason === 'quota' ? 'quota to return' : 'a provider to recover'} and never got through.`);
      return;
    }
    await persist(cp, 'parked');
    const wakeAt = new Date(now().getTime() + Math.max(1000, wakeInMs ?? 0)).toISOString();
    transition(task, 'waiting', {
      now, events, reason: `parked on ${reason} (${why}); wakes at ${wakeAt}`, waitReason: reason, wakeAt,
      failure: { class: failureClass ?? (reason === 'quota' ? 'budget_exhausted' : 'provider_down'), code: code ?? null, message: why, at: now().toISOString() },
    });
    return;
  }

  writeRunRecord(store, task, result, Date.now() - startedMs, now);

  // ---- deliver (idempotent, policy-gated) -----------------------------------
  const delivery = policy({ kind: task.type === 'self-improve' ? 'self-improve' : 'deliver', effect: 'external', runId: cp.runId });
  if (delivery.decision === 'approve') {
    await persist(cp, 'delivery-approval');
    await askApproval(delivery.approvalKey, task.type === 'self-improve' ? 'It wants to open a draft pull request with the proposed change.' : `It has finished the work (${result.ok ? 'verified' : 'with failures'}) and wants to post the result on this issue${result.ok ? ' and close it' : ''}.`);
    return;
  }
  if (delivery.decision === 'deny' && delivery.source === 'denial') {
    // An authorized user said no to this delivery: the task ends here, and
    // nothing is posted.
    events.append('delivery.denied', { taskId: task.id, runId: cp.runId, reason: delivery.reason, audit: true });
    transition(task, 'cancelled', { now, events, reason: `delivery ${delivery.reason}`, error: `Cancelled: delivery ${delivery.reason}.`, failure: { class: 'cancelled', code: 'DELIVERY_DENIED', message: delivery.reason, at: now().toISOString() } });
    task.usage = usageNow();
    store.deleteCheckpoint(task.id);
    return;
  }
  if (delivery.decision === 'deny') {
    events.append('delivery.suppressed', { taskId: task.id, runId: cp.runId, reason: delivery.reason, outcome: result.ok ? 'complete' : 'failed', audit: true });
    if (task.type === 'self-improve') {
      transition(task, 'blocked', { now, events, reason: `pull request not opened: ${delivery.reason}`, error: `Not delivered: ${delivery.reason}.`, failure: { class: 'policy_blocked', code: 'DELIVERY_SUPPRESSED', message: delivery.reason, at: now().toISOString() } });
    } else if (result.ok) {
      transition(task, 'complete', { now, events, reason: `complete; delivery suppressed (${delivery.reason})` });
    } else {
      const failedStep = [...result.tasksById.values()].find((t) => t.state === 'failed');
      const message = result.failedVerification ? `Verification failed: ${result.verification?.reason ?? 'unknown'}` : failedStep?.error?.message ?? 'one or more steps failed';
      transition(task, 'failed', { now, events, reason: `failed; delivery suppressed (${delivery.reason})`, error: message, failure: { class: result.failedVerification ? 'permanent' : failedStep?.error?.class ?? 'permanent', code: result.failedVerification ? 'VERIFICATION_FAILED' : failedStep?.error?.code ?? 'STEP_FAILED', message, at: now().toISOString() } });
    }
    task.usage = usageNow();
    store.deleteCheckpoint(task.id);
    return;
  }
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
    task.usage = usageNow();
    store.deleteCheckpoint(task.id);
    return;
  }

  const failedStep = [...result.tasksById.values()].find((t) => t.state === 'failed');
  if (!result.ok && failedStep?.error?.class === 'poisoned') {
    // The same failure kept recurring: no amount of retrying will change
    // it, and a retry storm is exactly what the taxonomy exists to prevent.
    const message = `Dead-lettered: ${failedStep.error.message}`;
    await deadLetter('NO_PROGRESS', 'poisoned', message, `step ${failedStep.id} kept failing the same way (${redactString(failedStep.error.message)}).`);
    return;
  }

  await ledger.comment(task.issueNumber, `done:${cp.runId}`, issueCommentFor(result));
  if (result.ok) {
    await ledger.closeIssue(task.issueNumber, `close:${cp.runId}`);
    transition(task, 'complete', { now, events, reason: result.verification?.unjudged ? 'all steps complete; verified by checks (unjudged)' : 'all steps complete and verified' });
  } else if (result.failedVerification) {
    const message = `Verification failed: ${result.verification?.reason ?? 'unknown'}`;
    transition(task, 'failed', { now, events, reason: `verification failed after ${result.verification?.round ?? 0} remediation(s)`, error: message, failure: { class: 'permanent', code: 'VERIFICATION_FAILED', message, at: now().toISOString() } });
  } else {
    const message = failedStep?.error?.message ?? 'one or more steps failed';
    transition(task, 'failed', { now, events, reason: 'a step failed', error: message, failure: { class: failedStep?.error?.class ?? 'permanent', code: failedStep?.error?.code ?? 'STEP_FAILED', message, at: now().toISOString() } });
  }
  task.usage = usageNow();
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
