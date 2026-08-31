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
 */
import { config } from './config.js';
import { ensureStateFiles, loadTasksState, saveTasksState, loadHeartbeat, saveHeartbeat, RUNS_DIR } from './state/io.js';
import { writeJsonAtomic } from './state/io.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { syncIssuesIntoTasks, addManualTask } from './issueSync.js';
import { commentOnIssue, closeIssue } from './github.js';
import { proposeSelfImprovement, checkSelfImprovePrStatus } from './selfImprove.js';
import { reviewAction } from './reviewer/reviewer.js';
import { decompose } from './orchestrator/decomposer.js';
import { Scheduler } from './orchestrator/scheduler.js';
import { synthesize } from './orchestrator/synthesizer.js';
import { capabilityRegistry } from './orchestrator/capabilityRegistry.js';
import { FreebuffAgent } from './agents/freebuffAgent.js';
import { OpenCodeAgent } from './agents/opencodeAgent.js';
import { Phase2Agent } from './agents/phase2Agent.js';
import { registry as providerRegistry } from './providers/registry.js';
import { pruneRuns } from './state/prune.js';
import { scrubForState } from './lib/secretScrub.js';
import { redactString } from './lib/redact.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('pulse');

const MAX_FILE_PREVIEW_CHARS = 4000;
const MAX_RUN_FILE_CHARS = 6000;

function pools() {
  return { freebuff: new FreebuffAgent(), opencode: new OpenCodeAgent(), phase2: new Phase2Agent() };
}

/**
 * @param {object} task
 * @returns {Promise<{ ok: boolean, runId: string, synthesis: object, tasksById: Map<string,object> }>}
 */
async function runOrchestration(task) {
  const runId = randomUUID();
  const pool = pools();
  const graph = await decompose(task.prompt, { pools: pool, maxTasks: config.orchestrator.maxSubtasksPerRun });
  const scheduler = new Scheduler({ pools: pool, capabilityRegistry, onEvent: () => {} });
  const tasksById = await scheduler.run(graph);
  const synthesis = await synthesize(graph, tasksById);
  const anyFailed = [...tasksById.values()].some((t) => t.state === 'failed' || t.state === 'malformed_output');
  return { ok: !anyFailed, runId, graph, synthesis, tasksById };
}

/**
 * @param {object} task
 * @param {{ runId: string, graph: object, synthesis: object, tasksById: Map<string, object>, ok: boolean }} result
 * @param {number} durationMs
 */
