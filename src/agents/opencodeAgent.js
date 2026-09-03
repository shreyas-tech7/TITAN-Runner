// UNVERIFIED CONTRACT
//
// OpenCode's real HTTP request/response shape could not be confirmed against
// documentation, source, or a live credential at build time. This adapter is
// built against the AgentAdapter interface with a plausible OpenAI-compatible
// chat-completions request shape (the same wire format Groq/OpenRouter/Together
// already use in this codebase — see services/groq.js) as a best-effort
// placeholder, including a GET /models catalog endpoint on the assumption
// OpenCode follows the same convention. The ENTIRE live HTTP call is isolated
// in the two `#callOpenCodeApi()` / `#fetchModelCatalog()` methods below so
// correcting them against a real API is a one-function fix, not a rewrite.
// Offline/fixture mode (the default — see config.dryRun) never calls
// either method and needs no real credential.
//
// `_buildTaskPrompt` now lands from `AgentAdapter.js` directly (this file
// used to carry a private `#buildPrompt()` stand-in from before that method
// existed, on the base class — found stale and removed here in v4.0 Wave 1
// prep: it had silently diverged from the shared method and was never
// updated with Wave 0.4's JSON-envelope instructions, so every OpenCode task
// was being told the old `// file:` convention alone).

import { readFileSync } from 'node:fs';

import { config } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { AgentAdapter, AdapterError } from './AgentAdapter.js';
import { buildProbePrompt } from '../orchestrator/capabilityRegistry.js';
import { providerHealth } from '../providers/health.js';
import { isFreePriced } from '../providers/freeFilter.js';

/** Longest upstream error snippet we'll fold into an AdapterError message. */
const MAX_UPSTREAM_DETAIL = 200;

/** Wall-clock cap on the offline fixture's simulated latency, mirroring
 *  services/base.js's OFFLINE_MAX_SLEEP_MS — report the fixture's latencyMs,
 *  but never actually sleep more than a token amount. */
const OFFLINE_MAX_SLEEP_MS = 20;

/* -------------------------------------------------------------------------- */
/* Offline fixture                                                            */
/* -------------------------------------------------------------------------- */

/** @type {any|null} */
let fixtureCache = null;

/**
 * Read `fixtures/opencode-response.json` once and memoise it. Synchronous on
 * purpose, mirroring `services/base.js`'s `loadFixtures()` — this file is a
 * few KB, read at most once per process.
 * @returns {any}
 */
function loadFixture() {
  if (fixtureCache) return fixtureCache;
  const url = new URL('./fixtures/opencode-response.json', import.meta.url);
  fixtureCache = JSON.parse(readFileSync(url, 'utf8'));
  return fixtureCache;
}

/** Test seam: drop the memoised fixture so a rewritten file is picked up. */
export function resetFixtureCache() {
  fixtureCache = null;
}

/* -------------------------------------------------------------------------- */
/* OpenCodeAgent                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Adapter for "OpenCode" — unlike Freebuff (hard-capped at 1 concurrent
 * instance elsewhere in this wave), OpenCode's concurrency is bounded by a
 * normal configurable value, `config.orchestrator.maxOpenCode` (default 4).
 */
export class OpenCodeAgent extends AgentAdapter {
  /**
   * @param {{ apiKey?: string, baseUrl?: string, maxConcurrency?: number }} [init]
   */
  constructor({
    apiKey = config.opencode.apiKey,
    baseUrl = config.opencode.baseUrl,
    maxConcurrency = config.orchestrator.maxOpenCode,
  } = {}) {
    super({ pool: 'opencode', label: 'OpenCode', maxConcurrency });
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'http://localhost:4096'; // UNVERIFIED placeholder default
  }

  /** @returns {boolean} */
  isConfigured() {
    return Boolean(this.apiKey);
  }

