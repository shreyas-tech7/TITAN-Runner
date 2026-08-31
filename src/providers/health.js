/**
 * @file Provider health/routing state — `state/providers.json`.
 *
 * Task instructions (section 6) ask for a router that "picks among healthy
 * providers only" and skips "a dead or exhausted provider... not retried
 * into a failed pulse." The original `registry.js` deliberately shipped
 * without a health cache (see its file header) because a pulse calling each
 * provider a handful of times every ~15 minutes did not seem to need one —
 * but with real credentials in play, a provider that is rate-limited,
 * quota-exhausted, or misconfigured must stop being retried mid-pulse and
 * across pulses until it recovers, or every claimed task pays for its
 * failure. This module is the minimal state needed for that, structured the
 * same way `orchestrator/capabilityRegistry.js` structures its own cache:
 * an injectable-path class wrapping an in-memory table, loaded lazily,
 * saved explicitly, corrupt-file-safe.
 *
 * `state/providers.json` is also the one file `docs/RUNTIME.md`'s new
 * provider-health section and the dashboard's provider strip both read —
 * written here (routing-relevant fields, updated live during a pulse) and
 * by `scripts/provider-selftest.mjs` (model discovery + a real probe,
 * updated on its own weekly/manual schedule). Both writers touch the same
 * shape; the later write always wins, which is fine — this is health
 * telemetry, not a ledger.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactString } from '../lib/redact.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('providers:health');

export const DEFAULT_PROVIDERS_PATH = join(process.cwd(), 'state', 'providers.json');

/** @type {readonly string[]} Every status this module ever assigns. */
export const PROVIDER_STATUSES = Object.freeze([
  'not_configured', // no key set — never a failure, never surfaced as one
  'ok',
  'misconfigured', // 401/403 — bad/expired key; never auto-retried, needs a human fix
  'rate_limited', // 429 — temporary, exponential-backoff cooldown
  'exhausted', // quota/balance used up — cooldown until an assumed reset
  'model_invalid', // model-not-found — cached model id invalidated, short cooldown, rediscover
  'no_public_api', // e.g. Freebuff — there is nothing to call, configured or not
  'error', // anything else upstream
  'unknown', // never checked
]);

const RATE_LIMIT_BASE_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 60 * 60_000;
const EXHAUSTED_DEFAULT_COOLDOWN_MS = 24 * 60 * 60_000;
const MODEL_INVALID_COOLDOWN_MS = 10 * 60_000;
const MAX_ERROR_CHARS = 300;

/** @param {string} id @returns {object} A fresh, empty record. */
function emptyRecord(id) {
  return {
    id,
    configured: false,
    status: 'unknown',
    lastCheckedAt: null,
    lastSuccessAt: null,
    latencyMs: null,
    p50LatencyMs: null,
    samples: 0,
    errorRate: 0,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastError: null,
    model: null,
    discoveredModels: [],
    modelsDiscoveredAt: null,
    note: null,
  };
}

function backoffCooldownMs(consecutiveFailures) {
  const ms = RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(ms, RATE_LIMIT_MAX_COOLDOWN_MS);
}

export class ProviderHealthStore {
  /** @type {Map<string, object>} */
  #records = new Map();
  #loaded = false;
  #path;

  /** @param {string} [path] Injectable for tests; defaults to the real state file. */
  constructor(path = DEFAULT_PROVIDERS_PATH) {
    this.#path = path;
  }

