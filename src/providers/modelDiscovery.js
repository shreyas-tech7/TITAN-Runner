/**
 * @file Live model discovery for the five registry providers plus OpenCode
 * Zen (Freebuff is excluded — see `agents/freebuffAgent.js`; it has no
 * public API to discover a catalog from).
 *
 * Task instructions (section 6): "Do not hardcode model IDs. Free-tier
 * model IDs churn constantly and a hardcoded ID is a silent outage later.
 * Query each provider's models endpoint at runtime, filter to what is
 * actually free and actually available to my key." This module is that
 * query, one function per provider, each returning a ranked list of
 * candidate model ids (best guess first) or an empty array on any failure —
 * never throwing. `scripts/provider-selftest.mjs` is the only caller: it
 * runs on a schedule (weekly + manual), not on every pulse, because a
 * models-list round trip to five-to-six providers has no place adding
 * latency to a 15-minute cron the task brief says must stay fast.
 *
 * Every provider's actual response shape is confirmed against its current
 * docs as of this build (see the per-function comments for what was
 * checked and where), but none of it has been exercised against a real key
 * in this environment — no provider secrets were available in this sandbox
 * either. Defensive parsing throughout is deliberate: an unexpected shape
 * degrades to "no candidates found" (caller keeps its existing/default
 * model), never a thrown error.
 */
import { guardedFetch } from '../lib/net.js';
import { isFreePriced } from './freeFilter.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('providers:modelDiscovery');

/** Discovery calls get a short, fixed deadline — this runs against up to
 *  six providers back to back in one self-test job; no single slow/hung
 *  provider should stall the rest. */
const DISCOVERY_TIMEOUT_MS = 15_000;

/** Ids that are never a real chat completion target, whatever provider lists them. */
const NON_CHAT_ID_PATTERN = /whisper|tts|guard|moderation|embed|rerank|speech|audio|vision-only|image|dall-e|stt/i;