  /**
   * A minimal, direct chat call outside the task-decomposition machinery —
   * used only by `scripts/provider-selftest.mjs`'s "tiny completion" probe
   * (task instructions, section 6), where the point is a real round trip
   * with a real answer, not a full orchestration prompt. Never called from
   * `_doExecute`/the scheduler.
   * @param {string} prompt
   * @param {{ maxTokens?: number }} [opts]
   * @returns {Promise<{ text: string, model: string, tokensUsed: number|null }>}
   */
  async selfTestChat(prompt, opts = {}) {
    if (!this.isConfigured()) {
      throw new AdapterError('OpenCode is not configured (missing OPENCODE_API_KEY)', {
        code: 'NOT_CONFIGURED',
        retryable: false,
      });
    }
    const model = await this.#resolveModel(undefined);
    const json = await this.#callOpenCodeApi({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: opts.maxTokens ?? 5,
      stream: false,
    });
    const text = json?.choices?.[0]?.message?.content;
    const tokens = json?.usage?.total_tokens;
    return {
      text: typeof text === 'string' ? text : '',
      model: typeof json?.model === 'string' ? json.model : model,
      tokensUsed: Number.isFinite(tokens) ? Number(tokens) : null,
    };
  }

  /* ---- AgentAdapter hooks --------------------------------------------- */

  async _doExecute(task, sharedContext, options = {}) {
    if (config.dryRun) return this.#offlineExecute();
    if (!this.isConfigured()) {
      throw new AdapterError('OpenCode is not configured (missing OPENCODE_API_KEY)', {
        code: 'NOT_CONFIGURED',
        retryable: false,
      });
    }

    const model = await this.#resolveModel(options.modelId);
    const payload = {
      model,
      messages: [{ role: 'user', content: this._buildTaskPrompt(task, sharedContext) }],
      temperature: 0.7,
      max_tokens: 2048,
      stream: false,
    };

    const json = await this.#callOpenCodeApi(payload, options.signal);
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      // A 200 with no content means the placeholder contract does not match
      // reality — not retryable, replaying it would just repeat the same shape.
      throw new AdapterError('OpenCode returned no message content', {
        code: 'UPSTREAM_ERROR',
        retryable: false,
      });
    }
    const tokens = json?.usage?.total_tokens;
    return {
      output: text,
      modelId: typeof json?.model === 'string' ? json.model : model,
      tokensUsed: Number.isFinite(tokens) ? Number(tokens) : null,
    };
  }

  async _doListModels() {
    if (config.dryRun) return loadFixture().models;
    return this.#fetchModelCatalog();
  }

  async _doProbeCapabilities(modelId, opts = {}) {
    if (config.dryRun) return loadFixture().probe.text;

    const payload = {
      model: await this.#resolveModel(modelId),
      messages: [{ role: 'user', content: buildProbePrompt(modelId, opts) }],
      temperature: 0.2,
      max_tokens: 512,
      stream: false,
    };
    const json = await this.#callOpenCodeApi(payload);
    const text = json?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : '';
  }

  /* ---- offline path ----------------------------------------------------- */

  /**
   * @returns {Promise<{output: string, modelId: string, tokensUsed: number|null}>}
   */
  async #offlineExecute() {
    const sample = loadFixture().chat;
    const latencyMs = Number.isFinite(sample.latencyMs) ? sample.latencyMs : 900;
    // Real delay (capped), so callers exercising concurrency actually overlap
    // instead of resolving synchronously — see item 5 of this adapter's test.
    await sleep(Math.min(latencyMs, OFFLINE_MAX_SLEEP_MS));
    return {
      output: sample.text,
      modelId: sample.modelId,
      tokensUsed: Number.isFinite(sample.tokensUsed) ? sample.tokensUsed : null,
    };
  }

  /**
   * Turn an internal capability-registry model id ("opencode:default", the
   * seed-table placeholder, or a previously-discovered "opencode:<real-id>")
   * into the bare id the live API expects. "default" is not a real model —
   * sending it literally would 404 against the real API — so it resolves
   * from the cached discovery result (`state/providers.json`, refreshed by
   * `scripts/provider-selftest.mjs`) if one exists, else a fresh catalog
   * fetch. `#fetchModelCatalog()` never throws (see its own header); its
   * worst case is one fixture-derived id, which at least fails predictably
   * instead of 404ing on a literal "default".
   * @param {string|undefined} requested
   * @returns {Promise<string>}
   */
  async #resolveModel(requested) {
    const prefix = 'opencode:';
    const bare = typeof requested === 'string' && requested.startsWith(prefix)
      ? requested.slice(prefix.length)
      : requested;
    if (bare && bare !== 'default') return bare;

    const cached = providerHealth.get('opencode').model;
    if (cached) return cached;

    const models = await this.#fetchModelCatalog();
    const chosen = models[0]?.modelId ?? 'opencode:default';
    if (models.length > 0) {
      providerHealth.setDiscoveredModels('opencode', models.map((m) => m.modelId), chosen);
    }
    return chosen;
  }

  /* ---- live HTTP — the ONLY two methods that touch the network ---------- */

  /** @returns {Record<string, string>} */
  #headers() {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
  }

  /**
   * Isolated live HTTP call for both `_doExecute()` and `_doProbeCapabilities()`.
   * UNVERIFIED shape: `POST {baseUrl}/v1/chat/completions`, OpenAI-compatible.
   * @param {Record<string, unknown>} payload
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>} Parsed JSON response body.
   */
  async #callOpenCodeApi(payload, signal) {
    let res;
    try {
      res = await guardedFetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      throw new AdapterError(
        `OpenCode unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { code: 'UPSTREAM_ERROR', retryable: true, cause: err },
      );
    }
    if (!res.ok) {
      const detail = await safeText(res);
      throw new AdapterError(
        `OpenCode rejected the request (${res.status})${detail ? `: ${detail}` : ''}`,
        { code: 'UPSTREAM_ERROR', retryable: false },
      );
    }
    return res.json();
  }

  /**
   * Isolated live HTTP call for `_doListModels()`. UNVERIFIED shape:
   * `GET {baseUrl}/v1/models`, OpenAI-compatible catalog convention. A models
   * list is a nice-to-have, not something that should break the whole pool if
   * this endpoint turns out wrong — any failure falls back to the single
   * `opencode:default` fixture entry instead of throwing.
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{modelId: string, pool: string, contextWindow: number}>>}
   */
  async #fetchModelCatalog(signal) {
    try {
      const res = await guardedFetch(`${this.baseUrl}/v1/models`, {
        headers: this.#headers(),
        signal,
      });
      if (!res.ok) throw new Error(`OpenCode models catalog returned ${res.status}`);
      const json = await res.json();
      const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      const toRecord = (m) => ({
        modelId: typeof m === 'string' ? m : (m?.id ?? m?.modelId),
        pool: 'opencode',
        contextWindow: Number.isFinite(m?.context_window)
          ? m.context_window
          : Number.isFinite(m?.contextWindow)
            ? m.contextWindow
            : 32768,
      });
      const named = raw.filter((m) => typeof (m?.id ?? m?.modelId ?? m) === 'string');
      // OpenCode Zen's catalog mixes free and paid curated models (task
      // brief, section 6) — prefer entries the pricing/id shape marks free;
      // if nothing is confidently free (an unrecognised response shape),
      // fall back to the full list rather than returning nothing.
      const free = named.filter(isFreePriced).map(toRecord).filter((m) => typeof m.modelId === 'string' && m.modelId.length > 0);
      const models = free.length > 0 ? free : named.map(toRecord).filter((m) => typeof m.modelId === 'string' && m.modelId.length > 0);
      if (models.length === 0) throw new Error('OpenCode models catalog returned no entries');
      return models;
    } catch {
      return [loadFixture().models[2]];
    }
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort, size-capped read of an error response body, so a bad response
 * can be described without risking an oversized or malformed message.
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function safeText(res) {
  try {
    const raw = await res.text();
    return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_UPSTREAM_DETAIL);
  } catch {
    return '';
  }
}

export default OpenCodeAgent;
