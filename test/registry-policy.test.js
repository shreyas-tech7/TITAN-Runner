import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Registry, DEFAULT_MAX_PROVIDERS_PER_CALL, FAILOVER_ORDER } from '../src/providers/registry.js';
import { ProviderHealthStore } from '../src/providers/health.js';
import { QuotaLedger } from '../src/reliability/quota.js';

/** A provider whose every call fails with the given status, or answers. */
function stub(id, { fail } = {}) {
  const calls = [];
  return {
    id,
    calls,
    isConfigured: () => true,
    chat: async () => {
      calls.push(1);
      if (fail) throw Object.assign(new Error(`${id} failed (${fail.status ?? fail.code})`), fail);
      return { text: `reply from ${id}`, service: id, model: `${id}-model`, latencyMs: 1, tokensUsed: 3 };
    },
  };
}

function world({ fail = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'titan-registry-policy-'));
  const health = new ProviderHealthStore(join(dir, 'providers.json'));
  const providers = new Map(FAILOVER_ORDER.map((id) => [id, stub(id, { fail: fail[id] ?? fail['*'] })]));
  for (const id of FAILOVER_ORDER) health.markConfigured(id);
  const decisions = [];
  const registry = new Registry({ providers, healthStore: health, onDecision: (d) => decisions.push(d) });
  const callsTo = (id) => providers.get(id).calls.length;
  return { registry, health, providers, decisions, callsTo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('an "auto" call fails over across at most three providers and reports the aggregate class', async () => {
  const w = world({ fail: { '*': { status: 503 } } });
  try {
    await assert.rejects(() => w.registry.chat([{ role: 'user', content: 'hi' }]), (err) => {
      assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
      assert.equal(err.failureClass, 'provider_down');
      assert.equal(err.failures.length, DEFAULT_MAX_PROVIDERS_PER_CALL);
      return true;
    });
    assert.equal(FAILOVER_ORDER.reduce((n, id) => n + w.callsTo(id), 0), DEFAULT_MAX_PROVIDERS_PER_CALL);
    assert.equal(w.callsTo('gemini') + w.callsTo('huggingface'), 0, 'the last two were never touched');
    const d = w.decisions.at(-1);
    assert.deepEqual([d.chosen, d.tried, d.failureClass], [null, ['groq', 'together', 'openrouter'], 'provider_down']);
  } finally {
    w.cleanup();
  }
});

test('a named provider is tried alone: the scheduler above already rotates candidates, so no second failover layer', async () => {
  const w = world({ fail: { groq: { status: 429, retryAfterMs: 7000, code: 'RATE_LIMITED' } } });
  try {
    await assert.rejects(() => w.registry.chat([{ role: 'user', content: 'hi' }], { service: 'groq' }), (err) => {
      assert.equal(err.failureClass, 'rate_limited');
      assert.equal(err.retryAfterMs, 7000, 'Retry-After survives the aggregate');
      return true;
    });
    assert.equal(w.callsTo('groq'), 1);
    assert.equal(w.callsTo('together'), 0);
    const explicit = await w.registry.chat([{ role: 'user', content: 'hi' }], { service: 'groq', failover: true });
    assert.equal(explicit.service, 'together', 'failover can still be asked for by name');
  } finally {
    w.cleanup();
  }
});

test('the quota ledger is consulted before a call: a spent provider is skipped, the skip is classified and reported', async () => {
  const w = world();
  try {
    const quota = new QuotaLedger({ env: {}, limits: { groq: { perMinute: 1, perDay: 100 } } });
    w.registry.useQuota(quota);
    const first = await w.registry.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(first.service, 'groq');
    assert.equal(quota.snapshot().groq.usedMinute, 1, 'the ledger counted the call');
    assert.equal(quota.snapshot().groq.tokensToday, 3, 'and its tokens');
    const second = await w.registry.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(second.service, 'together');
    assert.equal(w.callsTo('groq'), 1, 'groq was not called into a 429');
    const d = w.decisions.at(-1);
    assert.deepEqual(d.skipped.map((s) => [s.id, s.class]), [['groq', 'budget_exhausted']]);
    assert.match(d.skipped[0].reason, /quota/);
    // A named request past its quota is refused with the class the caller can park on.
    await assert.rejects(() => w.registry.chat([{ role: 'user', content: 'hi' }], { service: 'groq' }), (err) => {
      assert.equal(err.failureClass, 'budget_exhausted');
      return true;
    });
    w.registry.useQuota(null);
    assert.equal((await w.registry.chat([{ role: 'user', content: 'hi' }])).service, 'groq', 'detached ledger, groq is back');
  } finally {
    w.cleanup();
  }
});

test('when nothing was tried, the aggregate class comes from why each provider was skipped', async () => {
  const w = world();
  try {
    for (const id of FAILOVER_ORDER) w.health.recordOutcome(id, { ok: false, status: 401, message: 'bad key' });
    await assert.rejects(() => w.registry.chat([{ role: 'user', content: 'hi' }]), (err) => {
      assert.equal(err.failureClass, 'permanent', 'five disabled breakers are permanent, not "provider down"');
      assert.equal(err.skipped.length, FAILOVER_ORDER.length);
      return true;
    });
    assert.equal(FAILOVER_ORDER.reduce((n, id) => n + w.callsTo(id), 0), 0, 'no call was made');
  } finally {
    w.cleanup();
  }
});

test('a decision sink that throws never breaks routing, and a per-call maxProviders override is honoured', async () => {
  const w = world({ fail: { '*': { status: 500 } } });
  try {
    w.registry.useDecisionSink(() => { throw new Error('sink exploded'); });
    await assert.rejects(() => w.registry.chat([{ role: 'user', content: 'hi' }], { maxProviders: 1 }), (err) => err.code === 'ALL_PROVIDERS_FAILED');
    assert.equal(FAILOVER_ORDER.reduce((n, id) => n + w.callsTo(id), 0), 1);
  } finally {
    w.cleanup();
  }
});
