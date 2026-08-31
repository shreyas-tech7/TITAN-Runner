/**
 * Together AI — free tier, OpenAI-compatible wire format. Second in the
 * failover chain.
 */
import { config, resolveModel } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { providerHealth } from './health.js';
import { BaseProvider, networkErrorFrom, openAiChatBody, parseOpenAiChat, readJsonResponse, upstreamErrorFrom } from './base.js';

const API_BASE = 'https://api.together.xyz/v1';

export class TogetherProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: 'together',
      label: 'Together AI',
      apiKey: overrides.apiKey ?? config.together.apiKey,
      model: overrides.model ?? resolveModel('together', providerHealth.get('together').model),
    });
    this.baseUrl = (overrides.baseUrl ?? API_BASE).replace(/\/+$/, '');
  }

  #headers() {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  async _doChat(messages, opts, signal) {
    const res = await guardedFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(openAiChatBody(messages, this.model, opts)),
      signal,
    }).catch((err) => {
      throw networkErrorFrom(err, { service: this.id, label: this.label });
    });
    if (!res.ok) throw await upstreamErrorFrom(res, { service: this.id, label: this.label });
    const json = await readJsonResponse(res, { service: this.id, label: this.label });
    return parseOpenAiChat(json, { service: this.id, label: this.label, model: this.model });
  }
}

export default TogetherProvider;
