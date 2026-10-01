// UNVERIFIED CONTRACT
//
// One Hermes agent instance (Nous Research's Hermes Agent, run as its own
// service — the roadmap puts 2-3 of them on Railway). No instance exists yet,
// so this adapter's wire format could not be checked against a live one. It
// assumes the OpenAI-compatible shape every other adapter here already uses:
//
//     POST {baseUrl}{chatPath}      (chatPath defaults to /v1/chat/completions)
//     authorization: Bearer <key>
//     body: { model, messages, temperature, max_tokens, stream: false }
//     -> { choices: [{ message: { content } }], model?, usage? }
//
// The ENTIRE live HTTP call is isolated in `_doChat` below, and the path is a
// per-instance setting (`HERMES_<N>_CHAT_PATH`), so correcting either against
// the real service is a one-function / one-env-var fix. `titan hermes ping`
// is the check to run against a freshly provisioned instance.
//
// Deliberately NOT one of `registry.js`'s FAILOVER_ORDER entries (that array
// is a public contract the Worker and dashboard key off), and deliberately
// given its own no-op health sink: these are agents, not interchangeable
// chat endpoints, and a `hermes-N` record has no business in the five-provider
// ledger at `state/providers.json`. Not related to the Worker's "Hermes
// self-improvement loop" (worker/src/meta-agent.js) beyond the name.
import { guardedFetch } from '../lib/net.js';
import { BaseProvider, networkErrorFrom, openAiChatBody, parseOpenAiChat, readJsonResponse, upstreamErrorFrom } from './base.js';

export const DEFAULT_CHAT_PATH = '/v1/chat/completions';
export const DEFAULT_MODEL = 'hermes-agent';

/** Satisfies the slice of ProviderHealthStore that BaseProvider#chat touches. */
const NO_HEALTH = Object.freeze({
  markNotConfigured() {},
  recordOutcome() {},
});

export class HermesProvider extends BaseProvider {
  /**
   * @param {{ id: string, label?: string, baseUrl: string, apiKey: string, model?: string, chatPath?: string, specialization?: string[], fetchImpl?: typeof guardedFetch }} init
   */
  constructor(init) {
    super({ id: init.id, label: init.label ?? init.id, apiKey: init.apiKey, model: init.model || DEFAULT_MODEL, health: NO_HEALTH });
    this.baseUrl = String(init.baseUrl ?? '').replace(/\/+$/, '');
    const path = init.chatPath || DEFAULT_CHAT_PATH;
    this.chatPath = path.startsWith('/') ? path : `/${path}`;
    this.specialization = [...(init.specialization ?? [])];
    this.fetchImpl = init.fetchImpl ?? guardedFetch;
  }

  /** Configured only with BOTH a URL and a key: an agent endpoint with no auth is never called. */
  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  async _doChat(messages, opts, signal) {
    const res = await this.fetchImpl(`${this.baseUrl}${this.chatPath}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
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

export default HermesProvider;
