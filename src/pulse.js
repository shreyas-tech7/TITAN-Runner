#!/usr/bin/env node
/**
 * @file The pulse — this repo's only entrypoint. Run by
 * `.github/workflows/titan-pulse.yml` on a cron, or by hand via
 * `npm run pulse` / `npm run pulse:dry`.
 *
 * One pulse: read state, sync new GitHub issues in as tasks, claim at most
 * `TITAN_MAX_TASKS_PER_PULSE` pending tasks, dispatch each through the
 * orchestrator across the free-tier provider pools, write results back to
 * `state/`, comment on / close the originating issues, and exit. This
 * script never touches git itself — the workflow commits and pushes
 * whatever changed under `state/` after this process exits (see
 * `docs/RUNTIME.md`), which is also what keeps the loop-protection property
 * true: a `GITHUB_TOKEN`-authored push never re-triggers the pulse.
 *
 * A self-improvement task's proposed code change is the one exception:
 * `src/selfImprove.js` pushes its own branch and opens its own PR directly,
 * because that is code, not state, and code only ever moves through a PR
 * (see section F of the design brief / docs/RUNTIME.md's "Self-improvement"
 * section).
 *
 * `runPulse(deps)` is the whole pulse as a function of its dependencies —
 * GitHub client, agent pools, reviewer model, clock — with defaults that
 * reproduce the workflow's behaviour exactly. `main()` is the thin CLI
 * wrapper: it reads the environment, wires the simulation fakes when
 * `TITAN_FAKE_PROVIDER` / `TITAN_FAKE_GITHUB` are set (see fakes/wire.js),
 * and exits with the pulse's status.
 */
import { config, isProviderConfigured } from './config.js';
import { ensureStateFiles, loadTasksState, saveTasksState, loadHeartbeat, saveHeartbeat, appendPulseHistory, RUNS_DIR } from './state/io.js';
import { writeJsonAtomic } from './state/io.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { syncIssuesIntoTasks, reconcileIssueState, addManualTask } from './issueSync.js';
import { defaultGitHubClient } from './github.js';
import { proposeSelfImprovement, checkSelfImprovePrStatus } from './selfImprove.js';
import { reviewAction } from './reviewer/reviewer.js';
import { decompose } from './orchestrator/decomposer.js';
import { Scheduler } from './orchestrator/scheduler.js';
import { synthesize } from './orchestrator/synthesizer.js';
import { capabilityRegistry } from './orchestrator/capabilityRegistry.js';
import { FreebuffAgent } from './agents/freebuffAgent.js';
import { OpenCodeAgent } from './agents/opencodeAgent.js';
import { Phase2Agent } from './agents/phase2Agent.js';
import { providerHealth } from './providers/health.js';
import { pruneRuns } from './state/prune.js';
import { scrubForState } from './lib/secretScrub.js';
import { redactString } from './lib/redact.js';
import { createLogger } from './lib/logger.js';
import { fakeDepsFromEnv } from './fakes/wire.js';

const log = createLogger('pulse');

const MAX_FILE_PREVIEW_CHARS = 4000;
const MAX_RUN_FILE_CHARS = 6000;

function defaultPools() {
  return { freebuff: new FreebuffAgent(), opencode: new OpenCodeAgent(), phase2: new Phase2Agent() };
}

/**
 * @typedef {object} PulseDeps
 * @property {ReturnType<import('./github.js').createGitHubClient>} [github]
 * @property {() => Record<string, object>} [poolsFactory] Fresh pools per orchestration.
 * @property {Record<string, object>} [pools] One fixed set of pools (wins over poolsFactory).
 * @property {Function} [reviewerChat] `chatFn` for the reviewer gate's Layer 2.
 * @property {() => Date} [now]
 * @property {string} [manualTask] Overrides TITAN_MANUAL_TASK.
 * @property {boolean} [dryRun] Overrides config.dryRun.
 * @property {(event: object) => void} [onEvent] Receives scheduler events.
 */

/**
 * @param {object} task
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean, runId: string, synthesis: object, tasksById: Map<string,object> }>}
 */
