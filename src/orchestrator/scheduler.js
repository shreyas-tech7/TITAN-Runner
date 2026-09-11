/**
 * @file Topological execution of a task graph across the three agent pools.
 *
 * Ownership split with router.js: router.js scores one task against a list
 * of candidate models and returns them ranked; this file decides WHICH task
 * gets first crack at Freebuff each tick (the "reserved for the
 * highest-complexity ready task" policy from the brief), drives retries,
 * propagates `blocked` state down a dependency chain, and emits a state-
 * change event on every transition so a caller (the SSE route, built in a
 * later wave) can stay live without polling internal state.
 *
 * Wave 5 (chain/self-repair) adds the two halves the brief's own name
 * promises:
 *
 *   - Chain: a task's prompt is built from its completed dependencies'
 *     ACTUAL outputs, not just the global sharedContext. "Frontend depends
 *     on api" now means the frontend agent sees what the api agent actually
 *     produced, so downstream work builds on real state instead of
 *     re-deriving it from a one-line description. (`#buildTaskContext`,
 *     called once per task per attempt — the dependency outputs are
 *     resolved from `tasksById` at that moment, and are always the
 *     completed state, never a stale or in-flight one.)
 *
 *   - Self-repair: every `execute()` call races a wall-clock deadline
 *     (`config.orchestrator.taskTimeoutMs`). A hung adapter call — DNS
 *     stall, a provider that accepts the request and never answers — can
 *     no longer leave a run stuck in "running" forever; it fails the task
 *     with a `TASK_TIMEOUT` error, the existing same-model/next-model retry
 *     policy gets a chance to rescue it, and dependents cascade to
 *     `blocked` the normal way. The deadline is a circuit breaker, not an
 *     expected runtime: the offline fixture path and every healthy call
 *     complete far inside it. (`#executeWithDeadline`.)
 *
 * Freebuff's hard 1-in-flight cap is enforced by a REAL semaphore — not a
 * convention here. It already lives inside `AgentAdapter`'s private `#gate`
 * (a `Semaphore(1)`, hardcoded in `freebuffAgent.js`'s constructor): every
 * call this scheduler makes to `freebuffAgent.execute()` awaits that gate
 * before doing any work, so even if the reservation policy below were ever
 * violated, a second concurrent Freebuff call would still queue behind the
 * first rather than run alongside it. The policy layer (excluding Freebuff
 * from every ready task except the reserved one) exists to make routing
 * *sensible*, not to make the cap *safe* — the cap is safe regardless,
 * because it is a real semaphore one layer down (`src/lib/semaphore.js`).
 */

import { rankModels } from './router.js';
import { COMPLEXITY_LEVELS, isTaskState } from './taxonomy.js';
import { config } from '../config.js';

/** Same-model retry once, then one more attempt on the next-best model. */
const MAX_ATTEMPTS = 3;

/**
 * Per-dependency output cap when assembling a task's context (Wave 5
 * chain). Dependencies' outputs are real LLM output — unbounded by nature —
 * and the context window is not; slicing keeps a long-winded upstream task
 * from crowding out the task's own description.
 */
const MAX_DEP_OUTPUT_CHARS = 8000;

/**
 * Hard cap on the total dependency-output block per task, so a task with
 * many wide dependencies still fits beside its own description.
 */
const MAX_DEP_BLOCK_CHARS = 24000;

/**
 * @typedef {object} SchedulerTask
 * @property {string} id
 * @property {string} title
 * @property {string} aspect
 * @property {string} description
 * @property {string[]} dependsOn
 * @property {'low'|'medium'|'high'} estimatedComplexity
 * @property {string} deliverable
 * @property {import('./taxonomy.js').TASK_STATES[number]} state
 * @property {{modelId: string, pool: string, reason: string}|null} assignment
 * @property {Array<{modelId: string, pool: string, ok: boolean, ms: number, error: object|null}>} attempts
 * @property {string|null} output
 * @property {1|2|3|null} [outputTier] Which `outputParser.js` tier parsed
 *   `output` into files — set once synthesis runs, absent before then (the
 *   scheduler itself never sets this).
 * @property {{code: string, message: string}|null} error
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {1|2|3|null} [envelopeTier] Set by synthesizer.js after the
 *   scheduler finishes — absent (not just `null`) beforehand.
 */

