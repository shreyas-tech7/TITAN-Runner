// RESEARCHED, NOT A LIVE INTEGRATION — see the file header below.
//
// This was shipped as a placeholder wired to a guessed OpenAI-compatible
// shape at `https://api.freebuff.dev/v1`, because Freebuff's real contract
// could not be confirmed at build time. Task instructions (section 6) asked
// for every provider to be re-confirmed against its current docs before
// being wired up live. Checked now: "Freebuff" (freebuff.com) is a
// consumer coding-agent product (CLI/desktop/web), ad-supported, that
// explicitly requires **no API key at all** for its own product — there is
// no official `FREEBUFF_API_KEY`-shaped developer API. The only things
// online matching an OpenAI-compatible `/v1/chat/completions` shape for
// "Freebuff" are third-party, unofficial reverse-engineering proxies of
// that consumer product's session internals (e.g. community "-2API" /
// "-proxy" GitHub repos) — not something this repo will depend on: it is
// almost certainly against Freebuff's terms of service, has no stability
// guarantee, and "free forever, zero maintenance" cannot be built on
// someone else's unofficial scraper going down without notice.
//
// So this adapter's live path is intentionally disabled rather than wired
// to any of that — see `_doExecute`/`_doProbeCapabilities` below. It fails
// immediately and honestly (`NO_PUBLIC_API`, never attempted, never
// retried) instead of pretending a real call was tried. `providers/health.js`
// reports this same status to the dashboard, distinct from "not configured"
// and from "misconfigured" — nothing is wrong with a key here, because
// there is no key that would ever make this work.

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
 * end against fixtures. `isConfigured()` still gates real reporting and is
 * still meaningful for that purpose; it just is not a gate on offline
 * fixture behaviour.
 */

import { readFileSync } from 'node:fs';

import { config } from '../config.js';
import { AdapterError, AgentAdapter } from './AgentAdapter.js';

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
  async _doExecute(_task, _sharedContext, _options = {}) {
    if (config.dryRun) return this.#offlineExecute();
    throw noPublicApiError();
  }

  /** @returns {Promise<Array<{modelId: string, pool: string, contextWindow: number}>>} */
  async _doListModels() {
    if (config.dryRun) return loadFixture().models ?? [];
    // Live mode: no real catalog to enumerate — see the file header. Return
    // nothing rather than the offline fixture, so a live scheduler never
    // mistakes it for a real, callable model.
    return [];
  }

  /**
   * @param {string} modelId
   * @param {{ strict?: boolean }} [opts]
   * @returns {Promise<string>}
   */
  async _doProbeCapabilities(_modelId, _opts = {}) {
    if (config.dryRun) return loadFixture().probe?.text ?? '';
    throw noPublicApiError();
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
}

/** @returns {AdapterError} */
function noPublicApiError() {
  return new AdapterError(
    'Freebuff has no official public API for third-party integration — this pool is never attempted live. See src/agents/freebuffAgent.js.',
    { code: 'NO_PUBLIC_API', retryable: false },
  );
}

export default FreebuffAgent;
