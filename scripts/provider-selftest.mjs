#!/usr/bin/env node
/**
 * @file Provider self-test. It has three modes (Wave 12, K5 and R3):
 *
 *   full    (weekly and by hand): refresh each model catalog, then send one tiny completion to every configured
 *           provider, and record the result in `state/providers.json`.
 *   light   (daily): refresh each model catalog only. It sends no completion, so it costs no tokens.
 *   single  (a `provider-selftest` dispatch with a provider id): prove one provider in this runner. It writes nothing
 *           to `state/`. It posts the result to the Worker route `/internal/provider-proof` with the callback token.
 *
 * Run by `.github/workflows/provider-selftest.yml`. The provider list comes from `config/providers.catalog.json`.
 *
 * This is the one place in the repo that deliberately makes real calls against real provider APIs. It never throws past
 * its own top level, and the exit code stays 0 even when a provider fails: this is a health report, not a gate.
 */
import { config, isProviderConfigured } from '../src/config.js';
import { providerHealth } from '../src/providers/health.js';
import { DIRECT_PROVIDER_IDS, CUSTOM_PROVIDER_IDS, getCatalogProvider } from '../src/providers/catalog.js';
import { GroqProvider } from '../src/providers/groq.js';
import { TogetherProvider } from '../src/providers/together.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { HuggingFaceProvider } from '../src/providers/huggingface.js';
import { OpenCodeAgent } from '../src/agents/opencodeAgent.js';
import {
  discoverGroqModels,
  discoverTogetherModels,
  discoverOpenRouterModels,
  discoverGeminiModels,
  discoverHuggingFaceModels,
} from '../src/providers/modelDiscovery.js';
import { redactString } from '../src/lib/redact.js';
import { proveProvider } from '../src/providers/selftest.js';
import { callWorker } from '../src/lib/workerCallback.js';

if (config.dryRun) {
  console.log(
    'TITAN_DRY_RUN is set. provider-selftest.mjs makes real network calls against real provider APIs, so it refuses to run under dry-run.',
  );
  process.exit(0);
}

const PROBE_PROMPT = 'Reply with exactly one word: OK';
const PROBE_MAX_TOKENS = 5;

/** The adapter class and the model discovery function of each direct provider. The ids and base URLs come from the catalog. */
const DIRECT = {
  groq: { ProviderClass: GroqProvider, discover: discoverGroqModels },
  together: { ProviderClass: TogetherProvider, discover: discoverTogetherModels },
  openrouter: { ProviderClass: OpenRouterProvider, discover: discoverOpenRouterModels },
  gemini: { ProviderClass: GeminiProvider, discover: discoverGeminiModels },
  huggingface: { ProviderClass: HuggingFaceProvider, discover: discoverHuggingFaceModels },
};

const mode = (process.env.TITAN_SELFTEST_PROVIDER ?? '').trim() ? 'single' : (process.env.TITAN_SELFTEST_MODE ?? 'full').trim() === 'light' ? 'light' : 'full';

async function discoverFor(id) {
  const entry = getCatalogProvider(id);
  const spec = DIRECT[id];
  if (!spec) return [];
  try {
    return await spec.discover({ apiKey: config[id].apiKey, baseUrl: entry.chat.baseUrl, preferredModel: config[id].model || null });
  } catch (err) {
    console.error(`[${id}] model discovery threw (treated as zero candidates): ${redactString(String(err))}`);
    return [];
  }
}

