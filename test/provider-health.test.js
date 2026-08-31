import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderHealthStore } from '../src/providers/health.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'titan-providers-'));
  const store = new ProviderHealthStore(join(dir, 'providers.json'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('an unattempted provider reads as unhealthy and unconfigured', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal(store.isHealthy('groq'), false);
    assert.equal(store.get('groq').status, 'unknown');
  } finally {
    cleanup();
  }
});

test('markNotConfigured is distinct from a failure, and never healthy', () => {
  const { store, cleanup } = tempStore();
  try {
    store.markNotConfigured('together');
    const rec = store.get('together');
    assert.equal(rec.status, 'not_configured');
    assert.equal(rec.configured, false);
    assert.equal(store.isHealthy('together'), false);
  } finally {
    cleanup();
  }
});

test('a successful call marks the provider healthy and records latency/model', () => {
  const { store, cleanup } = tempStore();
  try {
    store.recordOutcome('groq', { ok: true, latencyMs: 420, model: 'llama-3.3-70b-versatile' });
    const rec = store.get('groq');
    assert.equal(rec.status, 'ok');
    assert.equal(rec.configured, true);
    assert.equal(rec.model, 'llama-3.3-70b-versatile');
    assert.equal(rec.latencyMs, 420);
    assert.equal(rec.p50LatencyMs, 420);
    assert.ok(store.isHealthy('groq'));
  } finally {
    cleanup();
  }
});

test('a 429 puts the provider in cooldown and isHealthy returns false until it expires', () => {
  const { store, cleanup } = tempStore();
  try {
    store.recordOutcome('together', { ok: true, latencyMs: 100 }); // configured + healthy baseline
    store.recordOutcome('together', { ok: false, status: 429, code: 'RATE_LIMITED', message: 'rate limited' });
    const rec = store.get('together');
    assert.equal(rec.status, 'rate_limited');
    assert.ok(rec.cooldownUntil);
    assert.ok(Date.parse(rec.cooldownUntil) > Date.now());
    assert.equal(store.isHealthy('together'), false);
  } finally {
    cleanup();
  }
});

test('retryAfterMs from the upstream response drives the cooldown length when present', () => {
  const { store, cleanup } = tempStore();
  try {
    store.recordOutcome('gemini', { ok: true, latencyMs: 10 });
    const before = Date.now();
    store.recordOutcome('gemini', { ok: false, status: 429, code: 'RATE_LIMITED', retryAfterMs: 2000 });
    const rec = store.get('gemini');
    const cooldownMs = Date.parse(rec.cooldownUntil) - before;
    assert.ok(cooldownMs >= 1900 && cooldownMs <= 2500, `expected ~2000ms cooldown, got ${cooldownMs}`);
  } finally {
    cleanup();
  }
});

test('a 401 marks the provider misconfigured with no cooldown, and it never self-heals without a fresh success', () => {
  const { store, cleanup } = tempStore();
  try {
    store.recordOutcome('openrouter', { ok: false, status: 401, message: 'invalid api key' });
    const rec = store.get('openrouter');
    assert.equal(rec.status, 'misconfigured');
    assert.equal(rec.cooldownUntil, null);
    assert.equal(store.isHealthy('openrouter'), false);

    // Time passing changes nothing — misconfigured has no timer.
    assert.equal(store.isHealthy('openrouter'), false);

    // Only a real success clears it.
    store.recordOutcome('openrouter', { ok: true, latencyMs: 50, model: 'openai/gpt-oss-20b:free' });
    assert.equal(store.get('openrouter').status, 'ok');
    assert.ok(store.isHealthy('openrouter'));
  } finally {
    cleanup();
  }
});

test('a model-not-found error invalidates the cached model and applies a short cooldown', () => {
  const { store, cleanup } = tempStore();
  try {
    store.recordOutcome('huggingface', { ok: true, latencyMs: 30, model: 'stale/model-id' });
    store.recordOutcome('huggingface', { ok: false, status: 404, message: 'model_not_found: no such model' });
    const rec = store.get('huggingface');
    assert.equal(rec.status, 'model_invalid');
    assert.equal(rec.model, null);
    assert.ok(rec.cooldownUntil);
  } finally {
    cleanup();
  }
});

test('markNoPublicApi is permanent, distinct from every other status, and never healthy regardless of key', () => {
  const { store, cleanup } = tempStore();
  try {
    store.markNoPublicApi('freebuff', 'no official API');
    const rec = store.get('freebuff');
    assert.equal(rec.status, 'no_public_api');
    assert.equal(rec.note, 'no official API');
    assert.equal(store.isHealthy('freebuff'), false);
  } finally {
    cleanup();
  }
});

test('setDiscoveredModels updates the catalog without disturbing an existing health status', () => {
  const { store, cleanup } = tempStore();
  try {
    store.recordOutcome('groq', { ok: true, latencyMs: 200, model: 'llama-3.3-70b-versatile' });
    store.setDiscoveredModels('groq', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], 'llama-3.1-8b-instant');
    const rec = store.get('groq');
    assert.deepEqual(rec.discoveredModels, ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
    assert.equal(rec.model, 'llama-3.1-8b-instant');
    assert.equal(rec.status, 'ok'); // untouched by the discovery update
  } finally {
    cleanup();
  }
});

test('errorRate is a rolling EMA that rises on failure and decays back toward zero on success', () => {
  const { store, cleanup } = tempStore();
  try {
    store.recordOutcome('groq', { ok: true, latencyMs: 10 });
    assert.equal(store.get('groq').errorRate, 0);

    store.recordOutcome('groq', { ok: false, status: 500, message: 'boom' });
    const afterFailure = store.get('groq').errorRate;
    assert.ok(afterFailure > 0, 'a failure should raise the error rate above zero');

    store.recordOutcome('groq', { ok: true, latencyMs: 10 });
    const afterRecovery = store.get('groq').errorRate;
    assert.ok(afterRecovery < afterFailure, 'a subsequent success should decay the error rate back down');
  } finally {
    cleanup();
  }
});

test('save() then a fresh store instance over the same path loads the same records back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-providers-'));
  const path = join(dir, 'providers.json');
  try {
    const a = new ProviderHealthStore(path);
    a.recordOutcome('groq', { ok: true, latencyMs: 111, model: 'llama-3.3-70b-versatile' });
    a.save();

    const b = new ProviderHealthStore(path);
    const rec = b.get('groq');
    assert.equal(rec.status, 'ok');
    assert.equal(rec.model, 'llama-3.3-70b-versatile');
    assert.equal(rec.latencyMs, 111);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt providers.json degrades to an empty table instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-providers-'));
  const path = join(dir, 'providers.json');
  try {
    writeFileSync(path, '{ not json', 'utf8');
    const store = new ProviderHealthStore(path);
    assert.doesNotThrow(() => store.load());
    assert.equal(store.get('groq').status, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
