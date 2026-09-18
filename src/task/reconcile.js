/**
 * @file The reconciliation sweep that opens every pulse. Nothing in memory
 * survives a pulse, so anything a dead pulse left in a non-terminal state
 * is found here, from `tasks.json` and the lease files alone:
 *
 *   - `running` with an expired (or missing) lease → the pulse that owned it
 *     died. attempts += 1; below the ceiling it goes back to `pending` with
 *     its checkpoint intact (the next claim resumes), at the ceiling it is
 *     dead-lettered.
 *   - `waiting` whose wakeAt has passed → `pending` (backoff over, provider
 *     cooldown over, dependency satisfied, pulse-budget continuation).
 *   - `waiting(dependency)` whose dependency failed → dead-lettered with the
 *     reason; whose dependency succeeded → pending.
 *   - `waiting(approval)` past the approval TTL → expired.
 *   - `paused` past the pause TTL → expired.
 *   - `pending` past its `expiresAt` (TTL) or `deadline` → expired.
 *   - `pr-open` past the PR TTL → cancelled (abandoned).
 *   - a checkpoint file with no live task → orphan, deleted.
 *   - a lease file with no live task → orphan, deleted.
 *
 * Every decision is a `transition()` (so it is legal and on the record) and
 * the sweep returns counts for the pulse event.
 */
import { transition, isTerminal } from './lifecycle.js';

const DEFAULTS = {
  approvalTtlMs: 7 * 86_400_000,
  pauseTtlMs: 7 * 86_400_000,
  prOpenTtlMs: 30 * 86_400_000,
};

/**
 * @param {object} tasksFile `{ tasks: [] }`, mutated in place.
 * @param {{ leases: import('./leases.js').LeaseManager, store: import('../state/store.js').StateStore, events?: object|null, now?: () => Date, ttl?: Partial<typeof DEFAULTS> }} ctx
 * @returns {{ reclaimed: number, deadLettered: number, woken: number, expired: number, orphansRemoved: number, dependencyFailed: number }}
 */
export function reconcile(tasksFile, ctx) {
  const now = ctx.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const ttl = { ...DEFAULTS, ...(ctx.ttl ?? {}) };
  const base = { now, events: ctx.events ?? null, by: 'reconcile' };
  const counts = { reclaimed: 0, deadLettered: 0, woken: 0, expired: 0, orphansRemoved: 0, dependencyFailed: 0 };
  const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));

  for (const task of tasksFile.tasks) {
    if (isTerminal(task.status)) continue;

    // Deadlines and TTLs apply to anything not yet finished.
    if (task.expiresAt && Date.parse(task.expiresAt) <= nowMs() && task.status !== 'pr-open') {
      transition(task, 'expired', { ...base, reason: 'ttl expired before completion', error: 'Expired: the task passed its TTL before it could finish.' });
      counts.expired += 1;
      ctx.leases.release(task.id);
      continue;
    }
    if (task.deadline && Date.parse(task.deadline) <= nowMs() && task.status !== 'pr-open') {
      transition(task, 'expired', { ...base, reason: 'deadline passed', error: 'Expired: the deadline passed before the task could finish.' });
      counts.expired += 1;
      ctx.leases.release(task.id);
      continue;
    }

    if (task.status === 'running') {
      const fileLease = ctx.leases.read(task.id);
      const live = fileLease && !ctx.leases.isExpired(fileLease);
      const mirrorLive = task.lease && !ctx.leases.isExpired(task.lease);
      if (live || mirrorLive) continue; // genuinely owned by a live pulse (an overlapping run)
      task.attempts = (task.attempts ?? 0) + 1;
      if (task.attempts >= (task.maxAttempts ?? 3)) {
        transition(task, 'dead-lettered', {
          ...base,
          reason: `lease expired ${task.attempts} times`,
          error: `Dead-lettered: the pulse running this task died ${task.attempts} times (attempt ceiling ${task.maxAttempts ?? 3}).`,
          failure: { class: 'poisoned', code: 'LEASE_CHURN', message: 'repeated pulse deaths while running this task', at: now().toISOString() },
        });
        counts.deadLettered += 1;
        ctx.store.deleteCheckpoint(task.id);
      } else {
        transition(task, 'pending', { ...base, reason: `lease expired (attempt ${task.attempts}); checkpoint retained` });
        counts.reclaimed += 1;
      }
      ctx.leases.release(task.id);
      continue;
    }

    if (task.status === 'waiting') {
      if (task.waitReason === 'dependency') {
        const deps = (task.dependsOn ?? []).map((id) => byId.get(id)).filter(Boolean);
        const failedDep = deps.find((d) => isTerminal(d.status) && d.status !== 'complete');
        if (failedDep) {
          transition(task, 'dead-lettered', {
            ...base,
            reason: `dependency ${failedDep.id} ended ${failedDep.status}`,
            error: `Dead-lettered: depends on ${failedDep.id}, which ended ${failedDep.status}.`,
            failure: { class: 'permanent', code: 'DEPENDENCY_FAILED', message: `dependency ${failedDep.id} ended ${failedDep.status}`, at: now().toISOString() },
          });
          counts.dependencyFailed += 1;
          continue;
        }
        const allDone = (task.dependsOn ?? []).every((id) => byId.get(id)?.status === 'complete');
        if (allDone) {
          transition(task, 'pending', { ...base, reason: 'dependencies complete' });
          counts.woken += 1;
        }
        continue;
      }
      if (task.waitReason === 'approval') {
        const since = Date.parse(task.wakeAt ?? task.createdAt);
        if (Number.isFinite(since) && nowMs() - since > ttl.approvalTtlMs) {
          transition(task, 'expired', { ...base, reason: 'approval never arrived', error: 'Expired: waited for approval past the approval TTL.' });
          counts.expired += 1;
        }
        continue;
      }
      if (task.wakeAt && Date.parse(task.wakeAt) <= nowMs()) {
        transition(task, 'pending', { ...base, reason: `woke from ${task.waitReason}` });
        counts.woken += 1;
      }
      continue;
    }

    if (task.status === 'paused') {
      const since = Date.parse(task.history?.at(-1)?.at ?? task.createdAt);
      if (Number.isFinite(since) && nowMs() - since > ttl.pauseTtlMs) {
        transition(task, 'expired', { ...base, reason: 'paused past the pause TTL', error: 'Expired: paused for longer than the pause TTL.' });
        counts.expired += 1;
      }
      continue;
    }

    if (task.status === 'pr-open') {
      const since = Date.parse(task.completedAt ?? task.createdAt);
      if (Number.isFinite(since) && nowMs() - since > ttl.prOpenTtlMs) {
        transition(task, 'cancelled', { ...base, reason: 'self-improve PR abandoned past its TTL', error: 'Cancelled: the pull request stayed open past the PR TTL without a decision.' });
        counts.expired += 1;
      }
    }
  }

  // Orphans: checkpoints and leases with no non-terminal task behind them.
  const live = new Set(tasksFile.tasks.filter((t) => !isTerminal(t.status)).map((t) => t.id));
  for (const id of ctx.store.listCheckpoints()) {
    if (!live.has(id)) {
      ctx.store.deleteCheckpoint(id);
      counts.orphansRemoved += 1;
    }
  }
  for (const task of tasksFile.tasks) {
    if (isTerminal(task.status) && ctx.leases.read(task.id)) {
      ctx.leases.release(task.id);
      counts.orphansRemoved += 1;
    }
  }

  return counts;
}

export default reconcile;
