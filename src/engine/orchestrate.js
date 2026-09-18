/**
 * @file One task's orchestration, made durable: plan → execute → synthesize,
 * with the task's checkpoint (`state/checkpoints/<taskId>.json`) written at
 * every step boundary and read back when a later pulse resumes the task.
 *
 * Resume rules: a checkpoint with a graph skips decomposition; sub-tasks the
 * checkpoint recorded as complete (or failed for good) are restored, not
 * re-run; a sub-task that was parked (its provider was down or out of
 * quota) or in flight when the previous pulse ended keeps its attempt
 * record and runs again. The scheduler's drain hook parks the run when the
 * pulse budget is nearly spent, and the caller turns that into
 * `waiting(pulse-budget)`; a parked sub-task turns into `waiting(provider |
 * quota)` with the wake time the retry policy chose.
 *
 * Usage (model calls, tokens, active wall time) is accounted in the
 * checkpoint (`usage`, plus `stepUsage` per step) so a task's budget
 * survives across pulses; the engine adds the live counts at every persist.
 */
import { randomUUID } from 'node:crypto';
import { decompose } from '../orchestrator/decomposer.js';
import { Scheduler } from '../orchestrator/scheduler.js';
import { synthesize } from '../orchestrator/synthesizer.js';
import { classifyFailure } from '../reliability/failures.js';
import { parkFor } from '../reliability/retryPolicy.js';

/** Per-sub-task output kept in the checkpoint (the run record keeps its own preview). */
const MAX_CHECKPOINT_OUTPUT_CHARS = 16_000;

/**
 * @param {object} taskEntry A scheduler task entry.
 */
export function snapshotSubtask(taskEntry) {
  return {
    state: taskEntry.state,
    assignment: taskEntry.assignment ?? null,
    attempts: (taskEntry.attempts ?? []).map((a) => ({ modelId: a.modelId, pool: a.pool, ok: a.ok, ms: a.ms, tokensUsed: a.tokensUsed ?? null, error: a.error ?? null })),
    output: typeof taskEntry.output === 'string' ? taskEntry.output.slice(0, MAX_CHECKPOINT_OUTPUT_CHARS) : null,
    error: taskEntry.error ?? null,
    startedAt: taskEntry.startedAt ?? null,
    completedAt: taskEntry.completedAt ?? null,
  };
}

/**
 * A task's accumulated usage: the live totals the engine keeps in
 * `cp.usage` (every adapter call, every pulse), falling back to the sum of
 * the per-step table for a checkpoint written before `usage` existed.
 * @returns {{ calls: number, tokens: number, wallMs: number }}
 */
export function usageOf(cp) {
  if (cp?.usage && Number.isFinite(cp.usage.calls)) {
    return { calls: cp.usage.calls, tokens: cp.usage.tokens ?? 0, wallMs: cp.usage.wallMs ?? 0 };
  }
  let calls = 0;
  let tokens = 0;
  for (const u of Object.values(cp?.stepUsage ?? {})) {
    calls += u.calls ?? 0;
    tokens += u.tokens ?? 0;
  }
  return { calls, tokens, wallMs: 0 };
}

/**
 * @param {{
 *   task: object,
 *   checkpoint: object,
 *   pools: Record<string, object>,
 *   capabilityRegistry: object,
 *   events?: object|null,
 *   shouldDrain?: () => boolean,
 *   onCheckpoint?: (cp: object, reason: string) => Promise<void>|void,
 *   onAttempt?: (event: object) => void,
 *   taskTimeoutMs?: number,
 *   maxSubtasks?: number,
 *   subtaskMaxAttempts?: number,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{ ok: boolean, drained: boolean, parked: {reason: string, wakeInMs: number, why: string, failureClass: string|null, code: string|null}|null, runId: string, graph: object, synthesis: object|null, tasksById: Map<string, object>, planned: boolean }>}
 */
