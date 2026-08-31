/**
 * HuggingFace — free Inference tier, via the OpenAI-compatible router
 * endpoint. Last in the failover chain: on the free tier a cold model gets
 * evicted from the serving pool, and the first request that wakes it gets a
 * 503 instead of an answer.
 */
import { config } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { BaseProvider, networkErrorFrom, openAiChatBody, parseOpenAiChat, readJsonResponse, retryableErrorFrom, upstreamErrorFrom } from './base.js';

const API_BASE = 'https://router.huggingface.co/v1';
const MAX_COLD_START_MS = 120_000;

export class HuggingFaceProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: 'huggingface',
      label: 'HuggingFace',
      // The real env var is HF_API_KEY, not HUGGINGFACE_API_KEY.
      apiKey: overrides.apiKey ?? config.huggingface.apiKey,
      model: overrides.model ?? config.huggingface.model,
    });
    this.baseUrl = (overrides.baseUrl ?? API_BASE).replace(/\/+$/, '');
  }

  #headers() {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  /**
   * HF answers a cold model with `503 {"error": "...", "estimated_time": 20.3}`
   * — seconds until the model finishes loading. That's a wait, not a
   * failure, so it becomes a retryable error carrying `retryAfterMs`.
   */
  async #errorFor(res) {
    if (res.status === 503) {
      const body = await res.clone().json().catch(() => null);
      const seconds = Number(body?.estimated_time);
      if (Number.isFinite(seconds) && seconds > 0) {
        return retryableErrorFrom(`${this.label} model is loading (~${Math.ceil(seconds)}s)`, {
          service: this.id, status: 503, retryAfterMs: Math.min(Math.round(seconds * 1000), MAX_COLD_START_MS),
        });
      }
    }
    return upstreamErrorFrom(res, { service: this.id, label: this.label });
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
    if (!res.ok) throw await this.#errorFor(res);
    const json = await readJsonResponse(res, { service: this.id, label: this.label });
    return parseOpenAiChat(json, { service: this.id, label: this.label, model: this.model });
  }
}

export default HuggingFaceProvider;
