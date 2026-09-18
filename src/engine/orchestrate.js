/**
 * @file One task's orchestration, made durable: plan → execute → synthesize,
 * with the task's checkpoint (`state/checkpoints/<taskId>.json`) written at
 * every step boundary and read back when a later pulse resumes the task.
 *
 * Resume rules: a checkpoint with a graph skips decomposition; sub-tasks the
 * checkpoint recorded as complete/failed are restored, not re-run; an
 * in-flight sub-task at the time of the crash keeps its attempt record and
 * runs again. The scheduler's drain hook parks the run when the pulse
 * budget is nearly spent, and the caller turns that into `waiting
 * (pulse-budget)` so the next pulse continues from exactly here.
 */
import { randomUUID } from 'node:crypto';
import { decompose } from '../orchestrator/decomposer.js';
import { Scheduler } from '../orchestrator/scheduler.js';
import { synthesize } from '../orchestrator/synthesizer.js';

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
 * @param {{
 *   task: object,
 *   checkpoint: object,
 *   pools: Record<string, object>,
 *   capabilityRegistry: object,
 *   events?: object|null,
 *   shouldDrain?: () => boolean,
 *   onCheckpoint?: (cp: object, reason: string) => Promise<void>|void,
 *   taskTimeoutMs?: number,
 *   maxSubtasks?: number,
 *   subtaskMaxAttempts?: number,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{ ok: boolean, drained: boolean, runId: string, graph: object, synthesis: object|null, tasksById: Map<string, object>, planned: boolean }>}
 */
export async function runOrchestration(args) {
  const { task, checkpoint: cp, pools, capabilityRegistry } = args;
  const events = args.events ?? null;
  const now = args.now ?? (() => new Date());
  const onCheckpoint = args.onCheckpoint ?? (() => {});
  const runId = cp.runId;

  // ---- plan -------------------------------------------------------------
  let planned = false;
  if (!cp.graph) {
    const started = performance.now();
    events?.append('plan.started', { taskId: task.id, runId });
    const graph = await decompose(task.prompt, { pools, maxTasks: args.maxSubtasks });
    if (task.routingHint && task.routingHint !== 'any') {
      for (const t of graph.tasks) t.routingHint = task.routingHint;
    }
    cp.graph = graph;
    cp.phase = 'executing';
    cp.subtasks = cp.subtasks ?? {};
    planned = true;
    events?.append('plan.finished', { taskId: task.id, runId, durationMs: Math.round(performance.now() - started), steps: graph.tasks.length, outcome: graph.tasks.length > 1 ? 'decomposed' : 'single-step' });
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
        events?.append('step.finished', {
          taskId: task.id, runId, stepId: event.taskId, outcome: event.state,
          agent: entry.assignment?.pool ?? null, provider: last?.modelId ?? entry.assignment?.modelId ?? null,
          attempt: (entry.attempts ?? []).length, durationMs: startedAt ? Math.round(performance.now() - startedAt) : null,
          calls: (entry.attempts ?? []).length, tokens: (entry.attempts ?? []).reduce((s, a) => s + (a.tokensUsed ?? 0), 0),
          failureClass: entry.error?.class ?? null, code: entry.error?.code ?? null,
        });
        cp.subtasks[event.taskId] = snapshotSubtask(entry);
        // Fire-and-forget is not acceptable for durability: the scheduler
        // awaits nothing here, so the checkpoint write is synchronous
        // (store.writeJson is sync) and only the git push is deferred.
        void onCheckpoint(cp, `step:${event.taskId}`);
      }
    },
  });

  const tasksById = await scheduler.run(graph, { resumeFrom: cp.subtasks ?? {} });

  if (scheduler.drained) {
    cp.phase = 'executing';
    await onCheckpoint(cp, 'drained');
    events?.append('run.parked', { taskId: task.id, runId, outcome: 'pulse-budget', pending: [...tasksById.values()].filter((t) => t.state === 'pending').length });
    return { ok: false, drained: true, runId, graph, synthesis: null, tasksById, planned };
  }

  // ---- synthesize -------------------------------------------------------
  cp.phase = 'executed';
  for (const [id, entry] of tasksById) cp.subtasks[id] = snapshotSubtask(entry);
  await onCheckpoint(cp, 'executed');
  const synthesis = await synthesize(graph, tasksById);
  const anyFailed = [...tasksById.values()].some((t) => t.state === 'failed' || t.state === 'malformed_output');
  events?.append('run.finished', { taskId: task.id, runId, outcome: anyFailed ? 'failed' : 'complete', steps: tasksById.size, files: synthesis.files.length, conflicts: synthesis.conflicts.length, at: now().toISOString() });
  return { ok: !anyFailed, drained: false, runId, graph, synthesis, tasksById, planned };
}

export function newCheckpoint(taskId) {
  return { version: 1, taskId, runId: randomUUID(), phase: 'planned', graph: null, subtasks: {}, sideEffects: {}, verification: null, remediations: 0, updatedAt: new Date().toISOString() };
}

export default runOrchestration;