async function runOrchestration(task, ctx) {
  const runId = randomUUID();
  const pool = ctx.pools ?? ctx.poolsFactory();
  const graph = await decompose(task.prompt, { pools: pool, maxTasks: config.orchestrator.maxSubtasksPerRun });
  // Propagate the filer's routing hint (dashboard task-filing modal —
  // task instructions, sections 1 and 6) onto every subtask the decomposer
  // produced. router.js's scoreCandidate() reads `task.routingHint` off
  // whatever object scheduler.js hands it; scheduler.js builds that object
  // by spreading each graph.tasks entry (`...task` in Scheduler#run), so
  // setting it here is sufficient — no scheduler/router signature change
  // needed for a hint that is 'any' or absent, which scores identically to
  // today's behavior (see router.js's normalizeHint()).
  if (task.routingHint && task.routingHint !== 'any') {
    for (const t of graph.tasks) t.routingHint = task.routingHint;
  }
  const scheduler = new Scheduler({ pools: pool, capabilityRegistry, onEvent: ctx.onEvent });
  const tasksById = await scheduler.run(graph);
  const synthesis = await synthesize(graph, tasksById);
  const anyFailed = [...tasksById.values()].some((t) => t.state === 'failed' || t.state === 'malformed_output');
  return { ok: !anyFailed, runId, graph, synthesis, tasksById };
}

/** The exact Actions run this pulse executed under, for the dashboard's task
 *  detail drawer (task instructions, section 3) — `null` locally / in
 *  dry-run, where there is no such run. */
function actionsRunUrl() {
  if (!config.github.runId || !config.github.repository) return null;
  return `https://github.com/${config.github.repository}/actions/runs/${config.github.runId}`;
}

function writeRunRecord(task, result, durationMs, now) {
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
      attempts: (t.attempts ?? []).map((a) => ({
        modelId: a.modelId, pool: a.pool, ok: a.ok, ms: a.ms, tokensUsed: a.tokensUsed ?? null,
      })),
      outputPreview: typeof t.output === 'string' ? t.output.slice(0, MAX_FILE_PREVIEW_CHARS) : null,
      error: t.error,
    })),
    files: result.synthesis.files.map((f) => ({ path: f.path, sourceTaskId: f.sourceTaskId, conflict: f.conflict })),
    markdownSummary: String(result.synthesis.markdownSummary ?? '').slice(0, MAX_RUN_FILE_CHARS),
  });
  writeJsonAtomic(join(RUNS_DIR, `${result.runId}.json`), record);
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

async function processTask(task, ctx) {
  const { github, now } = ctx;
  task.status = 'running';
  task.startedAt = now().toISOString();

  const review = await reviewAction({
    toolId: task.type === 'self-improve' ? 'self-improve-task' : 'orchestrate-task',
    args: { title: task.title },
    description: task.prompt,
    effect: 'external',
  }, ctx.reviewerOpts);

  if (review.verdict === 'block') {
    task.status = 'blocked';
    task.completedAt = now().toISOString();
    task.error = review.reason ?? 'Blocked by the Reviewer Gate.';
    if (task.issueNumber) {
      await github.commentOnIssue(task.issueNumber, `TITAN-Runner declined this task: ${redactString(task.error)}`);
    }
    return;
  }

  let result;
  try {
    result = await runOrchestration(task, ctx);
  } catch (err) {
    task.status = 'failed';
    task.completedAt = now().toISOString();
    task.error = redactString(err instanceof Error ? err.message : String(err));
    log.error('task orchestration threw', { taskId: task.id, error: task.error });
    if (task.issueNumber) {
      await github.commentOnIssue(task.issueNumber, `TITAN-Runner hit an internal error on this task: ${task.error}`);
    }
    return;
  }

  task.runId = result.runId;
  writeRunRecord(task, result, Date.now() - Date.parse(task.startedAt), now);

  if (task.type === 'self-improve') {
    const outcome = await proposeSelfImprovement(task, result.synthesis, { github, reviewerOpts: ctx.reviewerOpts });
    task.completedAt = now().toISOString();
    if (outcome.status === 'pr-open') {
      task.status = 'pr-open';
      task.prNumber = outcome.prNumber ?? null;
      task.prUrl = outcome.prUrl ?? null;
      if (task.issueNumber) {
        await github.commentOnIssue(
          task.issueNumber,
          `TITAN-Runner opened a draft pull request for this self-improvement task: ${outcome.prUrl ?? '(PR URL unavailable in dry-run)'}\n\nIt will not be merged automatically — CI (full test suite + the denylist gate) must pass, and a maintainer decides whether to merge.`,
        );
      }
    } else {
      task.status = 'failed';
      task.error = outcome.reason ?? outcome.status;
      if (task.issueNumber) {
        await github.commentOnIssue(task.issueNumber, `TITAN-Runner did not open a pull request for this task: ${redactString(task.error)}`);
      }
    }
    return;
  }

  task.status = result.ok ? 'complete' : 'failed';
  task.completedAt = now().toISOString();
  if (task.issueNumber) {
    await github.commentOnIssue(task.issueNumber, issueCommentFor(result));
    if (result.ok) await github.closeIssue(task.issueNumber);
  }
}

