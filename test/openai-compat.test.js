import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatProvider, checkBaseUrl } from '../src/providers/openaiCompat.js';
import { Registry, ALL_CHAT_IDS, FAILOVER_ORDER, CUSTOM_ORDER } from '../src/providers/registry.js';
import { ProviderHealthStore } from '../src/providers/health.js';

const publicLookup = async () => [{ address: '93.184.216.34' }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const good = (calls) => async (url, init) => {
  calls.push({ url: String(url), auth: init.headers.authorization, redirect: init.redirect, body: JSON.parse(init.body) });
  return json({ model: 'm1', choices: [{ message: { content: 'hello' } }], usage: { total_tokens: 5 } });
};
const make = (over = {}) => new OpenAICompatProvider({ id: 'custom_1', label: 'My LLM', baseUrl: 'https://llm.example.com/v1', apiKey: 'k-test', model: 'm1', lookup: publicLookup, health: { markNotConfigured() {}, recordOutcome() {} }, ...over });

test('a base URL must use https and a public host, with no user name or password', () => {
  assert.equal(checkBaseUrl('https://llm.example.com/v1').ok, true);
  for (const bad of ['http://llm.example.com/v1', 'https://user:pw@llm.example.com/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1', 'https://[::1]/v1', 'https://intranet/v1', 'https://x.internal/v1', 'not a url']) {
    assert.equal(checkBaseUrl(bad).ok, false, bad);
  }
});

test('the adapter calls only its own host, sends the key as a Bearer header, and does not follow redirects', async () => {
  const calls = [];
  const p = make({ fetchImpl: good(calls) });
  const out = await p.chat([{ role: 'user', content: 'hi' }], { maxTokens: 5 });
  assert.equal(out.text, 'hello');
  assert.equal(out.service, 'custom_1');
  assert.equal(calls[0].url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer k-test');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].body.model, 'm1');
});

test('a redirect, a private address, or an unsafe base URL is refused before the key leaves', async () => {
  let called = 0;
  const redirecting = make({ fetchImpl: async () => { called += 1; return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }); } });
  await assert.rejects(() => redirecting.chat([{ role: 'user', content: 'x' }]), /redirect/);
  called = 0;
  const privateDns = make({ lookup: async () => [{ address: '10.0.0.7' }], fetchImpl: async () => { called += 1; return json({}); } });
  await assert.rejects(() => privateDns.chat([{ role: 'user', content: 'x' }]), /egress refused/);
  assert.equal(called, 0, 'no request went out');
  const unsafe = make({ baseUrl: 'http://llm.example.com/v1', fetchImpl: async () => { called += 1; return json({}); } });
  assert.equal(unsafe.isConfigured(), false);
  await assert.rejects(() => unsafe.chat([{ role: 'user', content: 'x' }]), /not configured/);
});

test('the registry puts custom providers after the direct providers and uses them as the last resort', async () => {
  assert.deepEqual(ALL_CHAT_IDS, [...FAILOVER_ORDER, ...CUSTOM_ORDER]);
  const health = new ProviderHealthStore({ path: null });
  const stub = (id, fail) => ({ id, isConfigured: () => true, chat: async () => { if (fail) throw Object.assign(new Error(`${id} down`), { status: 500, code: 'UPSTREAM_ERROR' }); return { text: id, service: id, model: 'm', latencyMs: 1, tokensUsed: null, attempts: 1 }; } });
  const providers = new Map(ALL_CHAT_IDS.map((id) => [id, stub(id, FAILOVER_ORDER.includes(id))]));
  for (const id of ALL_CHAT_IDS) health.markConfigured(id);
  const reg = new Registry({ providers, healthStore: health, omniroute: { isConfigured: () => false } });
  const result = await reg.chat([{ role: 'user', content: 'x' }], { service: 'auto', maxProviders: 8 });
  assert.equal(result.service, 'custom_1');
  assert.deepEqual(reg.configuredIds(), [...ALL_CHAT_IDS]);
});
