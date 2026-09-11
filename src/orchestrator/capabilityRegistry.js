/**
 * @file What each model is good at, and how it has actually performed.
 *
 * Two data sources feed one record per `modelId`:
 *
 *   1. A hard-coded seed table (below), shipped in code so the orchestrator
 *      works fully offline and before any probe has ever run.
 *   2. Live probes — a structured JSON prompt sent to the model itself,
 *      parsed defensively (models return malformed JSON constantly: fenced
 *      in ``` blocks, wrapped in prose, truncated) with one stricter retry
 *      before giving up and keeping the seed value.
 *
 * `observed` (per-model, per-category rolling stats) is fed by the scheduler
 * after every task completion — a simple running average, not a model.
 *
 * Persistence is fail-soft, matching the rest of this repo's state layer: a
 * missing or corrupt cache degrades to the seed table, never a thrown error.
 * The cache file (`state/agents.json`) is COMMITTED, like every other state
 * file — a GitHub Actions runner is wiped between pulses, so committed state
 * is the only thing that survives (see docs/RUNTIME.md). The seed table below
 * is what ships and gets reviewed; the committed cache accumulates real
 * observed stats across pulses.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../lib/logger.js';
import { ASPECT_CATEGORIES, isAspectCategory, isAgentPool, LATENCY_CLASSES } from './taxonomy.js';

const log = createLogger('orchestrator:capabilityRegistry');
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default on-disk cache location: `<repo root>/state/agents.json` — the
 *  pulse's own committed capability cache, not a gitignored scratch file. */
export const DEFAULT_CACHE_PATH = join(__dirname, '../../state/agents.json');

/** Entries older than this are re-probed in the background. 30 days. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Seed table                                                                  */
/*                                                                             */
/* Keys are `modelId` for a specific, well-known model, or `pool:default` as  */
/* a fallback for any model the orchestrator has not seen before — this is    */
/* the case for every OpenCode model (the catalog is config-driven, see       */
/* OPENCODE_BASE_URL) and for Freebuff before its first successful probe.     */
/*                                                                             */
/* The five `phase2:*` entries are informed judgement calls, not measured     */
/* fact: this file ships before any live probe has ever run, per the brief's  */
/* "works fully offline" requirement. They are deliberately conservative      */
/* (2-4 strengths, no more) and get overwritten by a real probe result the    */
/* first time one succeeds.                                                   */
/* -------------------------------------------------------------------------- */

const SEED_TABLE = Object.freeze({
  'phase2:groq': {
    pool: 'phase2',
    strengths: ['code-generation', 'debugging', 'refactoring', 'performance'],
    // NOTE: the brief's own example capability record lists "long-form-documentation"
    // as a weakness, but that value is not one of the 12 ASPECT_CATEGORIES — using
    // it here would silently break every taxonomy-membership check in this file
    // (see test 6 in orchestrator-capabilityRegistry.test.js, which caught this).
    // "documentation" is the closest real category, so that is what ships.
    weaknesses: ['documentation'],
    latencyClass: 'fast',
    contextWindow: 32768,
  },
  'phase2:openrouter': {
    pool: 'phase2',
    strengths: ['architecture', 'research', 'documentation'],
    weaknesses: [],
    latencyClass: 'medium',
    contextWindow: 32768,
  },
  'phase2:together': {
    pool: 'phase2',
    strengths: ['code-generation', 'testing', 'data-modeling'],
    weaknesses: [],
    latencyClass: 'medium',
    contextWindow: 32768,
  },
  'phase2:gemini': {
    pool: 'phase2',
    strengths: ['architecture', 'research', 'security-review', 'documentation'],
    weaknesses: [],
    latencyClass: 'medium',
    contextWindow: 1048576,
  },
  'phase2:huggingface': {
    pool: 'phase2',
    strengths: ['code-generation', 'ui-implementation'],
    weaknesses: ['architecture', 'security-review'],
    latencyClass: 'slow',
    contextWindow: 8192,
  },
  'freebuff:default': {
    pool: 'freebuff',
    strengths: ['architecture', 'research', 'security-review', 'data-modeling'],
    weaknesses: [],
    latencyClass: 'slow',
    contextWindow: 128000,
  },
  'opencode:default': {
    pool: 'opencode',
    // 'documentation' was added after Wave 4's engine-level end-to-end test
    // caught a real gap: with zero API keys configured (the offline default),
    // phase2Agent correctly preserves BaseProvider's existing "not_configured
    // even offline" behaviour (unchanged from Phase 2 — see phase2Agent.js's
    // header), so a task the seed table routes exclusively to phase2
    // providers cannot complete at all in a fresh, keyless clone. Every one
    // of the six aspects the offline sample graph (decomposer.js) actually
    // uses must have coverage from a pool that works unconditionally offline
    // — freebuff or opencode — and documentation had none before this line.
    //
    // 'security-review' was added for a subtler reason the same test caught:
    // freebuff also has 'security-review', but freebuff is excluded from a
    // ready task whenever a HIGHER-complexity task is ready in the same tick
    // (scheduler.js's reservation policy — see its file header). When that
    // happens, a task whose only real category match was freebuff falls back
    // to tied-at-zero candidates, and the tiebreak (latency class) can pick a
    // fast-but-unconfigured phase2 model over a correct-but-slower option —
    // wasting the final retry attempt on something that structurally cannot
    // succeed offline. Giving opencode the same strength means it wins that
    // scoring outright (a real 100-point category match beats every 0-point
    // tiebreak), independent of whichever task claims freebuff that tick.
    strengths: [
      'code-generation', 'refactoring', 'testing', 'ui-implementation',
      'devops', 'documentation', 'security-review',
    ],
    weaknesses: ['research'],
    latencyClass: 'medium',
    contextWindow: 32768,
  },
});

