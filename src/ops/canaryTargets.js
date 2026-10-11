/**
 * @file The list of canary targets: every provider of the catalog (RO2). One target for each id, so a new provider in
 * `config/providers.catalog.json` is covered with no change here. `test/ops-canary.test.js` checks that.
 */
import { isProviderConfigured } from '../config.js';
import { guardedFetch } from '../lib/net.js';
import { CANARY_MAX_TOKENS, CANARY_PROMPT } from './canary.js';
import { PROVIDERS } from '../providers/catalog.js';
import { makeProviderAdapter } from '../providers/selftest.js';

/**
 * @param {{ env?: Record<string, string|undefined>, only?: string[]|null, makeAdapter?: (id: string) => Promise<any>, fetchImpl?: typeof guardedFetch, opencode?: () => any, isConfigured?: (id: string) => boolean }} [opts]
 * @returns {Promise<import('./canary.js').CanaryTarget[]>}
 */
export async function buildTargets(opts = {}) {
  const env = opts.env ?? process.env;
  const makeAdapter = opts.makeAdapter ?? makeProviderAdapter;
  const fetchImpl = opts.fetchImpl ?? guardedFetch;
  const configured = opts.isConfigured ?? isProviderConfigured;
  const targets = [];
  for (const entry of PROVIDERS) {
    const id = entry.id;
    if (opts.only && !opts.only.includes(id)) continue;
    const model = (entry.secrets.model && env[entry.secrets.model]) || null;
    if (id === 'freebuff') {
      targets.push({ id, model: null, kind: 'none', skip: 'no_public_api' });
      continue;
    }
    if (!configured(id)) {
      targets.push({ id, model, kind: 'none', skip: 'no_key' });
      continue;
    }
    if (id.startsWith('hermes_')) {
      // A Hermes agent can act on its own host. It gets no prompt. The canary lists its models only.
      const n = id.split('_')[1];
      const base = (env[`HERMES_${n}_BASE_URL`] ?? '').replace(/\/+$/, '');
      const key = env[`HERMES_${n}_API_KEY`] ?? '';
      targets.push({
        id, model: model || 'hermes-agent', kind: 'list',
        call: async () => {
          const res = await fetchImpl(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 10_000, redirect: 'manual' });
          if (!res.ok) throw Object.assign(new Error(`the model list answered ${res.status}`), { status: res.status });
          const body = await res.json().catch(() => null);
          if (!body || typeof body !== 'object') throw Object.assign(new Error('the model list is not JSON'), { code: 'MALFORMED' });
          return { model: model || 'hermes-agent' };
        },
      });
      continue;
    }
    if (id === 'opencode') {
      const agent = opts.opencode ? opts.opencode() : new (await import('../agents/opencodeAgent.js')).OpenCodeAgent();
      targets.push({
        id, model, kind: 'chat',
        call: async () => agent.selfTestChat(CANARY_PROMPT, { maxTokens: CANARY_MAX_TOKENS }),
      });
      continue;
    }
    const adapter = await makeAdapter(id);
    targets.push({
      id, model: adapter.model || model, kind: 'chat',
      call: async () => adapter.chat([{ role: 'user', content: CANARY_PROMPT }], { maxTokens: CANARY_MAX_TOKENS, temperature: 0 }),
    });
  }
  return targets;
}

export default buildTargets;
