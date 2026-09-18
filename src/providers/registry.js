/**
 * @file Failover across the five free-tier chat providers. A lean rewrite of
 * TITAN's original `backend/services/registry.js`: no in-memory task-history
 * log, no latency-based auto-routing — a pulse calls this a handful of times
 * every ~15 minutes, so a fixed, documented failover order
 * (fastest-and-most-generous first) is simpler and just as effective.
 *
 * What the failover now consults before every attempt:
 *   - the health store's breaker (`providers/health.js`): a disabled or open
 *     breaker is skipped; an explicitly requested provider still gets one
 *     honest attempt while merely cooling down, never when its key is bad;
 *   - the quota ledger (`reliability/quota.js`), when attached: a provider
 *     whose per-minute or per-day window is spent is skipped before the call.
 * Every attempt's failure is classified (`reliability/failures.js`) and the
 * aggregate error names the class, so the scheduler can decide once — a
 * permanent error on every provider is not retried three more times.
 *
 * Failover is bounded per call: an `auto` request tries at most
 * `maxProviders` (default 3) distinct providers; a request that names a
 * provider (`service: 'groq'`) tries only that one, because the scheduler
 * that asked for it by name already rotates candidates under its own retry
 * policy — a second failover layer underneath it was the retry storm the
 * baseline harness measured (15 upstream calls for one doomed step).
 * An optional decision sink receives one `routing.decision` per call.
 */
import { ProviderError } from './base.js';
import { GroqProvider } from './groq.js';
import { TogetherProvider } from './together.js';
import { OpenRouterProvider } from './openrouter.js';
import { GeminiProvider } from './gemini.js';
import { HuggingFaceProvider } from './huggingface.js';
import { OmniRouteProvider } from './omniroute.js';
import { providerHealth } from './health.js';
import { classifyFailure, aggregateClass } from '../reliability/failures.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('providers:registry');

/** Fastest/most generous free tier first, flakiest last. */
export const FAILOVER_ORDER = ['groq', 'together', 'openrouter', 'gemini', 'huggingface'];

/** Distinct direct providers one `auto` call may try before giving up. */
export const DEFAULT_MAX_PROVIDERS_PER_CALL = 3;

export class Registry {
  #providers = new Map();
  #health;
  #omniroute;
  #quota = null;
  #onDecision = null;

  /**
   * @param {{providers?: Map<string, object>, omniroute?: object, healthStore?: import('./health.js').ProviderHealthStore, quota?: import('../reliability/quota.js').QuotaLedger|null, onDecision?: ((d: object) => void)|null}} [deps]
   *   All injectable for tests and the fakes — production code uses the
   *   defaults (the five real provider instances, the shared `providerHealth`).
   */
  constructor({ providers, omniroute, healthStore = providerHealth, quota = null, onDecision = null } = {}) {
    this.#health = healthStore;
    this.#omniroute = omniroute ?? new OmniRouteProvider();
    this.#quota = quota;
    this.#onDecision = onDecision;
    if (providers) {
      this.#providers = providers;
      return;
    }
    this.#providers.set('groq', new GroqProvider());
    this.#providers.set('together', new TogetherProvider());
    this.#providers.set('openrouter', new OpenRouterProvider());
    this.#providers.set('gemini', new GeminiProvider());
    this.#providers.set('huggingface', new HuggingFaceProvider());
  }

  /** Attach (or replace) the quota ledger — the engine does this per pulse. */
  useQuota(ledger) {
    this.#quota = ledger ?? null;
  }

  /** Attach a routing-decision sink, e.g. the event log. */
  useDecisionSink(fn) {
    this.#onDecision = typeof fn === 'function' ? fn : null;
  }

  get health() {
    return this.#health;
  }

  providerIds() {
    return [...FAILOVER_ORDER];
  }

  getProvider(id) {
    return this.#providers.get(id) ?? null;
  }

  /** Which of the five have a key configured — used for the dashboard's provider view. */
  configuredIds() {
    return FAILOVER_ORDER.filter((id) => this.#providers.get(id)?.isConfigured());
  }

  /** Whether the optional OmniRoute gateway is configured. */
  omniRouteConfigured() {
    return this.#omniroute.isConfigured();
  }

  /**
   * Why a provider will be skipped right now (with the failure class that
   * skip stands for), or null if it is callable.
   * @param {string} id
   * @param {{ explicit: boolean, priority?: string }} ctx
   * @returns {{ reason: string, class: string } | null}
   */
  #skipReason(id, ctx) {
    const breaker = this.#health.breakerState(id);
    if (breaker.state === 'disabled') return { reason: `breaker disabled: ${breaker.reason}`, class: 'permanent' };
    if (breaker.state === 'open' && !ctx.explicit) {
      const last = this.#health.get(id)?.lastFailureClass;
      return { reason: `breaker open: ${breaker.reason}`, class: typeof last === 'string' ? last : 'provider_down' };
    }
    if (this.#quota) {
      const q = this.#quota.canSpend(id, { priority: ctx.priority });
      if (!q.ok) return { reason: `quota: ${q.reason}`, class: 'budget_exhausted' };
    }
    return null;
  }

