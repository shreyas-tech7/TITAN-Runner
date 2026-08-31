/**
 * @file Failover across the five free-tier chat providers. A lean rewrite of
 * TITAN's original `backend/services/registry.js`: no 60s health cache, no
 * in-memory task-history log, no latency-based auto-routing — a pulse calls
 * this a handful of times every ~15 minutes, so a fixed, documented failover
 * order (fastest-and-most-generous first) is simpler and just as effective
 * as the original's adaptive ordering, without needing anything to warm up.
 */
import { ProviderError } from './base.js';
import { GroqProvider } from './groq.js';
import { TogetherProvider } from './together.js';
import { OpenRouterProvider } from './openrouter.js';
import { GeminiProvider } from './gemini.js';
import { HuggingFaceProvider } from './huggingface.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('providers:registry');

/** Fastest/most generous free tier first, flakiest last. */
export const FAILOVER_ORDER = ['groq', 'together', 'openrouter', 'gemini', 'huggingface'];

export class Registry {
  #providers = new Map();

  constructor() {
    this.#providers.set('groq', new GroqProvider());
    this.#providers.set('together', new TogetherProvider());
    this.#providers.set('openrouter', new OpenRouterProvider());
    this.#providers.set('gemini', new GeminiProvider());
    this.#providers.set('huggingface', new HuggingFaceProvider());
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

  /**
   * @param {{role:string,content:string}[]} messages
   * @param {{service?: string, signal?: AbortSignal, temperature?: number, maxTokens?: number}} [opts]
   */
  async chat(messages, opts = {}) {
    const { service = 'auto', signal, temperature, maxTokens } = opts;
    const order = service !== 'auto' && FAILOVER_ORDER.includes(service)
      ? [service, ...FAILOVER_ORDER.filter((id) => id !== service)]
      : [...FAILOVER_ORDER];

    const tried = [];
    for (const id of order) {
      const provider = this.#providers.get(id);
      if (!provider || !provider.isConfigured()) continue;
      tried.push(id);
      try {
        return await provider.chat(messages, { temperature, maxTokens, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        log.debug('provider attempt failed during failover', { service: id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const triedDesc = tried.length > 0 ? tried.join(', ') : 'none configured';
    throw new ProviderError(`All providers failed for this request (tried: ${triedDesc})`, {
      code: 'ALL_PROVIDERS_FAILED', retryable: false,
    });
  }
}

export const registry = new Registry();
export default registry;