  load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      if (existsSync(this.#path)) {
        const raw = JSON.parse(readFileSync(this.#path, 'utf8'));
        const providers = raw && typeof raw === 'object' && raw.providers ? raw.providers : {};
        for (const [id, record] of Object.entries(providers)) {
          if (record && typeof record === 'object') this.#records.set(id, record);
        }
      }
    } catch (err) {
      log.warn('providers.json unreadable — starting from an empty health table', { error: String(err) });
    }
  }

  /** @param {string} id @returns {object} */
  get(id) {
    this.load();
    return { ...emptyRecord(id), ...(this.#records.get(id) ?? {}) };
  }

  /** @returns {object[]} */
  list() {
    this.load();
    return [...this.#records.keys()].map((id) => this.get(id));
  }

  /**
   * Is this provider currently worth routing to? False for an unconfigured,
   * misconfigured, no-public-API, or still-cooling-down provider — the
   * router filters on exactly this before ever attempting a call.
   * @param {string} id
   * @returns {boolean}
   */
  isHealthy(id) {
    const rec = this.get(id);
    if (!rec.configured) return false;
    if (rec.status === 'misconfigured' || rec.status === 'no_public_api') return false;
    if (rec.cooldownUntil && Date.parse(rec.cooldownUntil) > Date.now()) return false;
    return true;
  }

  /**
   * A provider that has no key at all. Set once, e.g. at pulse start, so a
   * provider nobody configured always reads `not_configured` even if it is
   * never actually attempted this pulse.
   * @param {string} id
   */
  markNotConfigured(id) {
    this.load();
    const prev = this.get(id);
    this.#records.set(id, { ...prev, id, configured: false, status: 'not_configured', cooldownUntil: null });
  }

  /**
   * A provider that HAS a key. Set once, e.g. at pulse start, alongside
   * `markNotConfigured()` for the ones that don't — without this, a
   * never-yet-attempted provider on a fresh `state/providers.json` (no
   * self-test has run, no live call has ever succeeded or failed) would
   * default to `configured: false` from `emptyRecord()` and `isHealthy()`
   * would refuse to ever attempt it, which is exactly the deadlock a health
   * gate must not create. Leaves an existing status/cooldown/model alone —
   * this only ever flips `configured` on; `status` stays `'unknown'` until
   * a real attempt (via `recordOutcome`) says otherwise.
   * @param {string} id
   */
  markConfigured(id) {
    this.load();
    const prev = this.get(id);
    if (prev.configured) return; // already tracked with real status/cooldown state
    // A key just appeared (or this id has never been recorded at all) — flip
    // to configured and, if the only status on file was the stale
    // "not_configured" label, clear it to "unknown" rather than leave a
    // configured provider reporting itself as unconfigured.
    const status = prev.status === 'not_configured' ? 'unknown' : prev.status;
    this.#records.set(id, { ...prev, id, configured: true, status });
  }

  /**
   * A provider with no legitimate public API to call (Freebuff — see
   * `docs/RUNTIME.md`'s provider section). Distinct from every other status:
   * never attempted, never reported as broken, never asked to recover.
   * @param {string} id
   * @param {string} [note]
   */
  markNoPublicApi(id, note) {
    this.load();
    const prev = this.get(id);
    this.#records.set(id, {
      ...prev, id, status: 'no_public_api', cooldownUntil: null,
      note: note ? redactString(note).slice(0, MAX_ERROR_CHARS) : prev.note,
    });
  }

  /**
   * Record one real call's outcome (success or failure) and reclassify
   * status/cooldown accordingly. This is the routing signal the registry
   * checks before every attempt, and the raw material for the dashboard's
   * provider-health strip (last success, rolling p50 latency, error state).
   * @param {string} id
   * @param {{ok:boolean, latencyMs?:number, model?:string, code?:string,
   *   status?:number|null, retryAfterMs?:number|null, message?:string}} outcome
   * @returns {object} The updated record.
   */
  recordOutcome(id, outcome) {
    this.load();
    const prev = this.get(id);
    const now = new Date();
    /** @type {any} */
    const next = { ...prev, id, configured: true, lastCheckedAt: now.toISOString(), samples: prev.samples + 1 };
    // Exponential moving average, not a true rolling window — same
    // "plain average, no ML" rule as p50LatencyMs above. alpha=0.3 means a
    // handful of recent calls dominate the number, which is what "is this
    // provider healthy right now" should reflect, not all-time history.
    next.errorRate = Math.round((prev.errorRate * 0.7 + (outcome.ok ? 0 : 0.3)) * 1000) / 1000;

    if (outcome.ok) {
      next.status = 'ok';
      next.lastSuccessAt = now.toISOString();
      if (Number.isFinite(outcome.latencyMs)) {
        next.latencyMs = outcome.latencyMs;
        // A running average, not a true percentile — consistent with this
        // codebase's "plain running average, no ML" rule elsewhere
        // (capabilityRegistry.js's recordObservation).
        next.p50LatencyMs = next.p50LatencyMs == null
          ? outcome.latencyMs
          : Math.round((next.p50LatencyMs + outcome.latencyMs) / 2);
      }
      if (outcome.model) next.model = outcome.model;
      next.consecutiveFailures = 0;
      next.cooldownUntil = null;
      next.lastError = null;
    } else {
      next.consecutiveFailures = prev.consecutiveFailures + 1;
      if (outcome.message) next.lastError = redactString(outcome.message).slice(0, MAX_ERROR_CHARS);

      const status = outcome.status ?? null;
      const code = outcome.code ?? '';
      const msg = outcome.message ?? '';

      if (code === 'NOT_CONFIGURED') {
        next.configured = false;
        next.status = 'not_configured';
        next.cooldownUntil = null;
      } else if (code === 'NO_PUBLIC_API') {
        // Freebuff, or any future pool with no real API to call at all —
        // permanent, not a failure to recover from.
        next.status = 'no_public_api';
        next.cooldownUntil = null;
      } else if (status === 401 || status === 403 || code === 'UNAUTHORIZED') {
        // Auth failures never self-heal — no cooldown timer, no auto-retry.
        // Only a fresh success (a maintainer rotated the key) clears this.
        next.status = 'misconfigured';
        next.cooldownUntil = null;
      } else if (status === 429 || code === 'RATE_LIMITED') {
        next.status = 'rate_limited';
        const cooldownMs = outcome.retryAfterMs && outcome.retryAfterMs > 0
          ? Math.min(outcome.retryAfterMs, RATE_LIMIT_MAX_COOLDOWN_MS)
          : backoffCooldownMs(next.consecutiveFailures);
        next.cooldownUntil = new Date(now.getTime() + cooldownMs).toISOString();
      } else if (status === 402 || /quota|insufficient[_ -]?(balance|credit)|out of credits/i.test(msg)) {
        next.status = 'exhausted';
        next.cooldownUntil = new Date(now.getTime() + EXHAUSTED_DEFAULT_COOLDOWN_MS).toISOString();
      } else if (status === 404 || /model[_ -]?not[_ -]?found|does not exist|unknown model|invalid model/i.test(msg)) {
        next.status = 'model_invalid';
        next.model = null; // force the next discovery cycle to pick a fresh one
        next.cooldownUntil = new Date(now.getTime() + MODEL_INVALID_COOLDOWN_MS).toISOString();
      } else {
        next.status = 'error';
        next.cooldownUntil = new Date(now.getTime() + backoffCooldownMs(next.consecutiveFailures)).toISOString();
      }
    }

    this.#records.set(id, next);
    return next;
  }

  /**
   * Merge freshly discovered model ids in (from `modelDiscovery.js`),
   * without disturbing routing/health fields a concurrent `recordOutcome`
   * call may have just set.
   * @param {string} id
   * @param {string[]} models
   * @param {string|null} [chosen] The one model future calls should use.
   */
  setDiscoveredModels(id, models, chosen = null) {
    this.load();
    const prev = this.get(id);
    this.#records.set(id, {
      ...prev,
      id,
      discoveredModels: models,
      modelsDiscoveredAt: new Date().toISOString(),
      model: chosen ?? prev.model,
    });
  }

  /** Persist the current in-memory table. Never throws. */
  save() {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      /** @type {Record<string, object>} */
      const providers = {};
      for (const [id, record] of this.#records) providers[id] = record;
      const payload = { version: 1, updatedAt: new Date().toISOString(), providers };
      const tmp = `${this.#path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.#path);
    } catch (err) {
      log.warn('providers.json write failed — continuing in-memory only', { error: String(err) });
    }
  }
}

export const providerHealth = new ProviderHealthStore();
export default providerHealth;
