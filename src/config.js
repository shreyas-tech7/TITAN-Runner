/**
 * @file Single source of truth for TITAN-Runner configuration.
 *
 * Unlike the original TITAN backend this config carries no vault path, no
 * host/auth/login settings, and no personal defaults (weather lat/lon,
 * operator name, etc.) — this process never runs a server and never touches
 * a filesystem outside its own repo checkout. Everything here is either a
 * provider credential (optional; a missing one just means that provider
 * reports not_configured) or an orchestration tuning knob.
 */

function credential(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (value.length === 0) return '';
  if (/^(?:your[_-].*|<.*>|xxx+|changeme|todo|tbd|none|null|placeholder)$/i.test(value)) return '';
  return value;
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = Object.freeze({
  dryRun: process.env.TITAN_DRY_RUN === '1',

  github: {
    token: credential(process.env.GITHUB_TOKEN),
    repository: process.env.GITHUB_REPOSITORY || '',
    runId: process.env.GITHUB_RUN_ID || '',
  },

  groq: {
    apiKey: credential(process.env.GROQ_API_KEY),
    // Empty unless a human explicitly pins one — see DEFAULT_MODELS/resolveModel()
    // below for what actually gets used when this is unset.
    model: process.env.GROQ_MODEL?.trim() || '',
  },
  together: {
    apiKey: credential(process.env.TOGETHER_API_KEY),
    model: process.env.TOGETHER_MODEL?.trim() || '',
  },
  openrouter: {
    apiKey: credential(process.env.OPENROUTER_API_KEY),
    model: process.env.OPENROUTER_MODEL?.trim() || '',
  },
  gemini: {
    apiKey: credential(process.env.GEMINI_API_KEY),
    model: process.env.GEMINI_MODEL?.trim() || '',
  },
  huggingface: {
    // The real env var is HF_API_KEY, not HUGGINGFACE_API_KEY — see README.
    apiKey: credential(process.env.HF_API_KEY),
    model: process.env.HF_MODEL?.trim() || '',
  },
  freebuff: {
    // No baseUrl: Freebuff has no official public API to point one at — see
    // agents/freebuffAgent.js. The key is still read (and reported as
    // configured-but-unused, never "misconfigured") in case that changes.
    apiKey: credential(process.env.FREEBUFF_API_KEY),
  },
  opencode: {
    apiKey: credential(process.env.OPENCODE_API_KEY),
    baseUrl: (process.env.OPENCODE_BASE_URL?.trim() || 'https://opencode.ai/zen').replace(/\/+$/, ''),
  },

  orchestrator: {
    maxTasksPerPulse: positiveInt(process.env.TITAN_MAX_TASKS_PER_PULSE, 3),
    maxSubtasksPerRun: positiveInt(process.env.TITAN_MAX_SUBTASKS_PER_RUN, 8),
    maxOpenCode: positiveInt(process.env.TITAN_MAX_OPENCODE, 4),
    taskTimeoutMs: positiveInt(process.env.TITAN_TASK_TIMEOUT_MS, 120000),
    // 0 disables: a task may sit in the queue forever, exactly as before.
    // Set (e.g. TITAN_TASK_TTL_MS=259200000 for 72h) to expire a pending
    // task that was never claimed instead of running it stale.
    taskTtlMs: positiveInt(process.env.TITAN_TASK_TTL_MS, 0),
    maxTaskRetries: positiveInt(process.env.TITAN_MAX_TASK_RETRIES, 3),
  },

  reviewer: {
    // Default ON in this repo (unlike the original backend's default-off) —
    // every pulse dispatches to a public, world-readable state store, so the
    // safety gate stays on unless a maintainer deliberately turns it off.
    enabled: process.env.TITAN_REVIEWER !== '0',
    timeoutMs: positiveInt(process.env.TITAN_REVIEWER_TIMEOUT_MS, 8000),
  },

  retention: {
    maxRunFiles: positiveInt(process.env.TITAN_MAX_RUN_FILES, 60),
    maxReviewLines: positiveInt(process.env.TITAN_MAX_REVIEW_LINES, 5000),
  },
});

export function isProviderConfigured(id) {
  switch (id) {
    case 'groq':
      return config.groq.apiKey.length > 0;
    case 'together':
      return config.together.apiKey.length > 0;
    case 'openrouter':
      return config.openrouter.apiKey.length > 0;
    case 'gemini':
      return config.gemini.apiKey.length > 0;
    case 'huggingface':
      return config.huggingface.apiKey.length > 0;
    case 'freebuff':
      return config.freebuff.apiKey.length > 0;
    case 'opencode':
      return config.opencode.apiKey.length > 0;
    default:
      return false;
  }
}

/**
 * Last-resort model ids — used only when a human has not pinned one via
 * `*_MODEL` AND `state/providers.json` carries no live-discovered model yet
 * (a fresh checkout, or every discovery attempt has failed). See
 * `resolveModel()`; kept here rather than baked into each `*_MODEL` default
 * above so a churned free-tier id never requires an env var change to fix —
 * task instructions, section 6: "a hardcoded ID is a silent outage later."
 * @type {Record<string, string>}
 */
export const DEFAULT_MODELS = Object.freeze({
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
  openrouter: 'openai/gpt-oss-20b:free',
  gemini: 'gemini-2.5-flash',
  huggingface: 'meta-llama/Llama-3.1-8B-Instruct',
});

/**
 * Precedence: an explicit `*_MODEL` env var (a human pinned this on
 * purpose) > the model `scripts/provider-selftest.mjs` last discovered and
 * cached in `state/providers.json` > the hardcoded last-resort above.
 * @param {'groq'|'together'|'openrouter'|'gemini'|'huggingface'} id
 * @param {string|null|undefined} cachedModel From `providerHealth.get(id).model`.
 * @returns {string}
 */
export function resolveModel(id, cachedModel) {
  const pinned = config[id]?.model;
  if (pinned) return pinned;
  if (cachedModel) return cachedModel;
  return DEFAULT_MODELS[id] ?? '';
}

export default config;