/**
 * @param {import('./taxonomy.js').COMPLEXITY_LEVELS[number]} level
 * @returns {number}
 */
function complexityRank(level) {
  const idx = COMPLEXITY_LEVELS.indexOf(level);
  return idx === -1 ? 0 : idx;
}

export class Scheduler {
  /**
   * @param {{
   *   pools: Record<string, import('../../agents/AgentAdapter.js').AgentAdapter>,
   *   capabilityRegistry: import('./capabilityRegistry.js').CapabilityRegistry,
   *   onEvent?: (event: object) => void,
   *   taskTimeoutMs?: number,
   * }} init
   */
  constructor({ pools, capabilityRegistry, onEvent = () => {}, taskTimeoutMs }) {
    this.pools = pools;
    this.capabilityRegistry = capabilityRegistry;
    this.onEvent = onEvent;
    // Wave 5 self-repair: per-task wall-clock deadline, injected so tests
    // can prove the timeout path with a tiny value instead of waiting out
    // the production default. Defaults to config when not given.
    this.taskTimeoutMs = taskTimeoutMs ?? config.orchestrator.taskTimeoutMs;

    /** @type {Map<string, SchedulerTask>} */
    this.tasksById = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.inFlight = new Map();
    /** @type {Map<string, AbortController>} */
    this.controllers = new Map();
    /** @type {Array<{modelId: string, pool: string}>} */
    this.candidateModels = [];
    this.sharedContext = '';
    this.cancelled = false;
    this.runState = 'pending';
  }

  /**
   * Run a full task graph to completion (every task terminal: complete,
   * failed, blocked, or cancelled). Resolves once nothing more can run.
   * @param {import('./decomposer.js').TaskGraph} graph
   * @returns {Promise<Map<string, SchedulerTask>>}
   */
  async run(graph) {
    this.sharedContext = graph.sharedContext ?? '';
    this.candidateModels = await this.#resolveCandidateModels();

    for (const task of graph.tasks) {
      /** @type {SchedulerTask} */
      const entry = {
        ...task,
        state: 'pending',
        assignment: null,
        attempts: [],
        output: null,
        error: null,
        startedAt: null,
        completedAt: null,
      };
      this.tasksById.set(task.id, entry);
    }

    this.#emit({ type: 'run-state', state: 'running' });
    this.runState = 'running';

    await this.#loop();

    const anyFailed = [...this.tasksById.values()].some((t) => t.state === 'failed');
    const finalState = this.cancelled ? 'cancelled' : anyFailed ? 'failed' : 'complete';
    this.runState = finalState;
    this.#emit({ type: 'run-state', state: finalState });

    return this.tasksById;
  }