async function revisitSelfImprovePr(task, ctx) {
  const { github, now } = ctx;
  const outcome = await checkSelfImprovePrStatus(task, { github });
  if (outcome.status === 'closed-failed') {
    task.status = 'failed';
    task.error = 'CI failed on the self-improve PR; it has been closed.';
    task.completedAt = now().toISOString();
    if (task.issueNumber) {
      await github.commentOnIssue(task.issueNumber, `The pull request for this task failed CI and has been closed: ${task.prUrl ?? ''}`);
    }
  } else if (outcome.status === 'merged') {
    task.status = 'complete';
    task.completedAt = now().toISOString();
    if (task.issueNumber) {
      await github.commentOnIssue(task.issueNumber, `The pull request for this task was merged: ${task.prUrl ?? ''}`);
      await github.closeIssue(task.issueNumber);
    }
  }
  // 'still-open'/'unknown': leave as-is, checked again next pulse.
}

/** Every provider id this repo knows about, registry-backed or agent-pool-backed. */
const ALL_PROVIDER_IDS = ['groq', 'together', 'openrouter', 'gemini', 'huggingface', 'freebuff', 'opencode'];

/**
 * Stamp `not_configured`/`no_public_api` for every provider that will not be
 * attempted this pulse, so `state/providers.json` (and the dashboard's
 * health strip) reflects the truth even for a provider no task ever routes
 * to this run — never left at a stale or misleading status from days ago.
 */
function primeProviderHealth() {
  for (const id of ALL_PROVIDER_IDS) {
    if (id === 'freebuff') {
      // No legitimate public API exists for Freebuff — see docs/RUNTIME.md's
      // provider section. Distinct from "not configured": a key changes
      // nothing here, so this is stamped unconditionally.
      providerHealth.markNoPublicApi('freebuff', 'Freebuff has no official public HTTP API for third-party integration.');
      continue;
    }
    if (isProviderConfigured(id)) providerHealth.markConfigured(id);
    else providerHealth.markNotConfigured(id);
  }
}

/**
 * One whole pulse. Resolves with the same summary object the CLI prints.
 * @param {PulseDeps} [deps]
 * @returns {Promise<{ pulse: 'complete', durationMs: number, tasksClaimed: number, tasksCompleted: number, tasksFailed: number, dryRun: boolean, error: string|null }>}
 */
