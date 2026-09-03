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

test('a "fast" routing hint breaks a tie between two equal-strength candidates in favor of the faster one', () => {
  const task = { aspect: 'code-generation', routingHint: 'fast' };
  const candidates = [{ modelId: 'slow', pool: 'p' }, { modelId: 'fast', pool: 'p' }];
  const registry = fakeRegistry({
    slow: { modelId: 'slow', pool: 'p', strengths: ['code-generation'], weaknesses: [], latencyClass: 'slow', observed: {} },
    fast: { modelId: 'fast', pool: 'p', strengths: ['code-generation'], weaknesses: [], latencyClass: 'fast', observed: {} },
  });
  const pools = { p: { inFlight: 0, maxConcurrency: 4 } };
  const ranked = rankModels(task, candidates, { pools, capabilityRegistry: registry });
  assert.equal(ranked[0].modelId, 'fast');
  assert.ok(ranked[0].score > ranked[1].score, 'the fast hint should widen the gap beyond the plain tiebreak');
});

test('a routing hint never lets latency or observed success override a real category mismatch', () => {
  const task = { aspect: 'code-generation', routingHint: 'fast' };
  const candidates = [{ modelId: 'wrong-but-fast', pool: 'p' }, { modelId: 'right-but-slow', pool: 'p' }];
  const registry = fakeRegistry({
    'wrong-but-fast': { modelId: 'wrong-but-fast', pool: 'p', strengths: [], weaknesses: [], latencyClass: 'fast', observed: {} },
    'right-but-slow': { modelId: 'right-but-slow', pool: 'p', strengths: ['code-generation'], weaknesses: [], latencyClass: 'slow', observed: {} },
  });
  const pools = { p: { inFlight: 0, maxConcurrency: 4 } };
  const ranked = rankModels(task, candidates, { pools, capabilityRegistry: registry });
  assert.equal(ranked[0].modelId, 'right-but-slow');
});

test('an unset/unrecognised routing hint scores identically to explicit "any" (no behavior change for existing callers)', () => {
  const task = { aspect: 'testing' };
  const candidates = [{ modelId: 'a', pool: 'p' }];
  const registry = fakeRegistry({
    a: { modelId: 'a', pool: 'p', strengths: ['testing'], weaknesses: [], latencyClass: 'fast', observed: { testing: { runs: 5, successRate: 0.8, avgMs: 100 } } },
  });
  const pools = { p: { inFlight: 0, maxConcurrency: 4 } };
  const withoutHint = rankModels(task, candidates, { pools, capabilityRegistry: registry })[0].score;
  const withAny = rankModels({ ...task, routingHint: 'any' }, candidates, { pools, capabilityRegistry: registry })[0].score;
  const withJunk = rankModels({ ...task, routingHint: 'yolo' }, candidates, { pools, capabilityRegistry: registry })[0].score;
  assert.equal(withoutHint, withAny);
  assert.equal(withoutHint, withJunk);
});

test('a "careful" routing hint amplifies observed success rate but stays below a category-match gap', () => {
  const task = { aspect: 'architecture', routingHint: 'careful' };
  const candidates = [{ modelId: 'proven', pool: 'p' }];
  const registry = fakeRegistry({
    proven: { modelId: 'proven', pool: 'p', strengths: ['architecture'], weaknesses: [], latencyClass: 'medium', observed: { architecture: { runs: 10, successRate: 1, avgMs: 500 } } },
  });
  const pools = { p: { inFlight: 0, maxConcurrency: 4 } };
  const careful = rankModels(task, candidates, { pools, capabilityRegistry: registry })[0].score;
  const any = rankModels({ ...task, routingHint: 'any' }, candidates, { pools, capabilityRegistry: registry })[0].score;
  assert.ok(careful > any);
});
