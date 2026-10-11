// R2: OpenRouter rotates past a model that answers 429, keeps it cool for 10 minutes, tries 3 models at most in one call,
// and Gemini goes first when OpenRouter fails for more than half of its recent calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MODEL_TRIES, MODEL_COOLDOWN_MS, OpenRouterProvider, resetModelCooldowns } from '../src/providers/openrouter.js';
import { Registry, ALL_CHAT_IDS } from '../src/providers/registry.js';
import { ProviderHealthStore } from '../src/providers/health.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (model) => json({ model, choices: [{ message: { content: `from ${model}` } }], usage: { total_tokens: 3 } });
const NO_HEALTH = { markNotConfigured() {}, recordOutcome() {} };

function make({ answers, models, clock }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    const answer = answers[model];
    if (typeof answer === 'number') return json({ error: { message: 'Provider returned error' } }, answer, answer === 429 ? { 'retry-after': '30' } : {});
    return ok(model);
  };
  const provider = new OpenRouterProvider({ apiKey: 'k-test', model: models[0], models, fetchImpl, nowMs: () => clock.t, health: NO_HEALTH });
  return { provider, calls };
}
const say = [{ role: 'user', content: 'hi' }];

test('a 429 on a model rotates to the next free model, and the model that worked is used next', async () => {
  resetModelCooldowns();
  const clock = { t: 1_000_000 };
  const { provider, calls } = make({ answers: { 'a:free': 429, 'b:free': 429, 'c:free': 'ok' }, models: ['a:free', 'b:free', 'c:free', 'd:free'], clock });
  const out = await provider.chat(say, { maxTokens: 5 });
  assert.equal(out.text, 'from c:free');
  assert.deepEqual(calls, ['a:free', 'b:free', 'c:free']);
  assert.equal(provider.model, 'c:free');
});

test('a cooled model stays out for 10 minutes and returns after that', async () => {
  resetModelCooldowns();
  const clock = { t: 1_000_000 };
  const { provider, calls } = make({ answers: { 'a:free': 429 }, models: ['a:free', 'b:free', 'c:free'], clock });
  await provider.chat(say);
  assert.deepEqual(calls, ['a:free', 'b:free']);
  calls.length = 0;
  provider.model = 'a:free';
  await provider.chat(say);
  assert.deepEqual(calls, ['b:free'], 'a:free is cooling, so the call goes straight to b:free');
  clock.t += MODEL_COOLDOWN_MS - 1000;
  calls.length = 0;
  provider.model = 'a:free';
  await provider.chat(say);
  assert.deepEqual(calls, ['b:free']);
  clock.t += 2000;
  calls.length = 0;
  provider.model = 'a:free';
  await provider.chat(say);
  assert.equal(calls[0], 'a:free', 'after 10 minutes the model is tried again');
});

test('one call tries 3 models at most, then the 429 goes up to the failover logic', async () => {
  resetModelCooldowns();
  const clock = { t: 5_000_000 };
  const { provider, calls } = make({ answers: { 'a:free': 429, 'b:free': 429, 'c:free': 429, 'd:free': 'ok' }, models: ['a:free', 'b:free', 'c:free', 'd:free'], clock });
  await assert.rejects(() => provider.chat(say), (e) => e.status === 429 || /429/.test(e.message));
  assert.equal(calls.length, MAX_MODEL_TRIES);
  assert.ok(!calls.includes('d:free'));
});

test('another error stops the loop at once, and a retired model (404) rotates', async () => {
  resetModelCooldowns();
  const clock = { t: 9_000_000 };
  const bad = make({ answers: { 'a:free': 401 }, models: ['a:free', 'b:free'], clock });
  await assert.rejects(() => bad.provider.chat(say), /rejected the request \(401\)/);
  assert.deepEqual(bad.calls, ['a:free'], 'a bad key does not try other models');
  resetModelCooldowns();
  const gone = make({ answers: { 'a:free': 404 }, models: ['a:free', 'b:free'], clock });
  const out = await gone.provider.chat(say);
  assert.equal(out.text, 'from b:free');
});

test('when OpenRouter fails for more than half of its recent calls, Gemini goes first', async () => {
  const health = new ProviderHealthStore({ path: null });
  for (const id of ALL_CHAT_IDS) health.markConfigured(id);
  const stub = (id) => ({ id, isConfigured: () => true, chat: async () => ({ text: id, service: id, model: 'm', latencyMs: 1, tokensUsed: null, attempts: 1 }) });
  const providers = new Map(ALL_CHAT_IDS.map((id) => [id, stub(id)]));
  const reg = new Registry({ providers, healthStore: health, omniroute: { isConfigured: () => false } });
  // healthy OpenRouter: the normal order wins (Groq and Together come first anyway, so take them out of the way)
  for (const id of ['groq', 'together']) health.recordOutcome(id, { ok: false, status: 401, message: 'bad key' });
  assert.equal((await reg.chat(say, { service: 'auto' })).service, 'openrouter');
  for (let i = 0; i < 6; i += 1) health.recordOutcome('openrouter', { ok: false, status: 500, message: 'oops' });
  health.recordOutcome('openrouter', { ok: true, latencyMs: 1, model: 'm' });
  assert.ok(health.get('openrouter').errorRate > 0.5);
  health.recordOutcome('openrouter', { ok: false, status: 500, message: 'oops' });
  health.get('openrouter').cooldownUntil = null;
  const chosen = await reg.chat(say, { service: 'auto', maxProviders: 8 });
  assert.equal(chosen.service, 'gemini');
});

test('a model that returns no text rotates too, because a reasoning model can spend a small budget on thinking', async () => {
  resetModelCooldowns();
  const clock = { t: 20_000_000 };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    if (model === 'think:free') return json({ model, choices: [{ message: { content: null, reasoning: 'hmm' } }] });
    return ok(model);
  };
  const provider = new OpenRouterProvider({ apiKey: 'k-test', model: 'think:free', models: ['think:free', 'plain:free'], fetchImpl, nowMs: () => clock.t, health: NO_HEALTH });
  const out = await provider.chat(say, { maxTokens: 5 });
  assert.equal(out.text, 'from plain:free');
  assert.deepEqual(calls, ['think:free', 'plain:free']);
});