export async function runPulse(deps = {}) {
  const now = deps.now ?? (() => new Date());
  const github = deps.github ?? defaultGitHubClient;
  const dryRun = deps.dryRun ?? config.dryRun;
  const manualTask = deps.manualTask ?? process.env.TITAN_MANUAL_TASK ?? '';
  const ctx = {
    github,
    now,
    pools: deps.pools ?? null,
    poolsFactory: deps.poolsFactory ?? defaultPools,
    reviewerOpts: deps.reviewerChat ? { chatFn: deps.reviewerChat } : {},
    onEvent: deps.onEvent ?? (() => {}),
  };

  const pulseStartedAt = Date.now();
  ensureStateFiles();
  primeProviderHealth();

  const tasksState = loadTasksState();
  const heartbeat = loadHeartbeat();

  let tasksClaimed = 0;
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let pulseError = null;

  try {
    if (!dryRun) {
      const { added, ignored, issues } = await syncIssuesIntoTasks(tasksState, { listIssues: github.listOpenTaskIssues.bind(github), now });
      if (added > 0) log.info('synced issues into task queue', { added });
      if (ignored > 0) log.info('ignored issues from unauthorized authors', { ignored });
      // Dashboard cancel/retry (task instructions, section 1) act on the
      // GitHub issue directly from the browser — this is what makes those
      // actions take effect here rather than being purely cosmetic.
      const { cancelled, retried } = await reconcileIssueState(tasksState, issues, { listComments: github.listIssueComments.bind(github), now });
      if (cancelled > 0) log.info('cancelled tasks whose issue was closed from the dashboard', { cancelled });
      if (retried > 0) log.info('reset tasks to pending after an authorized retry command', { retried });
    }

    if (manualTask && manualTask.trim().length > 0) {
      const id = addManualTask(tasksState, manualTask.trim(), { now });
      log.info('added manual task from workflow_dispatch input', { id });
    }

    // Revisit any self-improve tasks already awaiting a PR's CI result.
    for (const task of tasksState.tasks.filter((t) => t.status === 'pr-open')) {
      await revisitSelfImprovePr(task, ctx);
    }

    const pending = tasksState.tasks.filter((t) => t.status === 'pending');
    const claim = pending.slice(0, config.orchestrator.maxTasksPerPulse);
    for (const task of claim) {
      task.claimedAt = now().toISOString();
      tasksClaimed += 1;
    }

    for (const task of claim) {
      await processTask(task, ctx);
      if (task.status === 'complete' || task.status === 'pr-open') tasksCompleted += 1;
      else if (task.status === 'failed' || task.status === 'blocked') tasksFailed += 1;
    }

    // Persist the capability registry even on a pulse that claimed nothing,
    // so state/agents.json always reflects the current seed/observed table.
    capabilityRegistry.list();
    capabilityRegistry.save();
    providerHealth.save();

    const pruneResult = pruneRuns({ maxFiles: 60 });
    if (pruneResult.prunedCount > 0) log.info('pruned old run records into a digest', pruneResult);
  } catch (err) {
    pulseError = redactString(err instanceof Error ? err.message : String(err));
    log.error('pulse failed', { error: pulseError });
  }

  const durationMs = Date.now() - pulseStartedAt;
  const finishedAt = now().toISOString();
  saveTasksState(tasksState);
  saveHeartbeat({
    version: 1,
    lastPulseAt: finishedAt,
    lastPulseStatus: pulseError ? 'error' : 'ok',
    lastPulseDurationMs: durationMs,
    lastPulseTasksClaimed: tasksClaimed,
    lastPulseTasksCompleted: tasksCompleted,
    lastPulseTasksFailed: tasksFailed,
    lastPulseError: pulseError,
    consecutivePulseFailures: pulseError ? (heartbeat.consecutivePulseFailures ?? 0) + 1 : 0,
    totalPulses: (heartbeat.totalPulses ?? 0) + 1,
    cadenceMinutes: heartbeat.cadenceMinutes ?? 15,
  });
  // Pulse timeline strip (dashboard, task instructions section 3) — real
  // committed data only, one entry per pulse, oldest dropped past
  // MAX_PULSE_HISTORY.
  appendPulseHistory({
    at: finishedAt,
    durationMs,
    status: pulseError ? 'error' : 'ok',
    tasksClaimed,
    tasksCompleted,
    tasksFailed,
  });

  return {
    pulse: 'complete',
    durationMs,
    tasksClaimed,
    tasksCompleted,
    tasksFailed,
    dryRun,
    error: pulseError,
  };
}

async function main() {
  const fakes = fakeDepsFromEnv(process.env);
  const summary = await runPulse(fakes ?? {});
  console.log(JSON.stringify(summary));
  if (summary.error) process.exitCode = 1;
}

// Only run when executed directly — importing `runPulse` must not start a pulse.
const invokedDirectly = process.argv[1] && /[\\/]pulse\.js$/.test(process.argv[1]);
if (invokedDirectly) await main();
