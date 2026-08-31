/**
 * @file Minimal counting semaphore, extracted from TITAN's original
 * `backend/services/base.js` so `AgentAdapter.js` and the provider layer can
 * both depend on it without pulling in the rest of that file's SQLite/quota
 * machinery, none of which exists in this stateless repo.
 *
 * Callers past the limit queue in FIFO order rather than being rejected — a
 * burst of ready tasks at the start of a pulse should be slow, not failed.
 * `release()` hands its permit straight to the next waiter instead of
 * decrementing and letting waiters race for it, which keeps `inFlight` an
 * exact count at all times and makes over-admission impossible.
 */
export class Semaphore {
  #max;
  #inFlight = 0;
  /** @type {Array<() => void>} */
  #queue = [];

  /** @param {number} max */
  constructor(max) {
    this.#max = Math.max(1, Math.floor(Number(max) || 1));
  }

  get inFlight() {
    return this.#inFlight;
  }
  get queued() {
    return this.#queue.length;
  }
  get max() {
    return this.#max;
  }

  /** @returns {Promise<void>} Resolves once the caller holds a permit. */
  async acquire() {
    if (this.#inFlight < this.#max) {
      this.#inFlight += 1;
      return;
    }
    await new Promise((resolve) => this.#queue.push(() => resolve()));
  }

  release() {
    const next = this.#queue.shift();
    if (next) next();
    else this.#inFlight = Math.max(0, this.#inFlight - 1);
  }
}

export default Semaphore;
