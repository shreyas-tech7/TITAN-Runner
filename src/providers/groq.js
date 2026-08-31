/**
 * Groq — free tier, OpenAI-compatible wire format. First in the failover
 * chain: its LPU inference is consistently the fastest of the five.
 */
import { config } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { BaseProvider, networkErrorFrom, openAiChatBody, parseOpenAiChat, readJsonResponse, upstreamErrorFrom } from './base.js';

const API_BASE = 'https://api.groq.com/openai/v1';

export class GroqProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: 'groq',
      label: 'Groq',
      apiKey: overrides.apiKey ?? config.groq.apiKey,
      model: overrides.model ?? config.groq.model,
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

export default GroqProvider;