function writeRunRecord(task, result, durationMs) {
  const record = scrubForState({
    runId: result.runId,
    taskId: task.id,
    taskTitle: task.title,
    issueUrl: task.issueUrl,
    createdAt: new Date().toISOString(),
    durationMs,
    state: result.ok ? 'complete' : 'failed',
    sharedContext: String(result.graph.sharedContext ?? '').slice(0, MAX_RUN_FILE_CHARS),
    tasks: [...result.tasksById.values()].map((t) => ({
      id: t.id,
      title: t.title,
      aspect: t.aspect,
      state: t.state,
      assignment: t.assignment,
      attempts: (t.attempts ?? []).map((a) => ({ modelId: a.modelId, pool: a.pool, ok: a.ok, ms: a.ms })),
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

async function processTask(task) {
  task.status = 'running';
  task.startedAt = new Date().toISOString();

  const review = await reviewAction({
    toolId: task.type === 'self-improve' ? 'self-improve-task' : 'orchestrate-task',
    args: { title: task.title },
    description: task.prompt,
    effect: 'external',
  });

  if (review.verdict === 'block') {
    task.status = 'blocked';
    task.completedAt = new Date().toISOString();
    task.error = review.reason ?? 'Blocked by the Reviewer Gate.';
    if (task.issueNumber) {
      await commentOnIssue(task.issueNumber, `TITAN-Runner declined this task: ${redactString(task.error)}`);
    }
    return;
  }

  let result;
  try {
    result = await runOrchestration(task);
  } catch (err) {
    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.error = redactString(err instanceof Error ? err.message : String(err));
    log.error('task orchestration threw', { taskId: task.id, error: task.error });
    if (task.issueNumber) {
      await commentOnIssue(task.issueNumber, `TITAN-Runner hit an internal error on this task: ${task.error}`);
    }
    return;
  }

  task.runId = result.runId;
  writeRunRecord(task, result, Date.now() - Date.parse(task.startedAt));

  if (task.type === 'self-improve') {
    const outcome = await proposeSelfImprovement(task, result.synthesis);
    task.completedAt = new Date().toISOString();
    if (outcome.status === 'pr-open') {
      task.status = 'pr-open';
      task.prNumber = outcome.prNumber ?? null;
      task.prUrl = outcome.prUrl ?? null;
      if (task.issueNumber) {
        await commentOnIssue(
          task.issueNumber,
          `TITAN-Runner opened a draft pull request for this self-improvement task: ${outcome.prUrl ?? '(PR URL unavailable in dry-run)'}\n\nIt will not be merged automatically — CI (full test suite + the denylist gate) must pass, and a maintainer decides whether to merge.`,
        );
      }
    } else {
      task.status = 'failed';
      task.error = outcome.reason ?? outcome.status;
      if (task.issueNumber) {
        await commentOnIssue(task.issueNumber, `TITAN-Runner did not open a pull request for this task: ${redactString(task.error)}`);
      }
    }
    return;
  }

  task.status = result.ok ? 'complete' : 'failed';
  task.completedAt = new Date().toISOString();
  if (task.issueNumber) {
    await commentOnIssue(task.issueNumber, issueCommentFor(result));
    if (result.ok) await closeIssue(task.issueNumber);
  }
}

async function revisitSelfImprovePr(task) {
  const outcome = await checkSelfImprovePrStatus(task);
  if (outcome.status === 'closed-failed') {
    task.status = 'failed';
    task.error = 'CI failed on the self-improve PR; it has been closed.';
    task.completedAt = new Date().toISOString();
    if (task.issueNumber) {
      await commentOnIssue(task.issueNumber, `The pull request for this task failed CI and has been closed: ${task.prUrl ?? ''}`);
    }
  } else if (outcome.status === 'merged') {
    task.status = 'complete';
    task.completedAt = new Date().toISOString();
    if (task.issueNumber) {
      await commentOnIssue(task.issueNumber, `The pull request for this task was merged: ${task.prUrl ?? ''}`);
      await closeIssue(task.issueNumber);
    }
  }
  // 'still-open'/'unknown': leave as-is, checked again next pulse.
}

async function main() {
  const pulseStartedAt = Date.now();
  ensureStateFiles();

  const tasksState = loadTasksState();
  const heartbeat = loadHeartbeat();

  let tasksClaimed = 0;
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let pulseError = null;

  try {
    if (!config.dryRun) {
      const { added } = await syncIssuesIntoTasks(tasksState);
      if (added > 0) log.info('synced issues into task queue', { added });
    }

    if (process.env.TITAN_MANUAL_TASK && process.env.TITAN_MANUAL_TASK.trim().length > 0) {
      const id = addManualTask(tasksState, process.env.TITAN_MANUAL_TASK.trim());
      log.info('added manual task from workflow_dispatch input', { id });
    }

    // Revisit any self-improve tasks already awaiting a PR's CI result.
    for (const task of tasksState.tasks.filter((t) => t.status === 'pr-open')) {
      await revisitSelfImprovePr(task);
    }

    const pending = tasksState.tasks.filter((t) => t.status === 'pending');
    const claim = pending.slice(0, config.orchestrator.maxTasksPerPulse);
    for (const task of claim) {
      task.claimedAt = new Date().toISOString();
      tasksClaimed += 1;
    }

    for (const task of claim) {
      await processTask(task);
      if (task.status === 'complete' || task.status === 'pr-open') tasksCompleted += 1;
      else if (task.status === 'failed' || task.status === 'blocked') tasksFailed += 1;
    }

    // Persist the capability registry even on a pulse that claimed nothing,
    // so state/agents.json always reflects the current seed/observed table.
    capabilityRegistry.list();
    capabilityRegistry.save();

    const pruneResult = pruneRuns({ maxFiles: 60 });
    if (pruneResult.prunedCount > 0) log.info('pruned old run records into a digest', pruneResult);
  } catch (err) {
    pulseError = redactString(err instanceof Error ? err.message : String(err));
    log.error('pulse failed', { error: pulseError });
  }

  const durationMs = Date.now() - pulseStartedAt;
  saveTasksState(tasksState);
  saveHeartbeat({
    version: 1,
    lastPulseAt: new Date().toISOString(),
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

  console.log(
    JSON.stringify({
      pulse: 'complete',
      durationMs,
      tasksClaimed,
      tasksCompleted,
      tasksFailed,
      dryRun: config.dryRun,
      error: pulseError,
    }),
  );

  if (pulseError) process.exitCode = 1;
}

await main();
