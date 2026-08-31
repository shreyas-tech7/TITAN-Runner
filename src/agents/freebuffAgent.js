// UNVERIFIED CONTRACT
//
// Freebuff's real HTTP request/response shape could not be confirmed against
// documentation, source, or a live credential at build time. This adapter is
// built against the AgentAdapter interface with a plausible OpenAI-compatible
// chat-completions request shape (the same wire format Groq/OpenRouter/Together
// already use in this codebase — see services/groq.js) as a best-effort
// placeholder. The ENTIRE live HTTP call is isolated in the single
// `#callFreebuffApi()` method below so correcting it against a real API is a
// one-function fix, not a rewrite. Offline/fixture mode (the default — see
// config.dryRun) never calls this method and needs no real credential.

/**
 * @file Freebuff adapter — the scarce resource in the orchestrator.
 *
 * Freebuff is hard-capped at exactly 1 concurrent execution, always. That cap
 * is not read from config and not overridable by a caller: it is passed as a
 * literal `1` to `super()` below. This is a correctness requirement (Freebuff
 * is assumed to be a low-capacity/expensive resource the rest of the system
 * must never burst against), not a tunable default.
 *
 * Offline behaviour deliberately differs from `services/base.js`'s
 * `BaseProvider`: there, `isConfigured()` is checked BEFORE `config.dryRun`,
 * so an unconfigured Phase 2 provider reports "not configured" even offline.
 * Here, `config.dryRun` is checked FIRST in every hook — a fresh clone
 * with zero API keys must still be able to run a full orchestration end to
 * end against fixtures. `isConfigured()` still gates the live path and is
 * still meaningful for health/reporting purposes; it just is not a gate on
 * offline fixture behaviour.
 */

import { readFileSync } from 'node:fs';

import { config } from '../config.js';
import { AdapterError, AgentAdapter } from './AgentAdapter.js';
import { guardedFetch } from '../lib/net.js';
import { buildProbePrompt } from '../orchestrator/capabilityRegistry.js';

/** UNVERIFIED placeholder base URL — see the file header. */
const API_BASE = 'https://api.freebuff.dev/v1';

/** Fallback model id used whenever a caller does not specify one. */
const DEFAULT_MODEL_ID = 'freebuff:default';

/**
 * Wall-clock cap on the fake delay used in offline mode, mirroring
 * `services/base.js`'s `OFFLINE_MAX_SLEEP_MS`. A real (small) delay is used
 * rather than resolving synchronously so concurrent `execute()` calls
 * actually overlap in time — the concurrency test depends on this.
 */
const OFFLINE_SLEEP_MS = 15;

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Offline fixture                                                            */
/* -------------------------------------------------------------------------- */

/** @type {any|null} */
let fixtureCache = null;

/**
 * Read `fixtures/freebuff-response.json` once and memoise it. Mirrors
 * `services/base.js`'s `loadFixtures()` — synchronous, one small file, read
 * at most once per process.
 * @returns {any}
 */
function loadFixture() {
  if (fixtureCache) return fixtureCache;
  const url = new URL('./fixtures/freebuff-response.json', import.meta.url);
  fixtureCache = JSON.parse(readFileSync(url, 'utf8'));
  return fixtureCache;
}

