/**
 * @file The pulse's time budget. A GitHub Actions job is hard-killed at the
 * workflow's `timeout-minutes` (10 here) and nothing that was not
 * checkpointed survives. The budget is the in-process version of that
 * ceiling, set lower on purpose (`TITAN_PULSE_BUDGET_MS`, default 7 min)
 * so the engine always has time to stop taking work, write the last
 * checkpoint, and let the workflow commit and push before the kill.
 *
 * Phases the budget answers for:
 *   - `canClaim()`: is there enough left to start another task at all?
 *   - `shouldDrain()`: stop dispatching new sub-tasks; finish in-flight ones.
 *   - `remainingMs()`: for events and the summary.
 */

export const DEFAULT_BUDGET_MS = 7 * 60_000;
/** Below this much remaining, no new task is claimed. */
export const DEFAULT_CLAIM_RESERVE_MS = 90_000;
/** Below this much remaining, in-flight work drains and the task parks. */
export const DEFAULT_DRAIN_RESERVE_MS = 45_000;

export class PulseBudget {
  /**
   * @param {{ budgetMs?: number, claimReserveMs?: number, drainReserveMs?: number, now?: () => number }} [init]
   */
  constructor(init = {}) {
    this.budgetMs = init.budgetMs ?? DEFAULT_BUDGET_MS;
    this.claimReserveMs = Math.min(init.claimReserveMs ?? DEFAULT_CLAIM_RESERVE_MS, this.budgetMs / 2);
    this.drainReserveMs = Math.min(init.drainReserveMs ?? DEFAULT_DRAIN_RESERVE_MS, this.budgetMs / 3);
    this.now = init.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.drainRequested = false;
  }

  elapsedMs() {
    return this.now() - this.startedAt;
  }

  remainingMs() {
    return Math.max(0, this.budgetMs - this.elapsedMs());
  }

  canClaim() {
    return !this.drainRequested && this.remainingMs() > this.claimReserveMs;
  }

  shouldDrain() {
    return this.drainRequested || this.remainingMs() <= this.drainReserveMs;
  }

  /** An external signal (drain control, kill switch) to stop taking work now. */
  requestDrain() {
    this.drainRequested = true;
  }

  snapshot() {
    return { budgetMs: this.budgetMs, elapsedMs: this.elapsedMs(), remainingMs: this.remainingMs(), draining: this.shouldDrain() };
  }
}

export default PulseBudget;