  /** Stop dispatching new tasks; abort every in-flight call; mark the rest cancelled. */
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const controller of this.controllers.values()) {
      controller.abort(new Error('Run was cancelled'));
    }
    for (const task of this.tasksById.values()) {
      if (task.state === 'pending' || task.state === 'queued') {
        this.#setState(task, 'cancelled');
      }
    }
  }

  /**
   * Manual retry of one failed/blocked task, per
   * `POST /api/orchestrate/:runId/task/:id/retry` (wired in a later wave).
   * Re-arms the task (and anything downstream that was only `blocked`
   * because of it) and dispatches it again if the scheduler isn't cancelled.
   * @param {string} taskId
   * @returns {boolean} Whether a retry was actually started.
   */
  retryTask(taskId) {
    if (this.cancelled) return false;
    const task = this.tasksById.get(taskId);
    if (!task || !['failed', 'blocked', 'malformed_output'].includes(task.state)) return false;

    task.attempts = [];
    task.error = null;
    this.#setState(task, 'pending');
    // Anything downstream that was blocked purely because of this task may
    // now become ready again on the next tick; #loop() re-derives that from
    // dependsOn state on every pass, so nothing else needs touching here.
    void this.#dispatchReady();
    return true;
  }

  /* ---- internals ------------------------------------------------------- */

  /** @returns {Promise<Array<{modelId: string, pool: string}>>} */
  async #resolveCandidateModels() {
    const lists = await Promise.all(
      Object.entries(this.pools ?? {}).map(async ([poolName, adapter]) => {
        try {
          const models = await adapter.listModels();
          return models.map((m) => ({ modelId: m.modelId, pool: m.pool ?? poolName }));
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
  }

  /** Main dispatch loop: propagate blocked state, dispatch ready tasks, wait, repeat. */
  async #loop() {
    while (!this.cancelled) {
      this.#propagateBlocked();

      const ready = this.#readyTasks();
      const dispatched = this.#dispatchReady(ready);

      if (dispatched === 0 && this.inFlight.size === 0) break;

      if (this.inFlight.size > 0) {
        await Promise.race([...this.inFlight.values()]);
      }
    }
  }

  /** Any pending task whose dependencies are ALL complete. */
  #readyTasks() {
    return [...this.tasksById.values()].filter(
      (t) =>
        t.state === 'pending' &&
        t.dependsOn.every((depId) => this.tasksById.get(depId)?.state === 'complete'),
    );
  }

  /** Mark pending tasks `blocked` when any dependency has failed/blocked/cancelled. Cascades to a fixed point. */
  #propagateBlocked() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasksById.values()) {
        if (task.state !== 'pending') continue;
        const blockedByDep = task.dependsOn.some((depId) => {
          const dep = this.tasksById.get(depId);
          return dep && ['failed', 'blocked', 'cancelled'].includes(dep.state);
        });
        if (blockedByDep) {
          this.#setState(task, 'blocked');
          changed = true;
        }
      }
    }
  }

  /**
   * Assign a model to every ready task and start it. Freebuff is excluded
   * from every ready task except the highest-`estimatedComplexity` one this
   * tick — see the file header.
   * @param {SchedulerTask[]} [ready]
   * @returns {number} How many tasks were dispatched.
   */
  #dispatchReady(ready = this.#readyTasks()) {
    if (ready.length === 0) return 0;

    const sortedByComplexity = [...ready].sort(
      (a, b) => complexityRank(b.estimatedComplexity) - complexityRank(a.estimatedComplexity),
    );
    const freebuffReservedId = sortedByComplexity[0]?.id ?? null;

    let dispatched = 0;
    for (const task of ready) {
      const excludePools = task.id === freebuffReservedId ? [] : ['freebuff'];
      const ranked = rankModels(task, this.candidateModels, {
        pools: this.pools,
        capabilityRegistry: this.capabilityRegistry,
        excludePools,
      });
      const assignment = ranked[0] ?? null;

      if (!assignment) {
        this.#setState(task, 'failed', {
          error: { code: 'NO_CANDIDATE', message: 'No candidate model available for this task.' },
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      task.assignment = { modelId: assignment.modelId, pool: assignment.pool, reason: assignment.reason };
      this.#setState(task, 'queued');
      this.#dispatch(task, ranked);
      dispatched += 1;
    }
    return dispatched;
  }

  /**
   * @param {SchedulerTask} task
   * @param {import('./router.js').RankedCandidate[]} ranked Full ranking at
   *   dispatch time, so a same-run retry to "the next-best model" doesn't
   *   need to re-score from scratch.
   */
  #dispatch(task, ranked) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.#setState(task, 'running', { startedAt: new Date().toISOString() });

    const promise = this.#runWithRetry(task, ranked, controller.signal).then((result) => {
      this.inFlight.delete(task.id);
      this.controllers.delete(task.id);

      // `this.cancelled` (not just this task's own controller.signal.aborted)
      // is checked first: the offline fixture path's sleep() does not
      // observe an AbortSignal at all (see freebuffAgent.js/opencodeAgent.js
      // #offlineExecute), so a task can resolve `ok: true` a few ms after
      // cancel() ran. Once cancel() has been called, nothing should still
      // land as freshly `complete` — a coincidental success race must not
      // override the user's cancel.
      if (this.cancelled) {
        this.#setState(task, 'cancelled', {
          error: result.error ?? { code: 'CANCELLED', message: 'Run was cancelled' },
          completedAt: new Date().toISOString(),
        });
      } else if (result.ok) {
        this.#setState(task, 'complete', {
          output: result.output,
          error: null,
          completedAt: new Date().toISOString(),
        });
      } else {
        this.#setState(task, 'failed', {
          error: result.error,
          completedAt: new Date().toISOString(),
        });
      }
    });

    this.inFlight.set(task.id, promise);
  }

  /**
   * Wave 5 chain: assemble the prompt context a task actually receives —
   * the run's sharedContext plus the completed outputs of every task this
   * one depends on. Previously a task got only `sharedContext` and had to
   * re-derive what its dependencies produced from a one-line description;
   * "frontend depends on api" now means the frontend agent sees the api
   * agent's real output. Bounded per dependency and in total so a
   * long-winded upstream task cannot crowd out the task's own description.
   * @param {SchedulerTask} task
   * @returns {string}
   */
  #buildTaskContext(task) {
    if (task.dependsOn.length === 0) return this.sharedContext;
    const parts = [];
    let budget = MAX_DEP_BLOCK_CHARS;
    for (const depId of task.dependsOn) {
      const dep = this.tasksById.get(depId);
      if (!dep || dep.state !== 'complete' || typeof dep.output !== 'string' || dep.output.length === 0) {
        continue;
      }
      if (budget <= 0) break;
      const slice = dep.output.slice(0, Math.min(MAX_DEP_OUTPUT_CHARS, budget));
      parts.push(`--- Output of completed upstream task "${dep.id}" (${dep.title}) ---\n${slice}`);
      budget -= slice.length;
    }
    if (parts.length === 0) return this.sharedContext;
    const header =
      'The following are the actual outputs of the tasks this task depends on. ' +
      'Build on them directly rather than re-deriving their content from the shared context.';
    return this.sharedContext
      ? `${this.sharedContext}\n\n${header}\n\n${parts.join('\n\n')}`
      : `${header}\n\n${parts.join('\n\n')}`;
  }

  /**
   * Wave 5 self-repair: one `execute()` call raced against a wall-clock
   * deadline. A hung adapter call (DNS stall, a provider that accepts the
   * request and never answers) previously left the run stuck in "running"
   * forever — nothing ever aborted except cancel(). Now the deadline
   * aborts the call, and the scheduler treats it like any other failed
   * attempt: the retry policy below gets a shot at a fresh model, and if
   * every attempt times out the task fails with `TASK_TIMEOUT`, cascading
   * `blocked` to its dependents the normal way.
   *
   * The signal handed to the adapter is a per-attempt CHILD controller, not
   * the run-level signal: aborting it on a timeout must not poison the
   * shared per-task signal, or the next retry attempt would read
   * `signal.aborted` and return CANCELLED before ever reaching the model.
   * The child forwards the run-level abort (a real cancel()) so an
   * in-flight attempt still cancels promptly; a timed-out attempt aborts
   * only its own child, leaving the parent clean for the retry.
   * @param {SchedulerTask} task
   * @param {import('../../agents/AgentAdapter.js').AgentAdapter} adapter
   * @param {string} context
   * @param {{ modelId: string, signal: AbortSignal }} options
   * @returns {Promise<import('../../agents/AgentAdapter.js').ExecuteResult>}
   */
  async #executeWithDeadline(task, adapter, context, { modelId, signal }) {
    const attemptController = new AbortController();
    const forwardAbort = () => attemptController.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    /** @type {Promise<import('../../agents/AgentAdapter.js').ExecuteResult>} */
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          output: null,
          modelId,
          tokensUsed: null,
          ms: this.taskTimeoutMs,
          error: {
            code: 'TASK_TIMEOUT',
            message: `Task "${task.id}" exceeded the ${this.taskTimeoutMs}ms wall-clock deadline.`,
          },
        });
      }, this.taskTimeoutMs);
      // Never let a pending deadline keep the process alive.
      timer.unref?.();
    });
    try {
      return await Promise.race([
        adapter.execute(task, context, { modelId, signal: attemptController.signal }),
        timeout,
      ]);
    } finally {
      signal.removeEventListener('abort', forwardAbort);
      // If the deadline won the race, the adapter's own promise may still be
      // pending in the background (e.g. a fetch that ignores AbortSignal).
      // Abort the child explicitly so a signal-honouring adapter cancels its
      // network call; the run-level signal stays untouched for the next
      // attempt. Aborting an already-settled attempt is a harmless no-op.
      attemptController.abort();
    }
  }

  /**
   * Up to MAX_ATTEMPTS: same model twice, then the next-best model once.
   * Records an observation in the capability registry after every attempt,
   * not just the final one — that is what lets routing improve over time.
   * @param {SchedulerTask} task
   * @param {import('./router.js').RankedCandidate[]} ranked
   * @param {AbortSignal} signal
   * @returns {Promise<{ok: boolean, output: string|null, modelId: string, error: object|null}>}
   */
  async #runWithRetry(task, ranked, signal) {
    let current = ranked[0];
    /** @type {import('../../agents/AgentAdapter.js').ExecuteResult|null} */
    let lastResult = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) {
        return {
          ok: false,
          output: null,
          modelId: current.modelId,
          error: { code: 'CANCELLED', message: 'Run was cancelled' },
        };
      }

      const adapter = this.pools[current.pool];
      const context = this.#buildTaskContext(task);
      const result = await this.#executeWithDeadline(task, adapter, context, {
        modelId: current.modelId,
        signal,
      });

      task.attempts.push({
        modelId: current.modelId,
        pool: current.pool,
        ok: result.ok,
        ms: result.ms,
        tokensUsed: result.tokensUsed ?? null,
        error: result.error,
      });
      this.capabilityRegistry.recordObservation(current.modelId, task.aspect, {
        success: result.ok,
        ms: result.ms,
      });

      if (result.ok) {
        return { ok: true, output: result.output, modelId: current.modelId, error: null };
      }
      lastResult = result;
      if (signal.aborted) break;

      // Attempt 0 failed -> retry the SAME model once (attempt 1 is a no-op
      // reassignment, `current` is unchanged). Attempt 1 failed -> switch to
      // the next-best DIFFERENT model for the final attempt.
      if (attempt === 1) {
        const next = ranked.find((r) => r.modelId !== ranked[0].modelId);
        if (!next) break; // nothing else to try — stop early rather than repeat attempt 0's model a 3rd time
        current = next;
      }
    }

    return {
      ok: false,
      output: null,
      modelId: current.modelId,
      error: lastResult?.error ?? { code: 'UPSTREAM_ERROR', message: 'All attempts failed.' },
    };
  }

  /**
   * @param {SchedulerTask} task
   * @param {Partial<SchedulerTask>} [patch]
   */
  #setState(task, state, patch = {}) {
    if (!isTaskState(state)) return;
    Object.assign(task, patch, { state });
    this.#emit({ type: 'task-state', taskId: task.id, state, task: { ...task } });
  }

  /** @param {object} event */
  #emit(event) {
    try {
      this.onEvent(event);
    } catch {
      // A subscriber's own error must never break the scheduler loop.
    }
  }
}

export default Scheduler;