  /**
   * @param {{role:string,content:string}[]} messages
   * @param {{service?: string, signal?: AbortSignal, temperature?: number, maxTokens?: number, priority?: string, failover?: boolean, maxProviders?: number}} [opts]
   *   `failover` (default: true for `auto`, false for a named service)
   *   allows other direct providers after the first choice fails;
   *   `maxProviders` caps how many distinct providers one call may try.
   */
  async chat(messages, opts = {}) {
    const { service = 'auto', signal, temperature, maxTokens, priority } = opts;
    const explicitId = service !== 'auto' && FAILOVER_ORDER.includes(service) ? service : null;
    const failover = opts.failover ?? explicitId === null;
    const maxProviders = Math.max(1, Number.isInteger(opts.maxProviders) ? opts.maxProviders : DEFAULT_MAX_PROVIDERS_PER_CALL);
    const order = explicitId
      ? (failover ? [explicitId, ...FAILOVER_ORDER.filter((id) => id !== explicitId)] : [explicitId])
      : [...FAILOVER_ORDER];

    const tried = [];
    const skipped = [];
    /** @type {Array<{id: string, class: string, code: string|null, status: number|null, retryAfterMs: number|null}>} */
    const failures = [];
    const started = performance.now();

    // OmniRoute goes first, but only for an "auto" (unhinted) request and
    // only when configured — an explicit `service` name is a caller asking
    // for that exact direct provider, which OmniRoute should not intercept.
    if (!explicitId && this.#omniroute.isConfigured()) {
      tried.push('omniroute');
      try {
        const result = await this.#omniroute.chat(messages, { temperature, maxTokens, signal });
        this.#quota?.record('omniroute', { tokens: result.tokensUsed });
        this.#decide({ service, tried, skipped, failures, chosen: 'omniroute', ms: performance.now() - started });
        return result;
      } catch (err) {
        if (signal?.aborted) throw err;
        const f = classifyFailure(err);
        failures.push({ id: 'omniroute', class: f.class, code: f.code, status: f.status, retryAfterMs: f.retryAfterMs });
        log.debug('omniroute attempt failed, falling back to direct providers', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const id of order) {
      if (tried.filter((t) => t !== 'omniroute').length >= maxProviders) break;
      const provider = this.#providers.get(id);
      if (!provider || !provider.isConfigured()) continue;
      // The explicitly requested provider gets one honest attempt even while
      // cooling down (the caller asked for it by name); every fallback is
      // held to the breaker and the quota so a known-dead provider is never
      // retried into a failed pulse.
      const skip = this.#skipReason(id, { explicit: id === explicitId, priority });
      if (skip) {
        skipped.push({ id, reason: skip.reason, class: skip.class });
        continue;
      }
      tried.push(id);
      try {
        const result = await provider.chat(messages, { temperature, maxTokens, signal });
        this.#quota?.record(id, { tokens: result.tokensUsed });
        this.#decide({ service, tried, skipped, failures, chosen: id, ms: performance.now() - started });
        return result;
      } catch (err) {
        if (signal?.aborted) throw err;
        const f = classifyFailure(err);
        failures.push({ id, class: f.class, code: f.code, status: f.status, retryAfterMs: f.retryAfterMs });
        if (f.status != null) this.#quota?.record(id, { status: f.status });
        log.debug('provider attempt failed during failover', { service: id, class: f.class, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Nothing tried at all: the class is whatever the skips stood for (a
    // disabled breaker is permanent, a spent quota is budget, a cooldown is
    // the class that opened it), so the caller parks or gives up correctly.
    const cls = failures.length > 0
      ? aggregateClass(failures.map((f) => f.class), { skipped: skipped.length })
      : aggregateClass(skipped.map((s) => s.class), { skipped: skipped.length });
    const retryAfterMs = failures.filter((f) => f.class === 'rate_limited' && Number.isFinite(f.retryAfterMs)).reduce((m, f) => (m == null ? f.retryAfterMs : Math.min(m, f.retryAfterMs)), null);
    this.#decide({ service, tried, skipped, failures, chosen: null, ms: performance.now() - started, failureClass: cls });
    const triedDesc = tried.length > 0 ? tried.join(', ') : 'none configured or healthy';
    const skippedDesc = skipped.length > 0 ? ` (skipped: ${skipped.map((s) => `${s.id} — ${s.reason}`).join('; ')})` : '';
    throw Object.assign(new ProviderError(`All providers failed for this request (tried: ${triedDesc})${skippedDesc}`, {
      code: 'ALL_PROVIDERS_FAILED', retryable: false, retryAfterMs,
    }), { failureClass: cls, failures, skipped });
  }

  #decide(decision) {
    if (!this.#onDecision) return;
    try {
      this.#onDecision(decision);
    } catch {
      // a sink must never break routing
    }
  }
}

export const registry = new Registry();
export default registry;
