import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry, parseProbeJson, sanitizeProbeResult } from '../src/orchestrator/capabilityRegistry.js';

// Each test gets its own real scratch file — CapabilityRegistry.save()
// genuinely writes to whatever path its constructor is given (there is no
// in-memory-only mode), so two tests sharing one path would silently
// accumulate each other's observations, exactly the isolation bug a
// throwaway-looking path string like ":memory:" would hide rather than fix.
function freshRegistry() {
  const dir = mkdtempSync(join(tmpdir(), 'titan-capreg-'));
  const path = join(dir, 'capabilities.json');
  return { registry: new CapabilityRegistry(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('get() seeds an unknown model from the pool default rather than throwing', () => {
  const { registry, cleanup } = freshRegistry();
  try {
    const record = registry.get('opencode:some-brand-new-model');
    assert.equal(record.pool, 'opencode');
    assert.ok(record.strengths.length > 0);
    assert.equal(record.source, 'seed');
  } finally {
    cleanup();
  }
});

test('recordObservation accumulates a running average per category', () => {
  const { registry, cleanup } = freshRegistry();
  try {
    registry.recordObservation('phase2:groq', 'code-generation', { success: true, ms: 100 });
    registry.recordObservation('phase2:groq', 'code-generation', { success: false, ms: 300 });
    const record = registry.get('phase2:groq');
    assert.equal(record.observed['code-generation'].runs, 2);
    assert.equal(record.observed['code-generation'].successRate, 0.5);
    assert.equal(record.observed['code-generation'].avgMs, 200);
  } finally {
    cleanup();
  }
});

test('parseProbeJson recovers JSON from a fenced block or prose wrapper', () => {
  assert.deepEqual(parseProbeJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseProbeJson('here you go: {"a":1} thanks'), { a: 1 });
  assert.equal(parseProbeJson('no json here'), null);
});

test('sanitizeProbeResult clamps strengths/weaknesses to the real taxonomy', () => {
  const result = sanitizeProbeResult(
    { strengths: ['code-generation', 'not-a-real-one'], weaknesses: [], latencyClass: 'fast', contextWindow: 4096 },
    'phase2:groq',
    'phase2',
  );
  assert.deepEqual(result.strengths, ['code-generation']);
  assert.equal(result.contextWindow, 4096);
});
