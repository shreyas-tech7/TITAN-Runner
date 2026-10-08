/**
 * OpenRouter — free tier via the ":free"-suffixed model catalog,
 * OpenAI-compatible wire format. Third in the failover chain.
 *
 * Model rotation (Wave 12, R2). The free models of OpenRouter hit 429 often. When a model answers 429, the adapter keeps it
 * out of use for 10 minutes and tries the next free model from the discovered list. One call makes 3 tries at most. A model
 * that no longer exists (404) rotates the same way. Any other error stops the loop and goes up to the failover logic.
 */
import { config, resolveModel } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { now as clockNow } from '../lib/clock.js';
import { providerHealth } from './health.js';
import { BaseProvider, networkErrorFrom, openAiChatBody, parseOpenAiChat, readJsonResponse, upstreamErrorFrom } from './base.js';

const API_BASE = 'https://openrouter.ai/api/v1';

/** How long a model that answered 429 stays out of use. */
export const MODEL_COOLDOWN_MS = 10 * 60_000;
/** How many models one call may try. */
export const MAX_MODEL_TRIES = 3;

/** model id to the time (ms) when it may be used again. Shared by every instance in this process. */
const cooldowns = new Map();

/** For tests: forget every cooldown. */
export function resetModelCooldowns() {
  cooldowns.clear();
}

export class OpenRouterProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: 'openrouter',
      label: 'OpenRouter',
      apiKey: overrides.apiKey ?? config.openrouter.apiKey,
      model: overrides.model ?? resolveModel('openrouter', providerHealth.get('openrouter').model),
      ...(overrides.health ? { health: overrides.health } : {}),
    });
    this.baseUrl = (overrides.baseUrl ?? API_BASE).replace(/\/+$/, '');
    this.fetchImpl = overrides.fetchImpl ?? guardedFetch;
    this.discoveredModels = overrides.models ?? null;
    this.nowMs = overrides.nowMs ?? (() => clockNow().getTime());
  }

  #headers() {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  /** The models to try, in order: the current model first, then the discovered free models. Cooled models are left out. */
  candidateModels() {
    const discovered = this.discoveredModels ?? providerHealth.get('openrouter').discoveredModels ?? [];
    const all = [...new Set([this.model, ...discovered].filter((m) => typeof m === 'string' && m.length > 0))];
    const t = this.nowMs();
    const ready = all.filter((m) => (cooldowns.get(m) ?? 0) <= t);
    // When every model is cooling, the current model gets one honest try. A call should not fail without a request.
    return (ready.length > 0 ? ready : all.slice(0, 1)).slice(0, MAX_MODEL_TRIES);
  }

  async #callModel(model, messages, opts, signal) {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(openAiChatBody(messages, model, opts)),
      signal,
    }).catch((err) => {
      throw networkErrorFrom(err, { service: this.id, label: this.label });
    });
    if (!res.ok) throw await upstreamErrorFrom(res, { service: this.id, label: this.label });
    const json = await readJsonResponse(res, { service: this.id, label: this.label });
    return parseOpenAiChat(json, { service: this.id, label: this.label, model });
  }

  async _doChat(messages, opts, signal) {
    let lastError;
    for (const model of this.candidateModels()) {
      try {
        const result = await this.#callModel(model, messages, opts, signal);
        this.model = model; // later calls start with the model that worked
        return result;
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
        const rotates = err?.status === 429 || err?.code === 'RATE_LIMITED' || err?.status === 404;
        if (!rotates) throw err;
        cooldowns.set(model, this.nowMs() + MODEL_COOLDOWN_MS);
      }
    }
    throw lastError;
  }
}

export default OpenRouterProvider;