/** Test seam: drop the memoised fixture so a rewritten file is picked up. */
export function resetFixtureCache() {
  fixtureCache = null;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export class FreebuffAgent extends AgentAdapter {
  /** @type {string} */
  apiKey;

  /** @param {{ apiKey?: string }} [overrides] */
  constructor({ apiKey = config.freebuff.apiKey } = {}) {
    // maxConcurrency is hardcoded to 1, always — see the file-level doc above.
    super({ pool: 'freebuff', label: 'Freebuff', maxConcurrency: 1 });
    this.apiKey = apiKey;
  }

  /** @returns {boolean} */
  isConfigured() {
    return Boolean(this.apiKey);
  }

  /* ---- AgentAdapter hooks --------------------------------------------------- */

  /**
   * @param {import('./AgentAdapter.js').AdapterTask} task
   * @param {string} sharedContext
   * @param {{ modelId?: string, signal?: AbortSignal }} options
   * @returns {Promise<{output: string, modelId?: string, tokensUsed?: number|null}>}
   */
  async _doExecute(task, sharedContext, options = {}) {
    if (config.dryRun) return this.#offlineExecute();

    if (!this.isConfigured()) {
      throw new AdapterError('Freebuff is not configured (missing FREEBUFF_API_KEY)', {
        code: 'NOT_CONFIGURED',
        retryable: false,
      });
    }

    const modelId = options.modelId ?? DEFAULT_MODEL_ID;
    const prompt = this._buildTaskPrompt(task, sharedContext);
    const json = await this.#callFreebuffApi(
      {
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1024,
        stream: false,
      },
      options.signal,
    );

    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      // A 200 with no recognisable content means the placeholder shape this
      // file was built against does not match the real API. Not retryable —
      // replaying the same request would produce the same unusable shape.
      throw new AdapterError('Freebuff returned no message content', {
        code: 'UPSTREAM_ERROR',
        retryable: false,
      });
    }

    const tokens = json?.usage?.total_tokens;
    return {
      output: text,
      modelId: typeof json?.model === 'string' ? json.model : modelId,
      tokensUsed: Number.isFinite(tokens) ? Number(tokens) : null,
    };
  }

  /** @returns {Promise<Array<{modelId: string, pool: string, contextWindow: number}>>} */
  async _doListModels() {
    if (config.dryRun) return loadFixture().models ?? [];
    // Live mode: Freebuff has no known models-list endpoint (UNVERIFIED — see
    // the file header). Until that is discovered, report the same single-entry
    // placeholder a live deployment would otherwise have no way to enumerate.
    // This is NOT a real catalog call.
    return loadFixture().models ?? [];
  }

  /**
   * @param {string} modelId
   * @param {{ strict?: boolean }} [opts]
   * @returns {Promise<string>}
   */
  async _doProbeCapabilities(modelId, opts = {}) {
    if (config.dryRun) return loadFixture().probe?.text ?? '';

    if (!this.isConfigured()) {
      throw new AdapterError('Freebuff is not configured (missing FREEBUFF_API_KEY)', {
        code: 'NOT_CONFIGURED',
        retryable: false,
      });
    }

    const prompt = buildProbePrompt(modelId, opts);
    const json = await this.#callFreebuffApi({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 512,
      stream: false,
    });

    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new AdapterError('Freebuff returned no message content', {
        code: 'UPSTREAM_ERROR',
        retryable: false,
      });
    }
    return text;
  }

  /* ---- offline paths --------------------------------------------------------- */

  /** @returns {Promise<{output: string, modelId: string, tokensUsed: number|null}>} */
  async #offlineExecute() {
    // Real (capped) delay so a burst of concurrent execute() calls actually
    // overlaps in time — see OFFLINE_SLEEP_MS.
    await sleep(OFFLINE_SLEEP_MS);
    const sample = loadFixture().chat ?? {};
    return {
      output: sample.text ?? '[offline fixture] no sample text for Freebuff.',
      modelId: sample.modelId ?? DEFAULT_MODEL_ID,
      tokensUsed: Number.isFinite(sample.tokensUsed) ? sample.tokensUsed : null,
    };
  }

  /* ---- the one isolated live HTTP call --------------------------------------- */

  /**
   * The entire live-mode network surface of this adapter. Isolated in one
   * method, on purpose, per the file-header note: fixing this adapter against
   * a real Freebuff API means changing this function and nothing else.
   *
   * Never called in offline mode — every caller above branches on
   * `config.dryRun` first.
   *
   * @param {Record<string, unknown>} payload OpenAI-shaped chat body (UNVERIFIED).
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>} Parsed JSON response body.
   */
  async #callFreebuffApi(payload, signal) {
    let res;
    try {
      res = await guardedFetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      // Transport-level failure (DNS, TLS, connection reset, offline-guard
      // violation). The request provably never produced an answer, so it is
      // safe to mark retryable.
      throw new AdapterError(
        `Freebuff unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { code: 'UPSTREAM_ERROR', retryable: true, cause: err },
      );
    }

    if (!res.ok) {
      // Deliberately not echoing the response body: upstream 4xx bodies
      // routinely echo the request back (including the prompt), and this
      // codebase's privacy rules say that text must never reach a log or the
      // dashboard (see services/base.js's safeUpstreamMessage). The status
      // code alone is enough to classify the failure.
      throw new AdapterError(`Freebuff rejected the request (${res.status})`, {
        code: 'UPSTREAM_ERROR',
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    try {
      return await res.json();
    } catch (err) {
      throw new AdapterError('Freebuff returned unparseable JSON', {
        code: 'UPSTREAM_ERROR',
        retryable: false,
        cause: err,
      });
    }
  }
}

export default FreebuffAgent;
