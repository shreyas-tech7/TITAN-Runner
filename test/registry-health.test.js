import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Registry } from '../src/providers/registry.js';
import { ProviderHealthStore } from '../src/providers/health.js';

function fakeProvider(id, { configured = true, reply } = {}) {
  return {
    id,
    isConfigured: () => configured,
    chat: async () => {
      if (reply) return reply();
      return { text: `reply from ${id}`, service: id, model: `${id}-model`, latencyMs: 1, tokensUsed: 1 };
    },
  };
}

function tempHealth() {
  const dir = mkdtempSync(join(tmpdir(), 'titan-registry-'));
  const store = new ProviderHealthStore(join(dir, 'providers.json'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a freshly configured provider that has never been attempted is healthy by default (no deadlock)', () => {
  const { store, cleanup } = tempHealth();
  try {
    // Mirrors pulse.js's primeProviderHealth(): a key exists, but no live
    // call or self-test has ever run against it yet.
    store.markConfigured('groq');
    assert.equal(store.get('groq').status, 'unknown');
    assert.ok(store.isHealthy('groq'));
  } finally {
    cleanup();
  }
});

test('an unhealthy (cooling-down) provider is skipped in "auto" mode, and the next in order is used', async () => {
  const { store, cleanup } = tempHealth();
  try {
    for (const id of ['together', 'openrouter', 'gemini', 'huggingface']) store.markConfigured(id);
    store.recordOutcome('groq', { ok: true, latencyMs: 10 });
    store.recordOutcome('groq', { ok: false, status: 429, code: 'RATE_LIMITED' }); // now cooling down

    const providers = new Map([
      ['groq', fakeProvider('groq')],
      ['together', fakeProvider('together')],
      ['openrouter', fakeProvider('openrouter')],
      ['gemini', fakeProvider('gemini')],
      ['huggingface', fakeProvider('huggingface')],
    ]);
    const registry = new Registry({ providers, healthStore: store });

    const result = await registry.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.service, 'together');
  } finally {
    cleanup();
  }
});

test('a misconfigured (401) provider is skipped and never retried in "auto" mode', async () => {
  const { store, cleanup } = tempHealth();
  try {
    for (const id of ['together', 'openrouter', 'gemini', 'huggingface']) store.markConfigured(id);
    store.recordOutcome('groq', { ok: false, status: 401, message: 'bad key' });

    const providers = new Map([
      ['groq', fakeProvider('groq')],
      ['together', fakeProvider('together')],
      ['openrouter', fakeProvider('openrouter')],
      ['gemini', fakeProvider('gemini')],
      ['huggingface', fakeProvider('huggingface')],
    ]);
    const registry = new Registry({ providers, healthStore: store });

    const result = await registry.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.service, 'together');
  } finally {
    cleanup();
  }
});

test('an explicit service hint still gets one honest attempt even while cooling down', async () => {
  const { store, cleanup } = tempHealth();
  try {
    store.recordOutcome('groq', { ok: true, latencyMs: 10 });
    store.recordOutcome('groq', { ok: false, status: 429, code: 'RATE_LIMITED' });

    const providers = new Map([['groq', fakeProvider('groq')], ['together', fakeProvider('together')]]);
    const registry = new Registry({ providers, healthStore: store });

    const result = await registry.chat([{ role: 'user', content: 'hi' }], { service: 'groq' });
    assert.equal(result.service, 'groq');
  } finally {
    cleanup();
  }
});

test('every provider unhealthy or unconfigured throws ALL_PROVIDERS_FAILED naming what was skipped', async () => {
  const { store, cleanup } = tempHealth();
  try {
    store.recordOutcome('groq', { ok: false, status: 401 });
    store.markNotConfigured('together');

    const providers = new Map([['groq', fakeProvider('groq')], ['together', fakeProvider('together', { configured: false })]]);
    const registry = new Registry({ providers, healthStore: store });

    await assert.rejects(
      () => registry.chat([{ role: 'user', content: 'hi' }]),
      (err) => {
        assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
        assert.match(err.message, /skipped, unhealthy: groq/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});
