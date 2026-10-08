/**
 * @file The generic adapter for any OpenAI compatible provider (Wave 12, K6).
 *
 * The three custom slots (`custom_1` to `custom_3`) use this class. A person sets a label, a base URL, a key,
 * and a model on the Keys page. The adapter goes last in failover. It uses the same base class as every other
 * adapter, so it gets the same breaker, the same quota ledger, and the same redaction. The Reviewer Gate runs
 * before the registry, so it covers this adapter too.
 *
 * Egress: the adapter may call only the host of its own base URL. The base URL must use https and a public
 * host. Redirects are not followed. The host is resolved before each call, and a private address is refused.
 */
import { isIP } from 'node:net';
import { guardedFetch } from '../lib/net.js';
import { checkEgress, isPrivateAddress } from '../tools/ssrf.js';
import { BaseProvider, ProviderError, networkErrorFrom, openAiChatBody, parseOpenAiChat, readJsonResponse, upstreamErrorFrom } from './base.js';

/**
 * Check a base URL without any network call.
 * @param {string} raw
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function checkBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'The base URL is not a valid address.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'The base URL must use https.' };
  if (url.username || url.password) return { ok: false, reason: 'The base URL must not hold a user name or a password.' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'The base URL must use a public host.' };
  }
  if (isIP(host) && isPrivateAddress(host)) return { ok: false, reason: 'The base URL must use a public host.' };
  if (!host.includes('.') && !isIP(host)) return { ok: false, reason: 'The base URL must use a public host.' };
  return { ok: true, url };
}

export class OpenAICompatProvider extends BaseProvider {
  /**
   * @param {{ id: string, label?: string, baseUrl: string, apiKey: string, model: string, fetchImpl?: typeof guardedFetch, egressCheck?: typeof checkEgress, lookup?: Function, health?: object }} init
   */
  constructor(init) {
    super({ id: init.id, label: init.label || init.id, apiKey: init.apiKey, model: init.model, ...(init.health ? { health: init.health } : {}) });
    this.baseUrl = String(init.baseUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = init.fetchImpl ?? guardedFetch;
    this.egressCheck = init.egressCheck ?? checkEgress;
    this.lookup = init.lookup;
  }

  /** Configured only with a key, a model, and a base URL that passes the check. */
  isConfigured() {
    return Boolean(this.apiKey && this.model && this.baseUrl && checkBaseUrl(this.baseUrl).ok);
  }

  async _doChat(messages, opts, signal) {
    const base = checkBaseUrl(this.baseUrl);
    if (!base.ok) throw new ProviderError(`${this.label}: ${base.reason}`, { code: 'NOT_CONFIGURED', service: this.id, retryable: false });
    const target = `${this.baseUrl}/chat/completions`;
    const host = new URL(target).hostname.toLowerCase();
    const egress = await this.egressCheck(target, { allowlist: [host], ...(this.lookup ? { lookup: this.lookup } : {}) });
    if (!egress.ok) throw new ProviderError(`${this.label}: egress refused (${egress.reason})`, { code: 'EGRESS_REFUSED', service: this.id, retryable: false });
    const res = await this.fetchImpl(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(openAiChatBody(messages, this.model, opts)),
      redirect: 'manual',
      signal,
    }).catch((err) => {
      throw networkErrorFrom(err, { service: this.id, label: this.label });
    });
    if (res.status >= 300 && res.status < 400) {
      throw new ProviderError(`${this.label} sent a redirect. TITAN does not follow redirects for a custom provider.`, { code: 'EGRESS_REFUSED', status: res.status, service: this.id, retryable: false });
    }
    if (!res.ok) throw await upstreamErrorFrom(res, { service: this.id, label: this.label });
    const json = await readJsonResponse(res, { service: this.id, label: this.label });
    return parseOpenAiChat(json, { service: this.id, label: this.label, model: this.model });
  }
}

export default OpenAICompatProvider;