/**
 * @param {string} modelId
 * @returns {object} A fresh capability record built from the seed table.
 */
function seedRecordFor(modelId) {
  const pool = String(modelId).split(':')[0];
  const exact = SEED_TABLE[modelId];
  const fallback = SEED_TABLE[`${pool}:default`];
  const base = exact ?? fallback ?? {
    pool: isAgentPool(pool) ? pool : 'opencode',
    strengths: [],
    weaknesses: [],
    latencyClass: 'medium',
    contextWindow: 8192,
  };
  return {
    modelId,
    pool: base.pool,
    strengths: [...base.strengths],
    weaknesses: [...base.weaknesses],
    latencyClass: base.latencyClass,
    contextWindow: base.contextWindow,
    source: 'seed',
    probedAt: null,
    observed: {},
  };
}

/* -------------------------------------------------------------------------- */
/* Probe prompt + defensive JSON parsing                                      */
/* -------------------------------------------------------------------------- */

/**
 * The structured capability-probe prompt sent to a model. Adapters
 * (`agents/*.js`) pass this through `execute()`/their own probe path; this
 * function is the single place its wording lives so every pool asks the
 * same question the same way.
 * @param {string} modelId
 * @param {{ strict?: boolean }} [opts]
 * @returns {string}
 */
export function buildProbePrompt(modelId, { strict = false } = {}) {
  const categories = ASPECT_CATEGORIES.join(', ');
  const base =
    `You are describing your own capabilities as an AI coding model (id: ${modelId}). ` +
    `Respond with STRICT JSON ONLY, matching exactly this shape: ` +
    `{"strengths": string[], "weaknesses": string[], "latencyClass": "fast"|"medium"|"slow", "contextWindow": number}. ` +
    `"strengths" and "weaknesses" must only contain values from this fixed list: ${categories}. ` +
    `Pick 2-5 strengths and 0-3 weaknesses. "contextWindow" is your context window in tokens.`;
  if (!strict) return base;
  return (
    `${base} Your previous response could not be parsed as JSON. This time, output ONLY the ` +
    `JSON object and nothing else — no explanation, no markdown code fence, no leading or ` +
    `trailing text of any kind.`
  );
}

/**
 * Parse a model's raw probe response defensively. Models wrap JSON in
 * ``` fences, prepend "Sure, here's the JSON:", or truncate mid-object
 * constantly — this tries progressively looser strategies before giving up.
 * @param {unknown} raw
 * @returns {any|null} Parsed value, or null if nothing usable was found.
 */
export function parseProbeJson(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    // Fall through to a looser extraction.
  }

  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Validate and clamp a parsed probe response against the fixed taxonomy.
 * Returns null when nothing usable survives validation, signalling the
 * caller to retry (or fall back to the seed table).
 * @param {any} parsed
 * @param {string} modelId
 * @param {string} pool
 * @returns {object|null}
 */
