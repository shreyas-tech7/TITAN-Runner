/**
 * @file The routing rules of contract v1, for the Runner router (RO1, RO2).
 *
 *   - Skip a provider that is down, not_configured, or exhausted.
 *   - Rank degraded providers last.
 *   - Trip a circuit breaker after 3 straight failures. Probe again after 15 minutes.
 *   - When nothing is available, queue the task and show why. The registry parks the task with the reasons.
 *
 * The data comes from the public mirrors `state/ops/health.json` and `state/ops/quota.json`, which sit in the checkout
 * and cost nothing to read. A mirror entry that is too old is ignored: no information is not a reason to skip.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BREAKER = Object.freeze({ failures: 3, probeAfterMs: 15 * 60_000 });
/** The canary runs each night. An answer older than this says nothing about now. */
export const HEALTH_MAX_AGE_MS = 36 * 3_600_000;

const readJson = (path) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
};

export class OpsGate {
  /**
   * @param {{ health?: object|null, quota?: object|null, now?: () => Date, modelOf?: (id: string) => string|null, failureRecord?: (id: string) => { consecutiveFailures?: number, lastCheckedAt?: string|null }|null }} [init]
   */
  constructor(init = {}) {
    this.health = init.health?.providers ?? {};
    this.quota = init.quota?.providers ?? {};
    this.now = init.now ?? (() => new Date());
    this.modelOf = init.modelOf ?? (() => null);
    this.failureRecord = init.failureRecord ?? (() => null);
  }

  /** Read the mirrors of a state folder. */
  static fromState(stateDir, init = {}) {
    return new OpsGate({ ...init, health: readJson(join(stateDir, 'ops', 'health.json')), quota: readJson(join(stateDir, 'ops', 'quota.json')) });
  }

  #entries(table, id) {
    const key = String(id);
    const byModel = table[key] ?? table[key.replace(/_\d+$/, '')] ?? null;
    if (!byModel) return [];
    const model = this.modelOf(id);
    if (model && byModel[model]) return [byModel[model]];
    return Object.values(byModel);
  }

  /** The canary status of a provider: healthy, degraded, down, not_configured, or null when unknown or too old. */
  status(id) {
    const fresh = this.#entries(this.health, id).filter((e) => e?.checked_at && this.now().getTime() - Date.parse(e.checked_at) <= HEALTH_MAX_AGE_MS);
    if (fresh.length === 0) return null;
    const set = new Set(fresh.map((e) => e.status));
    if (set.has('healthy')) return 'healthy';
    if (set.has('degraded')) return 'degraded';
    if (set.has('down')) return 'down';
    if (set.has('not_configured')) return 'not_configured';
    return null;
  }

  /** @returns {{ exhausted: boolean, resetsAt: string|null }} */
  exhaustion(id) {
    const entries = this.#entries(this.quota, id).filter((e) => e && !(e.resets_at && Date.parse(e.resets_at) <= this.now().getTime()));
    if (entries.length === 0) return { exhausted: false, resetsAt: null };
    const all = entries.every((e) => e.exhausted === true);
    return { exhausted: all, resetsAt: all ? entries.map((e) => e.resets_at).filter(Boolean).sort()[0] ?? null : null };
  }

  /**
   * The circuit breaker of the contract. Three failures in a row open it. It stays open for 15 minutes after the last
   * failure. Then one call goes through as a probe. If the probe fails, the count is 4 and it opens again.
   */
  breakerOpen(id) {
    const rec = this.failureRecord(id);
    if (!rec || (rec.consecutiveFailures ?? 0) < BREAKER.failures || !rec.lastCheckedAt) return null;
    const until = Date.parse(rec.lastCheckedAt) + BREAKER.probeAfterMs;
    return until > this.now().getTime() ? new Date(until).toISOString() : null;
  }

  /**
   * Why the router should skip a provider now, or null.
   * @param {string} id
   * @param {{ explicit?: boolean }} [ctx] A caller that asked for the provider by name gets one honest attempt at a `down` verdict, because a canary answer can be a day old. An exhausted provider is skipped either way: the call would fail.
   * @returns {{ reason: string, class: string } | null}
   */
  skipReason(id, ctx = {}) {
    const open = this.breakerOpen(id);
    if (open && !ctx.explicit) return { reason: `circuit breaker open until ${open} (3 failures in a row)`, class: 'provider_down' };
    const ex = this.exhaustion(id);
    if (ex.exhausted) return { reason: `free quota exhausted until ${ex.resetsAt ?? 'the next reset'}`, class: 'budget_exhausted' };
    const status = this.status(id);
    if (status === 'not_configured') return { reason: 'the canary reports no key', class: 'permanent' };
    if (status === 'down' && !ctx.explicit) return { reason: 'the canary reports the provider down', class: 'provider_down' };
    return null;
  }

  /** Degraded providers go last. The order inside each group stays as it was. */
  rank(order) {
    const good = [];
    const worse = [];
    for (const id of order) (this.status(id) === 'degraded' ? worse : good).push(id);
    return [...good, ...worse];
  }
}

export default OpsGate;