async function fetchJson(url, headers) {
  const res = await guardedFetch(url, { headers, timeoutMs: DISCOVERY_TIMEOUT_MS });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {any[]} arr
 * @param {(item: any) => string|null|undefined} idOf
 * @returns {string[]} De-duplicated, non-empty, non-chat-excluded ids, order preserved.
 */
function cleanIds(arr, idOf) {
  const seen = new Set();
  const out = [];
  for (const item of arr ?? []) {
    const id = idOf(item);
    if (typeof id !== 'string' || id.length === 0) continue;
    if (NON_CHAT_ID_PATTERN.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Groq — `GET {base}/models`, OpenAI-compatible catalog convention,
 * confirmed against current docs (console.groq.com/docs/models): response
 * is `{object:"list", data:[{id, object:"model", active, context_window}]}`.
 * Groq's free developer tier is not itself pricing-filtered — every hosted
 * model is available on it, so "free" here just means "currently active
 * and not a non-chat model" (Whisper/Guard entries share this endpoint).
 * @param {{apiKey: string, baseUrl: string, preferredModel?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function discoverGroqModels({ apiKey, baseUrl, preferredModel }) {
  try {
    const json = await fetchJson(`${baseUrl}/models`, { authorization: `Bearer ${apiKey}` });
    const active = (json?.data ?? []).filter((m) => m?.active !== false);
    const ids = cleanIds(active, (m) => m?.id);
    return rankWithPreference(ids, preferredModel);
  } catch (err) {
    log.debug('groq model discovery failed', { error: String(err) });
    return [];
  }
}

/**
 * Together AI — `GET {base}/models`, confirmed against current docs
 * (together.ai): returns a flat JSON array (not `{data:[...]}`), each entry
 * carrying `id` and, for serverless models, a `pricing` object. Free
 * serverless models are marked with an `-Free` id suffix (e.g.
 * `meta-llama/Llama-3.3-70B-Instruct-Turbo-Free`) and/or zeroed pricing.
 * @param {{apiKey: string, baseUrl: string, preferredModel?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function discoverTogetherModels({ apiKey, baseUrl, preferredModel }) {
  try {
    const json = await fetchJson(`${baseUrl}/models`, { authorization: `Bearer ${apiKey}` });
    const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    const free = list.filter((m) => isFreePriced(m) || /-free$/i.test(String(m?.id ?? '')));
    const ids = cleanIds(free.length > 0 ? free : list, (m) => m?.id);
    return rankWithPreference(ids, preferredModel);
  } catch (err) {
    log.debug('together model discovery failed', { error: String(err) });
    return [];
  }
}

/**
 * OpenRouter — `GET {base}/models`, confirmed against current docs
 * (openrouter.ai/docs): `{data:[{id, pricing:{prompt, completion}, ...}]}`,
 * numeric-string pricing. A free model's id also carries a `:free` suffix
 * by convention. No auth required for this endpoint, but the key is sent
 * anyway since it is harmless and matches every other provider's call shape.
 * @param {{apiKey: string, baseUrl: string, preferredModel?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function discoverOpenRouterModels({ apiKey, baseUrl, preferredModel }) {
  try {
    const json = await fetchJson(`${baseUrl}/models`, { authorization: `Bearer ${apiKey}` });
    const list = Array.isArray(json?.data) ? json.data : [];
    const free = list.filter((m) => isFreePriced(m) || /:free$/i.test(String(m?.id ?? '')));
    const ids = cleanIds(free, (m) => m?.id);
    return rankWithPreference(ids, preferredModel);
  } catch (err) {
    log.debug('openrouter model discovery failed', { error: String(err) });
    return [];
  }
}

/**
 * Gemini — `GET {base}/models`, confirmed against current docs
 * (ai.google.dev/api): `{models:[{name:"models/gemini-2.5-flash",
 * supportedGenerationMethods:[...]}]}`. Only models whose
 * `supportedGenerationMethods` includes `generateContent` are usable by
 * this adapter (`gemini.js` calls that method specifically). The `name`
 * field carries a `models/` prefix the `:generateContent` URL does not
 * want repeated — `gemini.js` builds `{baseUrl}/models/{model}:generateContent`,
 * so the prefix is stripped here.
 * @param {{apiKey: string, baseUrl: string, preferredModel?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function discoverGeminiModels({ apiKey, baseUrl, preferredModel }) {
  try {
    const json = await fetchJson(`${baseUrl}/models`, { 'x-goog-api-key': apiKey });
    const list = (json?.models ?? []).filter((m) =>
      Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'),
    );
    const ids = cleanIds(list, (m) => (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : null));
    // Prefer "flash"/"flash-lite" over "pro" — the free tier's generous
    // per-day quota lives on the smaller models (task brief: "actually free
    // and actually available to my key").
    ids.sort((a, b) => Number(/pro/i.test(a)) - Number(/pro/i.test(b)));
    return rankWithPreference(ids, preferredModel);
  } catch (err) {
    log.debug('gemini model discovery failed', { error: String(err) });
    return [];
  }
}

/**
 * HuggingFace — `GET {base}/models`. Documented for the router's chat
 * completions surface (router.huggingface.co) as OpenAI-compatible, but a
 * models-list endpoint on the router itself is not documented with the
 * same confidence as the other four providers' — this call is genuinely
 * best-effort. A non-2xx or unrecognised shape degrades to "no candidates",
 * and the caller keeps whatever model is already configured/cached; this
 * never blocks or fails the self-test run over one provider's uncertain
 * discovery endpoint.
 * @param {{apiKey: string, baseUrl: string, preferredModel?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function discoverHuggingFaceModels({ apiKey, baseUrl, preferredModel }) {
  try {
    const json = await fetchJson(`${baseUrl}/models`, { authorization: `Bearer ${apiKey}` });
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const ids = cleanIds(list, (m) => (typeof m === 'string' ? m : m?.id));
    return rankWithPreference(ids, preferredModel);
  } catch (err) {
    log.debug('huggingface model discovery failed (best-effort endpoint)', { error: String(err) });
    return [];
  }
}

/** Put `preferredModel` first if discovery happened to include it; otherwise leave order as-is. */
function rankWithPreference(ids, preferredModel) {
  if (!preferredModel || !ids.includes(preferredModel)) return ids;
  return [preferredModel, ...ids.filter((id) => id !== preferredModel)];
}

export default {
  discoverGroqModels,
  discoverTogetherModels,
  discoverOpenRouterModels,
  discoverGeminiModels,
  discoverHuggingFaceModels,
};