async function runSingle() {
  const id = process.env.TITAN_SELFTEST_PROVIDER.trim().toLowerCase();
  const requestId = (process.env.TITAN_SELFTEST_REQUEST_ID ?? '').trim();
  if (!getCatalogProvider(id)) {
    console.log(`provider-selftest: "${id.slice(0, 40)}" is not in the catalog. Nothing to do.`);
    return;
  }
  const discover = Object.fromEntries(Object.entries(DIRECT).map(([k, v]) => [k, ({ apiKey, baseUrl, preferredModel }) => v.discover({ apiKey, baseUrl, preferredModel })]));
  const result = await proveProvider(id, { discover });
  if (result.skipped) {
    console.log(`provider-selftest: ${id} is skipped. ${result.detail}`);
    return;
  }
  console.log(`provider-selftest: ${id} ${result.ok ? 'OK' : 'FAILED'}${result.model ? ` model ${result.model}` : ''}${result.latencyMs != null ? ` in ${result.latencyMs} ms` : ''}. ${result.detail}`);
  const safeRequestId = /^[A-Za-z0-9_-]{1,64}$/.test(requestId) ? requestId : undefined;
  const post = await callWorker('/internal/provider-proof', {
    body: { provider: id, requestId: safeRequestId, ok: result.ok, model: result.model, latencyMs: result.latencyMs, detail: result.detail },
  });
  console.log(post.ok ? `provider-selftest: the Worker took the proof (${post.kind} token).` : `provider-selftest: the Worker did not take the proof (${post.status ?? post.error}).`);
}

async function runBatch(light) {
  const results = [];
  for (const id of DIRECT_PROVIDER_IDS) {
    if (!isProviderConfigured(id)) {
      providerHealth.markNotConfigured(id);
      results.push({ id, status: 'not_configured' });
      continue;
    }
    const discovered = await discoverFor(id);
    if (discovered.length > 0) providerHealth.setDiscoveredModels(id, discovered, discovered[0]);
    if (light) {
      results.push({ id, status: 'listed', discoveredModelCount: discovered.length });
      continue;
    }
    const instance = new DIRECT[id].ProviderClass();
    try {
      const res = await instance.chat([{ role: 'user', content: PROBE_PROMPT }], { maxTokens: PROBE_MAX_TOKENS, temperature: 0 });
      results.push({ id, status: 'ok', model: res.model, latencyMs: res.latencyMs, discoveredModelCount: discovered.length });
    } catch (err) {
      results.push({ id, status: 'failed', error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 300), discoveredModelCount: discovered.length });
    }
  }

  if (!light) {
    for (const id of CUSTOM_PROVIDER_IDS) {
      if (!isProviderConfigured(id)) continue;
      const res = await proveProvider(id, {});
      results.push({ id, status: res.ok ? 'ok' : 'failed', model: res.model, latencyMs: res.latencyMs, error: res.ok ? undefined : res.detail });
    }
  }

  if (!isProviderConfigured('opencode')) {
    providerHealth.markNotConfigured('opencode');
    results.push({ id: 'opencode', status: 'not_configured' });
  } else if (!light) {
    const agent = new OpenCodeAgent();
    const started = performance.now();
    try {
      const res = await agent.selfTestChat(PROBE_PROMPT, { maxTokens: PROBE_MAX_TOKENS });
      const latencyMs = Math.round(performance.now() - started);
      providerHealth.recordOutcome('opencode', { ok: true, latencyMs, model: res.model });
      results.push({ id: 'opencode', status: 'ok', model: res.model, latencyMs });
    } catch (err) {
      providerHealth.recordOutcome('opencode', { ok: false, code: err?.code, status: err?.status ?? null, message: err instanceof Error ? err.message : String(err) });
      results.push({ id: 'opencode', status: 'failed', error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }

  // Freebuff has no legitimate public API. It is never called. The dashboard shows the honest reason.
  providerHealth.markNoPublicApi('freebuff', 'Freebuff has no official public API for third-party integration. See src/agents/freebuffAgent.js.');
  results.push({ id: 'freebuff', status: 'no_public_api' });

  providerHealth.save();
  console.log(JSON.stringify({ selfTest: 'complete', mode: light ? 'light' : 'full', at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => r.status === 'failed');
  console.log(`\n${results.length} provider(s) checked. ${results.filter((r) => r.status === 'ok').length} ok, ${failed.length} failed, ${results.filter((r) => r.status === 'not_configured').length} not configured.`);
  for (const f of failed) console.log(`  - ${f.id}: ${f.error}`);
}

try {
  if (mode === 'single') await runSingle();
  else await runBatch(mode === 'light');
} catch (err) {
  console.error('provider-selftest: unexpected error:', redactString(err instanceof Error ? err.message : String(err)));
}
