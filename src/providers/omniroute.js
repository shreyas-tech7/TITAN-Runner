/**
 * OmniRoute — an optional self-hosted multi-provider gateway
 * (https://github.com/diegosouzapw/OmniRoute), OpenAI-compatible on
 * `/v1/chat/completions`. Disabled by default: `isConfigured()` is false
 * unless `OMNIROUTE_BASE_URL` is explicitly set, so a fresh checkout with no
 * gateway running behaves exactly as it did before this file existed.
 *
 * Deliberately NOT one of `registry.js`'s `FAILOVER_ORDER` entries — that
 * array is a public contract several other places key off (the Worker's
 * `KNOWN_PROVIDERS`, the dashboard's provider list, the capability
 * registry's seed-table pools). Registry#chat instead tries this provider
 * first, ahead of the fixed five, when it's configured, then falls through
 * to the normal failover untouched. That way a gateway outage or a bad
 * OMNIROUTE_BASE_URL degrades to the existing direct-provider path rather
 * than taking the whole pulse down — the same "never a single point of
 * failure" principle every other provider here already follows.
 */
import { config } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { BaseProvider, networkErrorFrom, openAiChatBody, parseOpenAiChat, readJsonResponse, upstreamErrorFrom } from './base.js';

export class OmniRouteProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: 'omniroute',
      label: 'OmniRoute',
      apiKey: overrides.apiKey ?? config.omniroute.apiKey ?? 'local',
      // "auto" hands model choice to OmniRoute's own cost/health-aware
      // routing across whichever upstream providers it has keys for —
      // see its docs for the auto/combo model conventions.
      model: overrides.model ?? config.omniroute.model ?? 'auto',
    });
    this.baseUrl = (overrides.baseUrl ?? config.omniroute.baseUrl).replace(/\/+$/, '');
  }

  /** Configured only when a base URL was explicitly set — this is an
   * opt-in extra hop, not a required one, unlike the five direct adapters
   * which only need an API key. */
  isConfigured() {
    return Boolean(this.baseUrl);
  }

  #headers() {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey && this.apiKey !== 'local') headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
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

export default OmniRouteProvider;
