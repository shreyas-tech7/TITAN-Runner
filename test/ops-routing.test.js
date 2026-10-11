/**
 * RO1 and RO2, runner side: the quota config, the quota maths, the routing rules of contract v1, and the usage reporter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/providers/registry.js';
import { ProviderHealthStore } from '../src/providers/health.js';
import { OpsGate, BREAKER } from '../src/ops/gate.js';
import { UsageReporter } from '../src/ops/usageReporter.js';
import { QUOTAS, blockedUntilAfter429, computeQuota, dayWindow, providerKey, resolveLimit } from '../src/ops/quota.js';
import { rateLimitFrom } from '../src/providers/base.js';
import { PROVIDERS } from '../src/providers/catalog.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

// ---------------------------------------------------------------------
// config/quotas.json
// ---------------------------------------------------------------------

test('RO1 config: every entry has a source and a date, and an unknown limit is null, never a guess', () => {
  const rules = Object.keys(QUOTAS.resetRules);
  for (const [name, p] of Object.entries(QUOTAS.providers)) {
    assert.ok(rules.includes(p.reset), `${name}: the reset rule exists`);
    assert.ok(p.resetSource === null || /^https:\/\//.test(p.resetSource), `${name}: resetSource`);
    assert.ok(p.resetNote, `${name}: a note about the reset`);
    assert.ok(p.models['*'], `${name}: has the default entry`);
    for (const [model, e] of Object.entries(p.models)) {
      const where = `${name}/${model}`;
      assert.ok(['official', 'observed', 'unknown'].includes(e.limit_confidence), where);
      assert.match(e.checkedOn, /^\d{4}-\d{2}-\d{2}$/, `${where}: a date`);
      assert.ok(e.limit_source === null || /^https:\/\//.test(e.limit_source), `${where}: a source URL or null`);
      assert.ok(['model', 'provider'].includes(e.scope), where);
      assert.ok(e.note && e.note.length > 20, `${where}: a note that says what the page says`);
      if (e.limit_confidence === 'unknown') assert.deepEqual([e.limit_day, e.limit_month], [null, null], `${where}: an unknown limit is null`);
      if (e.limit_confidence === 'official') {
        assert.ok(e.limit_source, `${where}: an official limit names its page`);
        assert.ok(Number.isInteger(e.limit_day) || Number.isInteger(e.limit_month), `${where}: an official limit has a number`);
      }
    }
  }
});

test('RO1 config: every provider of the catalog has a quota entry, and the confirmed numbers are the ones in the docs', () => {
  for (const p of PROVIDERS) if (p.id !== 'freebuff') assert.ok(resolveLimit(p.id, 'any-model'), `${p.id} has a quota entry`);
  assert.equal(providerKey('hermes_2'), 'hermes');
  assert.equal(providerKey('custom_3'), 'custom');
  const free = resolveLimit('openrouter', 'meta/llama:free');
  assert.deepEqual([free.matched, free.entry.limit_day, free.entry.limit_confidence, free.entry.scope], ['*:free', 50, 'official', 'provider']);
  assert.equal(resolveLimit('openrouter', 'openai/gpt-4o').entry.limit_day, null, 'a paid model has no free limit');
  assert.equal(QUOTAS.providers.gemini.reset, 'pacific-midnight');
  assert.equal(QUOTAS.providers.groq.reset, 'utc-midnight');
  for (const id of ['groq', 'gemini', 'together', 'huggingface', 'opencode']) assert.equal(resolveLimit(id, 'x').entry.limit_confidence, 'unknown', `${id}: the docs state no free number`);
});

// ---------------------------------------------------------------------
// The quota maths
// ---------------------------------------------------------------------

test('RO1 maths: the 95% rule, the 429 hold, and a monthly limit', () => {
  const quotas = { providers: { p: { reset: 'utc-midnight', remainingSemantics: {}, models: { '*': { scope: 'model', limit_day: 100, limit_month: 1000, limit_source: 'https://x.example', limit_confidence: 'official' } } } } };
  const q = (day, month, blockedUntil = null) => computeQuota({ provider: 'p', model: 'm', usage: { day, month, blockedUntil }, now: NOW, quotas });
  assert.equal(q(94, 94).exhausted, false);
  assert.equal(q(95, 95).exhausted, true, '95 of 100 is 95%');
  assert.equal(q(10, 960).exhausted, true, 'the month limit counts too');
  assert.equal(q(10, 960).remaining_pct, 4);
  assert.equal(q(0, 0, '2026-10-12T00:00:00.000Z').exhausted, true, 'a 429 holds until the reset');
  assert.equal(q(0, 0, '2026-10-11T11:00:00.000Z').exhausted, false, 'a hold in the past is over');
  assert.equal(q(0, 0).resets_at, '2026-10-12T00:00:00.000Z');
});

test('RO1 maths: a limit that is not known never turns exhausted from use, and the Groq day header gives an observed limit only for today', () => {
  const unknown = computeQuota({ provider: 'together', model: 'm', usage: { day: 99999, month: 99999 }, now: NOW });
  assert.deepEqual([unknown.limit_day, unknown.exhausted, unknown.remaining_pct, unknown.limit_confidence], [null, false, null, 'unknown']);
  const obs = (observedAt) => computeQuota({ provider: 'groq', model: 'm', usage: { day: 120, month: 300, observed: { remainingRequests: 880, observedAt, usedDayAtObservation: 100 } }, now: NOW });
  assert.deepEqual([obs(at(10)).limit_day, obs(at(10)).limit_confidence], [980, 'observed']);
  assert.deepEqual([obs('2026-10-10T12:00:00.000Z').limit_day, obs('2026-10-10T12:00:00.000Z').limit_confidence], [null, 'unknown'], 'yesterday is not today');
  const together = computeQuota({ provider: 'together', model: 'm', usage: { day: 1, month: 1, observed: { remainingRequests: 5, observedAt: at(1), usedDayAtObservation: 0 } }, now: NOW });
  assert.equal(together.limit_day, null, 'a header that does not count a day shows no limit');
});

test('RO1 maths: day windows, Pacific time with daylight saving, and the reset after a 429', () => {
  assert.equal(dayWindow('utc-midnight', NOW).next.toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(dayWindow('pacific-midnight', NOW).next.toISOString(), '2026-10-12T07:00:00.000Z', 'summer time: PDT');
  assert.equal(dayWindow('pacific-midnight', new Date('2026-12-05T10:00:00Z')).next.toISOString(), '2026-12-06T08:00:00.000Z', 'winter time: PST');
  assert.equal(dayWindow('pacific-midnight', new Date('2026-03-08T12:00:00Z')).start.toISOString(), '2026-03-08T08:00:00.000Z', 'the spring change day starts in PST');
  assert.equal(blockedUntilAfter429('gemini', NOW), '2026-10-12T07:00:00.000Z');
  assert.equal(blockedUntilAfter429('groq', NOW), '2026-10-12T00:00:00.000Z');
  assert.equal(blockedUntilAfter429('unknown_provider', NOW), '2026-10-12T00:00:00.000Z', 'UTC midnight when nothing says otherwise');
});

// ---------------------------------------------------------------------
// The routing rules
// ---------------------------------------------------------------------

const mirror = (providers) => ({ providers });
const health = (status, minutesAgo = 5, model = 'm') => ({ [model]: { status, latency_ms: 10, checked_at: at(minutesAgo), error_class: null } });
const exhausted = (resetsInMin = 300) => ({ '*': { exhausted: true, resets_at: new Date(NOW.getTime() + resetsInMin * 60_000).toISOString() } });

test('RO2 gate: skips down, not_configured, and exhausted providers, and keeps healthy and degraded ones', () => {
  const gate = new OpsGate({ now: () => NOW, health: mirror({ groq: health('healthy'), together: health('down'), gemini: health('not_configured'), openrouter: health('degraded') }), quota: mirror({ huggingface: exhausted() }) });
  assert.equal(gate.skipReason('groq'), null);
  assert.equal(gate.skipReason('openrouter'), null, 'degraded is ranked last, not skipped');
  assert.deepEqual(gate.skipReason('together'), { reason: 'the canary reports the provider down', class: 'provider_down' });
  assert.equal(gate.skipReason('gemini').class, 'permanent');
  assert.equal(gate.skipReason('huggingface').class, 'budget_exhausted');
  assert.match(gate.skipReason('huggingface').reason, /exhausted until 2026-10-11T17:00/);
  assert.equal(gate.skipReason('opencode'), null, 'no information is not a reason to skip');
});

test('RO2 gate: degraded providers rank last and the other order stays', () => {
  const gate = new OpsGate({ now: () => NOW, health: mirror({ groq: health('degraded'), gemini: health('healthy') }) });
  assert.deepEqual(gate.rank(['groq', 'together', 'openrouter', 'gemini']), ['together', 'openrouter', 'gemini', 'groq']);
});

test('RO2 gate: old canary answers and old exhausted flags are ignored', () => {
  const gate = new OpsGate({ now: () => NOW, health: mirror({ groq: health('down', 60 * 40) }), quota: mirror({ together: exhausted(-1) }) });
  assert.equal(gate.skipReason('groq'), null, 'a 40 hour old answer says nothing about now');
  assert.equal(gate.skipReason('together'), null, 'the reset passed, so the flag is old');
});

test('RO2 gate: a named provider still gets one try at a down verdict, but never at an exhausted one', () => {
  const gate = new OpsGate({ now: () => NOW, health: mirror({ groq: health('down') }), quota: mirror({ gemini: exhausted() }) });
  assert.equal(gate.skipReason('groq', { explicit: true }), null);
  assert.equal(gate.skipReason('gemini', { explicit: true }).class, 'budget_exhausted');
});

test('RO2 gate: the circuit breaker opens after 3 failures in a row, holds 15 minutes, then lets one probe through', () => {
  const rec = (n, minutesAgo) => ({ consecutiveFailures: n, lastCheckedAt: at(minutesAgo) });
  const open = (r) => new OpsGate({ now: () => NOW, failureRecord: () => r }).skipReason('groq');
  assert.equal(open(rec(2, 1)), null, 'two failures do not trip it');
  assert.match(open(rec(3, 1)).reason, /circuit breaker open until/);
  assert.match(open(rec(3, 14)).reason, /circuit breaker/, 'still open at 14 minutes');
  assert.equal(open(rec(3, 16)), null, 'after 15 minutes one call goes through as a probe');
  assert.match(open(rec(4, 1)).reason, /circuit breaker/, 'a failed probe opens it again');
  assert.equal(open(null), null);
  assert.equal(BREAKER.failures, 3);
  assert.equal(BREAKER.probeAfterMs, 15 * 60_000);
});

test('RO2 gate: the model that the adapter uses picks the entry', () => {
  const gate = new OpsGate({ now: () => NOW, modelOf: () => 'big', health: mirror({ groq: { ...health('down', 5, 'small'), ...health('healthy', 5, 'big') } }) });
  assert.equal(gate.status('groq'), 'healthy');
  const other = new OpsGate({ now: () => NOW, modelOf: () => 'small', health: mirror({ groq: { ...health('down', 5, 'small'), ...health('healthy', 5, 'big') } }) });
  assert.equal(other.status('groq'), 'down');
});

test('RO2 gate: it reads the public mirrors of a state folder, and survives a missing or broken file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-ops-'));
  try {
    assert.equal(OpsGate.fromState(dir).skipReason('groq'), null, 'no mirrors, no opinion');
    mkdirSync(join(dir, 'ops'));
    writeFileSync(join(dir, 'ops', 'health.json'), '{ not json');
    writeFileSync(join(dir, 'ops', 'quota.json'), JSON.stringify({ providers: { groq: exhausted() } }));
    const gate = OpsGate.fromState(dir, { now: () => NOW });
    assert.equal(gate.skipReason('groq').class, 'budget_exhausted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fake(id, text = 'ok') {
  return { id, model: `${id}-model`, isConfigured: () => true, chat: async () => ({ text, service: id, model: `${id}-model`, latencyMs: 1, tokensUsed: 3, tokensIn: 2, tokensOut: 1, rate: { remainingRequests: 77, remainingTokens: null } }) };
}

function registryWith(gate, usage, providers) {
  const dir = mkdtempSync(join(tmpdir(), 'titan-ops-reg-'));
  const health = new ProviderHealthStore(join(dir, 'providers.json'));
  for (const id of providers.keys()) health.markConfigured(id);
  const registry = new Registry({ providers, healthStore: health });
  registry.useOps(gate);
  registry.useUsage(usage);
  return { registry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('RO2 routing: the registry skips a down provider, ranks degraded last, and says why in the error when nothing is left', async () => {
  const providers = new Map(['groq', 'together', 'openrouter', 'gemini', 'huggingface'].map((id) => [id, fake(id)]));
  const gate = new OpsGate({ now: () => NOW, health: mirror({ groq: health('down'), together: health('degraded') }), quota: mirror({ openrouter: exhausted() }) });
  const reporter = new UsageReporter({ workerUrl: '', token: '' });
  const { registry, cleanup } = registryWith(gate, reporter, providers);
  try {
    const result = await registry.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.service, 'gemini', 'groq is down, together is degraded so it goes last, openrouter is exhausted');
    const all = new OpsGate({ now: () => NOW, health: mirror(Object.fromEntries(['groq', 'together', 'gemini', 'huggingface'].map((id) => [id, health('down')]))), quota: mirror({ openrouter: exhausted() }) });
    registry.useOps(all);
    await assert.rejects(() => registry.chat([{ role: 'user', content: 'hi' }]), (err) => {
      assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
      assert.match(err.message, /skipped: .*groq — ops: the canary reports the provider down/);
      assert.match(err.message, /openrouter — ops: free quota exhausted/);
      assert.ok(err.skipped.every((s) => s.class), 'each skip has a class, so the scheduler can park the task');
      return true;
    });
  } finally {
    cleanup();
  }
});

test('RO1 reporting: the registry reports each call, with the token split and the Groq header', async () => {
  const providers = new Map([['groq', fake('groq')], ['together', { ...fake('together'), chat: async () => { throw Object.assign(new Error('rate limited'), { status: 429, code: 'RATE_LIMITED', retryable: true }); } }]]);
  const reporter = new UsageReporter({ workerUrl: 'https://worker.example', token: 'x'.repeat(40), now: () => NOW });
  const { registry, cleanup } = registryWith(new OpsGate({ now: () => NOW }), reporter, providers);
  try {
    await registry.chat([{ role: 'user', content: 'hi' }], { service: 'together', failover: true, maxProviders: 2 });
    const rows = reporter.batch();
    const groq = rows.find((r) => r.provider === 'groq');
    assert.deepEqual({ ...groq, ts: undefined }, { source: 'runner', provider: 'groq', model: 'groq-model', requests: 1, tokens_in: 2, tokens_out: 1, status: 'ok', ts: undefined, remaining_requests: 77 });
    assert.equal(rows.find((r) => r.provider === 'together').status, 'rate_limited');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------
// The usage reporter
// ---------------------------------------------------------------------

test('RO1 reporter: it groups the calls of a pulse into a few records and sends one batch with the ops token', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return new Response('{}', { status: 200 }); };
  const r = new UsageReporter({ workerUrl: 'https://worker.example/', token: 'T'.repeat(30), fetchImpl, now: () => NOW });
  for (let i = 0; i < 5; i += 1) r.record({ provider: 'groq', model: 'llama', status: 'ok', tokensIn: 10, tokensOut: 4 });
  r.record({ provider: 'groq', model: 'llama', status: 'error' });
  r.record({ provider: 'openrouter', model: 'a/b:free', status: 'rate_limited', remainingRequests: 3 });
  const res = await r.flush();
  assert.deepEqual(res, { sent: 3, dropped: 0 });
  assert.equal(sent.length, 1, 'one request for the whole batch');
  assert.equal(sent[0].url, 'https://worker.example/ops/usage');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers.authorization, `Bearer ${'T'.repeat(30)}`);
  const body = JSON.parse(sent[0].init.body);
  const ok = body.find((x) => x.provider === 'groq' && x.status === 'ok');
  assert.deepEqual([ok.requests, ok.tokens_in, ok.tokens_out], [5, 50, 20]);
  assert.deepEqual(Object.keys(ok).sort(), ['model', 'provider', 'requests', 'source', 'status', 'tokens_in', 'tokens_out', 'ts']);
  assert.equal(body.find((x) => x.status === 'rate_limited').remaining_requests, 3);
  assert.equal((await r.flush()).sent, 0, 'the batch is empty after a send');
});

test('RO1 reporter: no URL or no token means no call, and a hostile model name becomes *', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{}'); };
  const off = new UsageReporter({ workerUrl: '', token: '', fetchImpl });
  off.record({ provider: 'groq', model: 'x', status: 'ok' });
  assert.equal((await off.flush()).skipped, 'TITAN_WORKER_URL or OPS_TOKEN is not set');
  assert.equal(calls, 0);
  const on = new UsageReporter({ workerUrl: 'https://w.example', token: 'T'.repeat(30), fetchImpl, now: () => NOW });
  on.record({ provider: 'Weird Provider!', model: 'my prompt: tell me a secret', status: 'ok' });
  const [row] = on.batch();
  assert.deepEqual([row.provider, row.model], ['weird-provider-', '*']);
});

test('RO1 reporter: it retries a network fault once, drops a batch the Worker refuses, and never throws', async () => {
  const events = [];
  let n = 0;
  const flaky = async () => { n += 1; if (n === 1) throw new Error('network'); return new Response('{}', { status: 200 }); };
  const a = new UsageReporter({ workerUrl: 'https://w.example', token: 'T'.repeat(30), fetchImpl: flaky, now: () => NOW });
  a.record({ provider: 'groq', model: 'm', status: 'ok' });
  assert.deepEqual(await a.flush(), { sent: 1, dropped: 0 });
  const refused = new UsageReporter({ workerUrl: 'https://w.example', token: 'T'.repeat(30), fetchImpl: async () => new Response('{}', { status: 400 }), now: () => NOW, events: { append: (t, f) => events.push({ t, ...f }) } });
  refused.record({ provider: 'groq', model: 'm', status: 'ok' });
  assert.deepEqual(await refused.flush(), { sent: 0, dropped: 1 });
  assert.ok(events.some((e) => e.t === 'ops.usage.dropped' && e.reason === 'HTTP 400'));
  const down = new UsageReporter({ workerUrl: 'https://w.example', token: 'T'.repeat(30), fetchImpl: async () => { throw new Error('down'); }, now: () => NOW });
  down.record({ provider: 'groq', model: 'm', status: 'ok' });
  assert.deepEqual(await down.flush(), { sent: 0, dropped: 1 });
});

test('RO1 headers: rateLimitFrom reads the two headers and nothing else', () => {
  const h = new Headers({ 'x-ratelimit-remaining-requests': '899', 'x-ratelimit-remaining-tokens': '5000', 'x-ratelimit-limit-requests': '1000' });
  assert.deepEqual(rateLimitFrom(h), { remainingRequests: 899, remainingTokens: 5000 });
  assert.deepEqual(rateLimitFrom(new Headers()), { remainingRequests: null, remainingTokens: null });
  assert.deepEqual(rateLimitFrom(new Headers({ 'x-ratelimit-remaining-requests': 'lots' })), { remainingRequests: null, remainingTokens: null });
  assert.deepEqual(rateLimitFrom(undefined), { remainingRequests: null, remainingTokens: null });
});