export function sanitizeProbeResult(parsed, modelId, pool) {
  if (!parsed || typeof parsed !== 'object') return null;

  const strengths = Array.isArray(parsed.strengths)
    ? parsed.strengths.filter(isAspectCategory)
    : [];
  const weaknesses = Array.isArray(parsed.weaknesses)
    ? parsed.weaknesses.filter(isAspectCategory)
    : [];
  const latencyClass = LATENCY_CLASSES.includes(parsed.latencyClass) ? parsed.latencyClass : 'medium';
  const contextWindowRaw = Number(parsed.contextWindow);
  const contextWindow =
    Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? Math.round(contextWindowRaw) : null;

  // Nothing recognisable came through — this is what triggers the stricter retry.
  if (strengths.length === 0 && weaknesses.length === 0 && contextWindow === null) return null;

  return {
    modelId,
    pool,
    strengths,
    weaknesses,
    latencyClass,
    contextWindow: contextWindow ?? seedRecordFor(modelId).contextWindow,
    source: 'probe',
    probedAt: new Date().toISOString(),
    observed: {},
  };
}

/**
 * Probe one model through an adapter, with one stricter retry, falling back
 * to the seed table on total failure. Never throws — a probe failure is
 * data (the seed value, freshly timestamped so it backs off for 30 days),
 * not an error the caller must handle.
 * @param {string} modelId
 * @param {string} pool
 * @param {{ probeCapabilities: (modelId: string, opts?: object) => Promise<string> }} adapter
 * @returns {Promise<object>}
 */
