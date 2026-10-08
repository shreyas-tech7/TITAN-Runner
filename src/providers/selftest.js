/**
 * @file The provider proof (Wave 12, K5). One function proves one provider in a real runner: it lists models, then
 * sends one completion of 8 tokens or less. `scripts/provider-selftest.mjs` calls it and posts the result to the Worker
 * route `/internal/provider-proof`. The result holds a model name, a latency, and a short fixed text. It never holds a
 * key, and the error text passes through `redactString` before it leaves.
 *
 * A Hermes agent can act on its own host, so the proof sends it no prompt. It lists models only.
 */
import { config, isProviderConfigured } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { redactString } from '../lib/redact.js';
import { getCatalogProvider } from './catalog.js';
import { OpenAICompatProvider } from './openaiCompat.js';

export const PROOF_PROMPT = 'Reply with exactly one word: OK';
export const PROOF_MAX_TOKENS = 8;

/** A short, safe description of an error. It names the class so the Worker can pick a state. */
export function describeProofError(err) {
  const text = redactString(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
  return text || 'The call failed.';
}

/**
 * @param {string} id A catalog provider id.
 * @param {{ discover?: Record<string, Function>, makeProvider?: (id: string) => any, fetchImpl?: typeof guardedFetch, opencode?: () => any }} [deps]
 * @returns {Promise<{ skipped?: boolean, ok: boolean, model: string|null, latencyMs: number|null, detail: string, listed: number }>}
 */
export async function proveProvider(id, deps = {}) {
  const entry = getCatalogProvider(id);
  if (!entry) return { ok: false, model: null, latencyMs: null, detail: 'This provider is not in the catalog.', listed: 0 };
  if (id === 'freebuff') return { skipped: true, ok: false, model: null, latencyMs: null, detail: entry.unverifiableReason ?? 'No public API.', listed: 0 };
  if (!isProviderConfigured(id)) return { ok: false, model: null, latencyMs: null, detail: 'The key is not set in this run.', listed: 0 };

  const fetchImpl = deps.fetchImpl ?? guardedFetch;

  // Hermes: a list only. No prompt goes to an agent.
  if (id.startsWith('hermes_')) {
    const n = id.split('_')[1];
    const base = (process.env[`HERMES_${n}_BASE_URL`] ?? '').replace(/\/+$/, '');
    const key = process.env[`HERMES_${n}_API_KEY`] ?? '';
    const started = performance.now();
    try {
      const res = await fetchImpl(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 10_000, redirect: 'manual' });
      const latencyMs = Math.round(performance.now() - started);
      if (res.ok) return { ok: true, model: process.env[`HERMES_${n}_MODEL`] || 'hermes-agent', latencyMs, detail: 'The model list answered. No prompt was sent to the agent.', listed: 1 };
      return { ok: false, model: null, latencyMs, detail: `The agent answered ${res.status} to the model list.`, listed: 0 };
    } catch (err) {
      return { ok: false, model: null, latencyMs: null, detail: describeProofError(err), listed: 0 };
    }
  }

  // The model list.
  let listed = 0;
  const discover = deps.discover?.[id];
  if (discover) {
    try {
      const slot = config[id] ?? config.custom.find((c) => c.id === id);
      const models = await discover({ apiKey: slot?.apiKey, baseUrl: entry.chat?.baseUrl?.replace('{baseUrl}', slot?.baseUrl ?? ''), preferredModel: slot?.model || null });
      listed = Array.isArray(models) ? models.length : 0;
      // Remember the first model for this run only. Nothing is saved to disk, so a proof never makes a commit.
      if (listed > 0 && entry.failover === 'direct') (deps.health ?? (await import('./health.js')).providerHealth).setDiscoveredModels(id, models, models[0]);
    } catch {
      listed = 0;
    }
  }

  const started = performance.now();
  try {
    let result;
    if (id === 'opencode') {
      const agent = deps.opencode ? deps.opencode() : new (await import('../agents/opencodeAgent.js')).OpenCodeAgent();
      result = await agent.selfTestChat(PROOF_PROMPT, { maxTokens: PROOF_MAX_TOKENS });
    } else {
      const provider = deps.makeProvider ? deps.makeProvider(id) : await defaultProvider(id);
      result = await provider.chat([{ role: 'user', content: PROOF_PROMPT }], { maxTokens: PROOF_MAX_TOKENS, temperature: 0 });
    }
    return { ok: true, model: result.model ?? null, latencyMs: Math.round(performance.now() - started), detail: 'The completion worked.', listed };
  } catch (err) {
    return { ok: false, model: null, latencyMs: Math.round(performance.now() - started), detail: describeProofError(err), listed };
  }
}

async function defaultProvider(id) {
  if (id.startsWith('custom_')) {
    const slot = config.custom.find((c) => c.id === id);
    return new OpenAICompatProvider({ id, label: slot.label, baseUrl: slot.baseUrl, apiKey: slot.apiKey, model: slot.model });
  }
  if (id === 'omniroute') return new (await import('./omniroute.js')).OmniRouteProvider();
  const classes = {
    groq: ['./groq.js', 'GroqProvider'],
    together: ['./together.js', 'TogetherProvider'],
    openrouter: ['./openrouter.js', 'OpenRouterProvider'],
    gemini: ['./gemini.js', 'GeminiProvider'],
    huggingface: ['./huggingface.js', 'HuggingFaceProvider'],
  };
  const spec = classes[id];
  if (!spec) throw new Error('No adapter for this provider.');
  const mod = await import(spec[0]);
  return new mod[spec[1]]();
}