export async function runOrchestration(args) {
  const { task, checkpoint: cp, pools, capabilityRegistry } = args;
  const events = args.events ?? null;
  const now = args.now ?? (() => new Date());
  const onCheckpoint = args.onCheckpoint ?? (() => {});
  const runId = cp.runId;
  cp.stepUsage = cp.stepUsage ?? {};

  // ---- plan -------------------------------------------------------------
  let planned = false;
  if (!cp.graph) {
    const started = performance.now();
    events?.append('plan.started', { taskId: task.id, runId, attempt: (cp.stepUsage.plan?.calls ?? 0) + 1 });
    let graph;
    try {
      graph = await decompose(task.prompt, { pools, maxTasks: args.maxSubtasks });
    } catch (err) {
      // The provider side is down / limited / out of quota: the plan is not
      // degraded, the task waits (same ladder a parked step uses).
      const failure = classifyFailure(err);
      const parked = parkFor(failure, task.parks ?? 0);
      if (!parked) throw err;
      cp.stepUsage.plan = { calls: (cp.stepUsage.plan?.calls ?? 0) + 1, tokens: 0 };
      await onCheckpoint(cp, 'plan-parked');
      events?.append('plan.parked', { taskId: task.id, runId, durationMs: Math.round(performance.now() - started), failureClass: failure.class, code: failure.code, outcome: parked.reason });
      events?.append('run.parked', { taskId: task.id, runId, outcome: parked.reason, wakeInMs: parked.wakeInMs, steps: ['plan'], why: parked.why, failureClass: failure.class });
      return { ok: false, drained: false, parked: { ...parked, failureClass: failure.class, code: failure.code }, runId, graph: null, synthesis: null, tasksById: new Map(), planned: false };
    }
    if (task.routingHint && task.routingHint !== 'any') {
      for (const t of graph.tasks) t.routingHint = task.routingHint;
    }
    cp.graph = graph;
    cp.phase = 'executing';
    cp.subtasks = cp.subtasks ?? {};
    cp.stepUsage.plan = { calls: (cp.stepUsage.plan?.calls ?? 0) + 1, tokens: 0 };
    planned = true;
    events?.append('plan.finished', { taskId: task.id, runId, durationMs: Math.round(performance.now() - started), steps: graph.tasks.length, calls: cp.stepUsage.plan.calls, outcome: graph.tasks.length > 1 ? 'decomposed' : 'single-step' });
    await onCheckpoint(cp, 'planned');
  }

  // ---- execute ----------------------------------------------------------
  const graph = cp.graph;
  const stepStarted = new Map();
  const scheduler = new Scheduler({
    pools,
    capabilityRegistry,
    taskTimeoutMs: args.taskTimeoutMs,
    shouldDrain: args.shouldDrain ?? (() => false),
    maxAttempts: args.subtaskMaxAttempts,
    onEvent: (event) => {
      if (event.type === 'attempt-finished') {
        args.onAttempt?.(event);
        return;
      }
      if (event.type === 'attempt-failed') {
        events?.append('step.attempt-failed', { taskId: task.id, runId, stepId: event.taskId, provider: event.modelId, attempt: event.attempt, failureClass: event.failure?.class ?? null, code: event.failure?.code ?? null, outcome: 'failed', retryAfterMs: event.retryAfterMs ?? null });
        return;
      }
      if (event.type === 'retry-decision') {
        events?.append('step.retry', { taskId: task.id, runId, stepId: event.taskId, provider: event.modelId, failureClass: event.failureClass, action: event.action, delayMs: event.delayMs, why: event.why });
        return;
      }
      if (event.type !== 'task-state') return;
      const entry = event.task;
      if (event.state === 'running') {
        stepStarted.set(event.taskId, performance.now());
        events?.append('step.started', { taskId: task.id, runId, stepId: event.taskId, agent: entry.assignment?.pool ?? null, provider: entry.assignment?.modelId ?? null, attempt: (entry.attempts ?? []).length + 1, resumed: Boolean(entry.resumed) });
        return;
      }
      if (['complete', 'failed', 'blocked', 'cancelled'].includes(event.state)) {
        if (entry.resumed && event.state === entry.state && !stepStarted.has(event.taskId)) return; // restored from checkpoint, not run
        const startedAt = stepStarted.get(event.taskId);
        const last = (entry.attempts ?? []).at(-1);
        const tokens = (entry.attempts ?? []).reduce((s, a) => s + (a.tokensUsed ?? 0), 0);
        events?.append('step.finished', {
          taskId: task.id, runId, stepId: event.taskId, outcome: event.state,
          agent: entry.assignment?.pool ?? null, provider: last?.modelId ?? entry.assignment?.modelId ?? null,
          attempt: (entry.attempts ?? []).length, durationMs: startedAt ? Math.round(performance.now() - startedAt) : null,
          calls: (entry.attempts ?? []).length, tokens,
          failureClass: entry.error?.class ?? null, code: entry.error?.code ?? null, parked: Boolean(entry.error?.park),
        });
        cp.subtasks[event.taskId] = snapshotSubtask(entry);
        cp.stepUsage[event.taskId] = { calls: (entry.attempts ?? []).length, tokens };
        // The checkpoint file write is synchronous (store.writeJson); only
        // the git push is deferred, so durability does not depend on await.
        void onCheckpoint(cp, `step:${event.taskId}`);
      }
    },
  });

  const tasksById = await scheduler.run(graph, { resumeFrom: cp.subtasks ?? {} });

  if (scheduler.drained) {
    cp.phase = 'executing';
    await onCheckpoint(cp, 'drained');
    events?.append('run.parked', { taskId: task.id, runId, outcome: 'pulse-budget', pending: [...tasksById.values()].filter((t) => t.state === 'pending').length });
    return { ok: false, drained: true, parked: null, runId, graph, synthesis: null, tasksById, planned };
  }

  // A step the retry policy parked (provider down / rate limited / out of
  // quota) means "come back later", not "the task failed".
  const parkedSteps = [...tasksById.values()].filter((t) => t.state === 'failed' && t.error?.park);
  if (parkedSteps.length > 0) {
    const wakeInMs = Math.max(...parkedSteps.map((t) => t.error.park.wakeInMs ?? 0));
    const reason = parkedSteps.some((t) => t.error.park.reason === 'quota') ? 'quota' : 'provider';
    cp.phase = 'executing';
    for (const [id, entry] of tasksById) cp.subtasks[id] = snapshotSubtask(entry);
    await onCheckpoint(cp, 'parked');
    events?.append('run.parked', { taskId: task.id, runId, outcome: reason, wakeInMs, steps: parkedSteps.map((t) => t.id), why: parkedSteps[0].error.park.why, failureClass: parkedSteps[0].error.class ?? null });
    return { ok: false, drained: false, parked: { reason, wakeInMs, why: parkedSteps[0].error.park.why, failureClass: parkedSteps[0].error.class ?? null, code: parkedSteps[0].error.code ?? null }, runId, graph, synthesis: null, tasksById, planned };
  }

  // ---- synthesize -------------------------------------------------------
  cp.phase = 'executed';
  for (const [id, entry] of tasksById) cp.subtasks[id] = snapshotSubtask(entry);
  await onCheckpoint(cp, 'executed');
  const synthesis = await synthesize(graph, tasksById);
  const anyFailed = [...tasksById.values()].some((t) => t.state === 'failed' || t.state === 'malformed_output');
  const usage = usageOf(cp);
  events?.append('run.finished', { taskId: task.id, runId, outcome: anyFailed ? 'failed' : 'complete', steps: tasksById.size, files: synthesis.files.length, conflicts: synthesis.conflicts.length, calls: usage.calls, tokens: usage.tokens, at: now().toISOString() });
  return { ok: !anyFailed, drained: false, parked: null, runId, graph, synthesis, tasksById, planned };
}

export function newCheckpoint(taskId) {
  return { version: 1, taskId, runId: randomUUID(), phase: 'planned', graph: null, subtasks: {}, sideEffects: {}, verification: null, remediations: 0, stepUsage: {}, usage: { calls: 0, tokens: 0, wallMs: 0 }, updatedAt: new Date().toISOString() };
}

export default runOrchestration;