export async function probeModel(modelId, pool, adapter) {
  let sanitized = null;

  try {
    const raw = await adapter.probeCapabilities(modelId);
    sanitized = sanitizeProbeResult(parseProbeJson(raw), modelId, pool);
  } catch (err) {
    log.debug('capability probe failed', { modelId, error: String(err) });
  }

  if (!sanitized) {
    try {
      const raw = await adapter.probeCapabilities(modelId, { strict: true });
      sanitized = sanitizeProbeResult(parseProbeJson(raw), modelId, pool);
    } catch (err) {
      log.debug('capability probe strict retry failed', { modelId, error: String(err) });
    }
  }

  if (sanitized) return sanitized;

  // Total failure: keep the seed value, but stamp probedAt so isStale() backs
  // this model off for 30 days instead of re-probing it on every boot.
  const fallback = seedRecordFor(modelId);
  fallback.pool = pool;
  fallback.probedAt = new Date().toISOString();
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export class CapabilityRegistry {
  /** @type {Map<string, object>} */
  #records = new Map();
  #loaded = false;
  #cachePath;

  /** @param {string} [cachePath] Injectable for tests; defaults to the real cache file. */
  constructor(cachePath = DEFAULT_CACHE_PATH) {
    this.#cachePath = cachePath;
  }

  /** Read the on-disk cache once, lazily. Corrupt/missing file -> seed-only. */
  load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      if (existsSync(this.#cachePath)) {
        const raw = JSON.parse(readFileSync(this.#cachePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          for (const [modelId, record] of Object.entries(raw)) {
            if (record && typeof record === 'object') this.#records.set(modelId, record);
          }
        }
      }
    } catch (err) {
      log.warn('capabilities cache unreadable — starting from the seed table only', {
        error: String(err),
      });
    }
  }

  /** Persist the current in-memory table. Never throws. */
  save() {
    try {
      mkdirSync(dirname(this.#cachePath), { recursive: true });
      /** @type {Record<string, object>} */
      const out = {};
      for (const [modelId, record] of this.#records) out[modelId] = record;
      writeFileSync(this.#cachePath, JSON.stringify(out, null, 2), 'utf8');
    } catch (err) {
      log.warn('capabilities cache write failed — continuing in-memory only', {
        error: String(err),
      });
    }
  }

  /**
   * A model's current record. Seeds and caches it on first access so the
   * registry "works before any probe completes" even for a model that has
   * never been queried before.
   * @param {string} modelId
   * @returns {object}
   */
  get(modelId) {
    this.load();
    const cached = this.#records.get(modelId);
    if (cached) return cached;
    const seeded = seedRecordFor(modelId);
    this.#records.set(modelId, seeded);
    return seeded;
  }

  /** @returns {object[]} Every known record, including untouched seed entries. */
  list() {
    this.load();
    for (const key of Object.keys(SEED_TABLE)) {
      if (!key.endsWith(':default') && !this.#records.has(key)) this.get(key);
    }
    return [...this.#records.values()];
  }

  /**
   * @param {object} record
   * @returns {boolean} True when never probed, or probed >30 days ago.
   */
  isStale(record) {
    if (!record?.probedAt) return true;
    const at = Date.parse(record.probedAt);
    if (!Number.isFinite(at)) return true;
    return Date.now() - at > STALE_MS;
  }

  /**
   * Merge a fresh record in, preserving accumulated `observed` stats (a
   * re-probe describes strengths/weaknesses/latency; it must not wipe out
   * performance history the scheduler has been building).
   * @param {object} record
   * @returns {object}
   */
  setRecord(record) {
    this.load();
    const existing = this.#records.get(record.modelId);
    const merged = { ...record, observed: existing?.observed ?? record.observed ?? {} };
    this.#records.set(record.modelId, merged);
    return merged;
  }

  /**
   * Probe one model and store the result.
   * @param {string} modelId
   * @param {string} pool
   * @param {object} adapter
   * @returns {Promise<object>}
   */
  async refresh(modelId, pool, adapter) {
    const result = await probeModel(modelId, pool, adapter);
    const merged = this.setRecord(result);
    this.save();
    return merged;
  }

  /**
   * Probe every model every configured adapter reports via `listModels()`.
   * Used by the `POST /api/orchestrate/capabilities/refresh` route.
   * @param {Record<string, { listModels: () => Promise<Array<{modelId: string}>>, probeCapabilities: Function }>} adapters
   * @returns {Promise<object[]>}
   */
  async refreshAll(adapters) {
    const results = [];
    for (const [pool, adapter] of Object.entries(adapters ?? {})) {
      if (!adapter || typeof adapter.listModels !== 'function') continue;
      let models = [];
      try {
        models = await adapter.listModels();
      } catch (err) {
        log.warn('listModels failed during capability refresh', { pool, error: String(err) });
        continue;
      }
      for (const m of models ?? []) {
        const modelId = m?.modelId ?? `${pool}:${m}`;
        results.push(await this.refresh(modelId, pool, adapter));
      }
    }
    return results;
  }

  /**
   * Background maintenance: re-probe only entries stale by more than 30
   * days. Cheap to call on a timer or at boot.
   * @param {Record<string, object>} adapters
   * @returns {Promise<object[]>}
   */
  async refreshStale(adapters) {
    const stale = this.list().filter((r) => this.isStale(r));
    const results = [];
    for (const record of stale) {
      const adapter = adapters?.[record.pool];
      if (!adapter) continue;
      results.push(await this.refresh(record.modelId, record.pool, adapter));
    }
    return results;
  }

  /**
   * Roll one task outcome into a model's per-category observed stats. A
   * plain running average — no ML, per the brief.
   * @param {string} modelId
   * @param {string} category One of ASPECT_CATEGORIES.
   * @param {{ success: boolean, ms: number }} outcome
   * @returns {object} The updated record.
   */
  recordObservation(modelId, category, { success, ms }) {
    this.load();
    const record = this.get(modelId);
    if (!isAspectCategory(category)) return record;

    const prior = record.observed[category] ?? { runs: 0, successRate: 0, avgMs: 0 };
    const runs = prior.runs + 1;
    const successRate = (prior.successRate * prior.runs + (success ? 1 : 0)) / runs;
    const avgMs = Number.isFinite(ms)
      ? Math.round((prior.avgMs * prior.runs + ms) / runs)
      : prior.avgMs;

    record.observed = { ...record.observed, [category]: { runs, successRate, avgMs } };
    this.#records.set(modelId, record);
    this.save();
    return record;
  }

  /**
   * Test-only: wipe every accumulated record — in memory AND on disk — back
   * to nothing, so the next `get()` reseeds from `SEED_TABLE` alone.
   *
   * Exists specifically because `pulse.js` imports the module-level
   * `capabilityRegistry` singleton (correctly — production routing must
   * learn across real runs, so a fresh instance per call would defeat the
   * point). Tests exercising that singleton record real observations to the
   * real on-disk cache; without a reset between runs, repeated `npm test`
   * invocations accumulate observed data that can flip routing decisions
   * between otherwise-identical test runs.
   */
  resetForTests() {
    this.#records.clear();
    this.#loaded = true; // block load() from re-reading the disk file this call is about to overwrite
    try {
      writeFileSync(this.#cachePath, '{}', 'utf8');
    } catch {
      // Best-effort — an unwritable cache path degrades to in-memory-only
      // reset, which is still enough to fix the immediate test run.
    }
  }
}

export const capabilityRegistry = new CapabilityRegistry();
export default capabilityRegistry;
