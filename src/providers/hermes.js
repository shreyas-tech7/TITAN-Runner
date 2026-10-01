// DOCUMENTED UPSTREAM, NOT YET EXERCISED END TO END
//
// One Hermes agent instance (Nous Research's Hermes Agent, run as its own
// service — the plan is Railway). Hermes Agent's API server documents an
// OpenAI-compatible surface (NousResearch/hermes-agent,
// website/docs/user-guide/features/api-server.md), which is what this adapter
// speaks:
//
//     POST {baseUrl}{chatPath}      (chatPath defaults to /v1/chat/completions)
//     authorization: Bearer <API_SERVER_KEY>
//     body: { model, messages, temperature, max_tokens, stream: false }
//     -> { choices: [{ message: { content, reasoning_content? } }], model, usage }
//
// `model` defaults to "hermes-agent", the name upstream advertises for the
// default profile. Checked without any credential on 2026-10-01 against a live
// instance: an unauthenticated POST to /v1/chat/completions answers 401 (the
// route exists and wants a key) while an unknown route answers 404. What has
// NOT been done is an authenticated call through this client — run
// `node bin/titan.js hermes ping` once for that. If the real shape differs,
// the whole live HTTP call is isolated in `_doChat` below and the path is a
// per-instance setting (`HERMES_<N>_CHAT_PATH`): a one-function fix.
//
// WHAT AN INSTANCE CAN DO. Upstream describes the agent as handling requests
// "with its full toolset (terminal, file operations, web search, memory,
// skills)". Sending it work is therefore NOT a read: it can act on its own
// host. Whatever eventually calls `HermesCluster#dispatch` must route that
// through `policy/engine.js#decide()` as an external effect, not treat it as
// a plain chat completion.
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
