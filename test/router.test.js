import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankModels, selectModel } from '../src/orchestrator/router.js';

function fakeRegistry(records) {
  return { get: (modelId) => records[modelId] };
}

test('a category-strength match outranks an unmatched model', () => {
  const task = { aspect: 'code-generation' };
  const candidates = [{ modelId: 'a', pool: 'p' }, { modelId: 'b', pool: 'p' }];
  const registry = fakeRegistry({
    a: { modelId: 'a', pool: 'p', strengths: ['code-generation'], weaknesses: [], latencyClass: 'fast', observed: {} },
    b: { modelId: 'b', pool: 'p', strengths: [], weaknesses: [], latencyClass: 'fast', observed: {} },
  });
  const pools = { p: { inFlight: 0, maxConcurrency: 4 } };
  const ranked = rankModels(task, candidates, { pools, capabilityRegistry: registry });
  assert.equal(ranked[0].modelId, 'a');
});

test('a model at its concurrency cap scores 0 regardless of category match', () => {
  const task = { aspect: 'testing' };
  const candidates = [{ modelId: 'full', pool: 'p' }, { modelId: 'idle', pool: 'p' }];
  const registry = fakeRegistry({
    full: { modelId: 'full', pool: 'p', strengths: ['testing'], weaknesses: [], latencyClass: 'fast', observed: {} },
    idle: { modelId: 'idle', pool: 'p', strengths: [], weaknesses: [], latencyClass: 'slow', observed: {} },
  });
  // 'full' pool is saturated (inFlight === maxConcurrency); 'idle' has room.
  const pools = { p: { inFlight: 4, maxConcurrency: 4 } };
  const ranked = rankModels(task, [candidates[0]], { pools, capabilityRegistry: registry });
  assert.equal(ranked[0].available, false);
  assert.equal(ranked[0].score, 0);
});

test('excludePools removes a pool from the ranking entirely (the Freebuff reservation policy)', () => {
  const task = { aspect: 'architecture' };
  const candidates = [{ modelId: 'reserved', pool: 'freebuff' }, { modelId: 'other', pool: 'phase2' }];
  const registry = fakeRegistry({
    reserved: { modelId: 'reserved', pool: 'freebuff', strengths: ['architecture'], weaknesses: [], latencyClass: 'slow', observed: {} },
    other: { modelId: 'other', pool: 'phase2', strengths: [], weaknesses: [], latencyClass: 'medium', observed: {} },
  });
  const pools = { freebuff: { inFlight: 0, maxConcurrency: 1 }, phase2: { inFlight: 0, maxConcurrency: 4 } };
  const best = selectModel(task, candidates, { pools, capabilityRegistry: registry, excludePools: ['freebuff'] });
  assert.equal(best.modelId, 'other');
});

test('selectModel returns null when there are no candidates at all', () => {
  const best = selectModel({ aspect: 'testing' }, [], { pools: {}, capabilityRegistry: fakeRegistry({}) });
  assert.equal(best, null);
});
