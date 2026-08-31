/**
 * Google Gemini — free tier via AI Studio, `generateContent` REST shape.
 * The one provider of the five that does not speak the OpenAI-compatible
 * chat-completions format, so it writes its own request builder and
 * response parser. Fourth in the failover chain.
 *
 * The API key travels as the `x-goog-api-key` header rather than the `?key=`
 * query parameter: a header is never logged by accident the way a full
 * request URL can be.
 */
import { config, resolveModel } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { providerHealth } from './health.js';
import { BaseProvider, ProviderError, networkErrorFrom, readJsonResponse, upstreamErrorFrom } from './base.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function geminiChatBody(messages, opts = {}) {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 1024,
    },
  };
  if (systemParts.length > 0) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  return body;
}

export function parseGeminiChat(json, ctx) {
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new ProviderError(`${ctx.label} returned no candidate text`, {
      code: 'UPSTREAM_ERROR', service: ctx.service, retryable: false,
    });
  }
  const tokens = json?.usageMetadata?.totalTokenCount;
  return { text, model: ctx.model, tokensUsed: Number.isFinite(tokens) ? Number(tokens) : null };
}

export class GeminiProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: 'gemini',
      label: 'Gemini',
      apiKey: overrides.apiKey ?? config.gemini.apiKey,
      model: overrides.model ?? resolveModel('gemini', providerHealth.get('gemini').model),
    });
    this.baseUrl = (overrides.baseUrl ?? API_BASE).replace(/\/+$/, '');
  }

  #headers() {
    return { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' };
  }

  async _doChat(messages, opts, signal) {
    const res = await guardedFetch(
      `${this.baseUrl}/models/${this.model}:generateContent`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(geminiChatBody(messages, opts)), signal },
    ).catch((err) => {
      throw networkErrorFrom(err, { service: this.id, label: this.label });
    });
    if (!res.ok) throw await upstreamErrorFrom(res, { service: this.id, label: this.label });
    const json = await readJsonResponse(res, { service: this.id, label: this.label });
    return parseGeminiChat(json, { service: this.id, label: this.label, model: this.model });
  }
}

export default GeminiProvider;
