#!/usr/bin/env node
/**
 * @file Provider self-test (task instructions, section 6): refreshes each
 * provider's live model catalog, then sends one tiny (5-token) completion
 * to every configured provider and records success/latency/model/the exact
 * (scrubbed) error text to `state/providers.json`. Run by
 * `.github/workflows/provider-selftest.yml`, manual + weekly.
 *
 * This is the one place in the repo that deliberately makes real network
 * calls against real upstream APIs — everything else (`npm test`, the
 * pulse's own dry-run) is built to need zero credentials and zero network
 * access. Consistent with that split, this script refuses to run under
 * `TITAN_DRY_RUN` rather than silently doing nothing, since running it in
 * that mode would just be a confusing no-op.
 *
 * Never throws past its own top-level: one provider's failure is a result
 * to record, not a reason to stop testing the other six. Exit code stays 0
 * even when every provider fails — this is a health report, not a gate;
 * failures are meant to be *visible* (`state/providers.json`, the dashboard's
 * provider strip), not to fail CI or block anything else.
 */
import { config, isProviderConfigured } from '../src/config.js';
import { providerHealth } from '../src/providers/health.js';
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

if (config.dryRun) {
  console.log(
    'TITAN_DRY_RUN is set — provider-selftest.mjs exists specifically to make real ' +
      'network calls against real provider APIs, so it refuses to run under dry-run ' +
      'rather than silently doing nothing. Unset TITAN_DRY_RUN to test live providers.',
  );
  process.exit(0);
}

/** A real round trip with a real (tiny) answer — not a full task prompt. */
const PROBE_PROMPT = 'Reply with exactly one word: OK';
const PROBE_MAX_TOKENS = 5;

/** @type {Array<{id: string, baseUrl: string, discover: Function, ProviderClass: Function}>} */
const REGISTRY_PROVIDERS = [
  { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', discover: discoverGroqModels, ProviderClass: GroqProvider },
  { id: 'together', baseUrl: 'https://api.together.xyz/v1', discover: discoverTogetherModels, ProviderClass: TogetherProvider },
  { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', discover: discoverOpenRouterModels, ProviderClass: OpenRouterProvider },
  { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', discover: discoverGeminiModels, ProviderClass: GeminiProvider },
  { id: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', discover: discoverHuggingFaceModels, ProviderClass: HuggingFaceProvider },
];

const results = [];

for (const p of REGISTRY_PROVIDERS) {
  if (!isProviderConfigured(p.id)) {
    providerHealth.markNotConfigured(p.id);
    results.push({ id: p.id, status: 'not_configured' });
    continue;
  }

  let discovered = [];
  try {
    discovered = await p.discover({
      apiKey: config[p.id].apiKey,
      baseUrl: p.baseUrl,
      preferredModel: config[p.id].model || null,
    });
  } catch (err) {
    console.error(`[${p.id}] model discovery threw unexpectedly (treated as zero candidates): ${redactString(String(err))}`);
  }
  if (discovered.length > 0) {
    providerHealth.setDiscoveredModels(p.id, discovered, discovered[0]);
  }

  // A fresh instance so its model resolves from the cache just written above.
  const instance = new p.ProviderClass();
  try {
    const res = await instance.chat([{ role: 'user', content: PROBE_PROMPT }], {
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
    });
    // instance.chat() already recorded this outcome via providers/health.js.
    results.push({ id: p.id, status: 'ok', model: res.model, latencyMs: res.latencyMs, discoveredModelCount: discovered.length });
  } catch (err) {
    results.push({
      id: p.id,
      status: 'failed',
      error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 300),
      discoveredModelCount: discovered.length,
    });
  }
}

if (!isProviderConfigured('opencode')) {
  providerHealth.markNotConfigured('opencode');
  results.push({ id: 'opencode', status: 'not_configured' });
} else {
  const agent = new OpenCodeAgent();
  const started = performance.now();
  try {
    const res = await agent.selfTestChat(PROBE_PROMPT, { maxTokens: PROBE_MAX_TOKENS });
    const latencyMs = Math.round(performance.now() - started);
    providerHealth.recordOutcome('opencode', { ok: true, latencyMs, model: res.model });
    results.push({ id: 'opencode', status: 'ok', model: res.model, latencyMs });
  } catch (err) {
    providerHealth.recordOutcome('opencode', {
      ok: false,
      code: err?.code,
      status: err?.status ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
    results.push({ id: 'opencode', status: 'failed', error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
}

// Freebuff has no legitimate public API — see agents/freebuffAgent.js. Never
// attempted; recorded so the dashboard's provider strip shows the honest
// reason rather than silence.
providerHealth.markNoPublicApi('freebuff', 'Freebuff has no official public API for third-party integration — see src/agents/freebuffAgent.js.');
results.push({ id: 'freebuff', status: 'no_public_api' });

providerHealth.save();

const summary = { selfTest: 'complete', at: new Date().toISOString(), results };
console.log(JSON.stringify(summary, null, 2));

const failed = results.filter((r) => r.status === 'failed');
console.log(
  `\n${results.length} provider(s) checked — ` +
    `${results.filter((r) => r.status === 'ok').length} ok, ` +
    `${failed.length} failed, ` +
    `${results.filter((r) => r.status === 'not_configured').length} not configured, ` +
    `${results.filter((r) => r.status === 'no_public_api').length} no public API.`,
);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.id}: ${f.error}`);
}
