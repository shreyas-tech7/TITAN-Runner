/**
 * @file The task state machine — the one place a task's status may change.
 *
 * States (persisted in `state/tasks.json`, v2):
 *
 *   pending       queued and claimable
 *   running       leased by a pulse (lease.owner), work in progress
 *   waiting       parked with a reason and a wake time: backoff, provider,
 *                 quota, dependency, approval, budget, pulse-budget
 *   paused        parked by a human (`/titan pause`); has a TTL
 *   pr-open       self-improve PR opened; waits on CI / a human
 *   complete      verified done                                  (terminal)
 *   failed        attempted and lost, retriable by a human       (terminal)
 *   blocked       refused by the reviewer gate / policy          (terminal)
 *   cancelled     stopped by a human or a closed issue           (terminal)
 *   expired       deadline / TTL passed before completion        (terminal)
 *   dead-lettered gave up: attempts, loops, poison, lease churn  (terminal)
 *
 * Every non-terminal state has an exit that needs no model and no human:
 * pending → expired (TTL), running → reclaimed on lease expiry, waiting →
 * pending at wakeAt (or expired past its TTL), paused → expired past its
 * TTL, pr-open → cancelled past its TTL. `task/reconcile.js` drives those
 * timeouts at the top of every pulse.
 *
 * `transition()` is the only writer of `task.status`. It refuses an illegal
 * move, stamps timestamps, keeps a bounded history on the task, and emits a
 * `task.transition` event. Nothing else in the engine assigns `status`.
 */
import { TASK_STATUSES, WAIT_REASONS, PRIORITIES } from '../state/schema.js';

export { TASK_STATUSES, WAIT_REASONS, PRIORITIES };

export const TERMINAL_STATUSES = Object.freeze(['complete', 'failed', 'blocked', 'cancelled', 'expired', 'dead-lettered']);

/** From → allowed targets. Retry (`* → pending`) from a terminal state is a human action. */
export const TRANSITIONS = Object.freeze({
  pending: ['running', 'waiting', 'paused', 'cancelled', 'expired', 'dead-lettered'],
  running: ['complete', 'failed', 'blocked', 'cancelled', 'waiting', 'pr-open', 'dead-lettered', 'expired', 'pending'],
  waiting: ['pending', 'paused', 'cancelled', 'expired', 'dead-lettered'],
  paused: ['pending', 'cancelled', 'expired'],
  'pr-open': ['complete', 'failed', 'cancelled'],
  complete: ['pending'],
  failed: ['pending'],
  blocked: ['pending'],
  cancelled: ['pending'],
  expired: ['pending'],
  'dead-lettered': ['pending'],
});

const MAX_HISTORY = 40;

export class IllegalTransitionError extends Error {
  constructor(taskId, from, to) {
    super(`task ${taskId}: illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** @param {string} status */
export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** @param {string} from @param {string} to */
export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/**
 * @param {object} task Mutated in place.
 * @param {string} to
 * @param {{ reason?: string, by?: string, now?: () => Date, events?: { append: Function } | null, waitReason?: string|null, wakeAt?: string|null, error?: string|null, failure?: object|null, pulseId?: string }} [ctx]
 * @returns {object} The task.
 */
export function transition(task, to, ctx = {}) {
  const from = task.status;
  if (!TASK_STATUSES.includes(to)) throw new IllegalTransitionError(task.id, from, to);
  if (!canTransition(from, to)) throw new IllegalTransitionError(task.id, from, to);
  if (to === 'waiting' && !WAIT_REASONS.includes(ctx.waitReason)) {
    throw new Error(`task ${task.id}: waiting needs a reason from ${WAIT_REASONS.join(', ')}`);
  }
  const now = ctx.now ?? (() => new Date());
  const at = now().toISOString();

  task.status = to;
  if (to === 'waiting') {
    task.waitReason = ctx.waitReason;
    task.wakeAt = ctx.wakeAt ?? at;
  } else {
    task.waitReason = null;
    task.wakeAt = null;
  }
  if (to === 'running') {
    task.startedAt = task.startedAt ?? at;
    task.completedAt = null;
  }
  if (to === 'pending') {
    task.lease = null;
    if (from !== 'waiting' && from !== 'paused' && from !== 'running') {
      // A retry from a terminal state starts a fresh life: clear the record
      // of the previous one but keep attempts so a poison task still hits
      // its ceiling.
      task.claimedAt = null;
      task.startedAt = null;
      task.completedAt = null;
      task.runId = null;
      task.error = null;
      task.failure = null;
    }
  }
  if (isTerminal(to) || to === 'pr-open') {
    task.completedAt = at;
    task.lease = null;
  }
  if (ctx.error !== undefined) task.error = ctx.error;
  if (ctx.failure !== undefined) task.failure = ctx.failure;

  task.history = [...(task.history ?? []), { at, from, to, reason: ctx.reason ?? null }].slice(-MAX_HISTORY);
  ctx.events?.append('task.transition', {
    taskId: task.id, runId: task.runId ?? null, attempt: task.attempts ?? 0, from, to,
    reason: ctx.reason ?? null, by: ctx.by ?? 'engine', waitReason: task.waitReason, wakeAt: task.wakeAt,
    failureClass: ctx.failure?.class ?? null, outcome: isTerminal(to) ? to : null,
    activeMs: isTerminal(to) && Number.isFinite(task.usage?.wallMs) ? task.usage.wallMs : null,
  });
  return task;
}

/**
 * Effective priority for scheduling — the stored priority nudged by age
 * (starvation control), an approaching deadline, and how many other tasks
 * are waiting on this one. Higher runs first.
 * @param {object} task
 * @param {{ now?: () => Date, dependents?: number }} [ctx]
 * @returns {number}
 */
export function effectivePriority(task, ctx = {}) {
  const base = { low: 0, normal: 10, high: 20, urgent: 40 }[task.priority ?? 'normal'] ?? 10;
  const now = (ctx.now ?? (() => new Date()))().getTime();
  const ageHours = Math.max(0, (now - Date.parse(task.createdAt ?? now)) / 3_600_000);
  const ageBoost = Math.min(10, ageHours / 6); // +1 per 6 h, capped at +10 (≈2.5 days)
  let deadlineBoost = 0;
  if (task.deadline) {
    const hoursLeft = (Date.parse(task.deadline) - now) / 3_600_000;
    if (hoursLeft <= 1) deadlineBoost = 25;
    else if (hoursLeft <= 24) deadlineBoost = 10;
    else if (hoursLeft <= 72) deadlineBoost = 3;
  }
  const dependentsBoost = Math.min(10, (ctx.dependents ?? 0) * 2);
  return base + ageBoost + deadlineBoost + dependentsBoost;
}

export default { TRANSITIONS, TERMINAL_STATUSES, transition, canTransition, isTerminal, effectivePriority, IllegalTransitionError };
