import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerifyPrompt, parseVerdict, runVerification } from '../src/orchestrator/verifier.js';

/** A minimal AgentAdapter-shaped fake the Scheduler can drive with zero I/O. */
class FakeAdapter {
  constructor({ pool, modelId, result }) {
    this.pool = pool;
    this.modelId = modelId;
    this.result = result;
    this.inFlight = 0;
    this.maxConcurrency = 2;
    this.calls = 0;
  }
  async listModels() {
    return [{ modelId: this.modelId, pool: this.pool, contextWindow: 1000 }];
  }
  async execute() {
    this.calls += 1;
    return this.result;
  }
}

/** A capabilityRegistry-shaped fake: strengths in `testing` so the verify task routes. */
function fakeRegistry() {
  return {
    get: (modelId) => ({
      modelId,
      pool: String(modelId).split(':')[0],
      strengths: ['testing'],
      weaknesses: [],
      latencyClass: 'fast',
      contextWindow: 1000,
      source: 'seed',
      probedAt: null,
      observed: {},
    }),
    recordObservation: () => {},
    list: () => [],
    save: () => {},
  };
}

const okResult = (output) => ({ ok: true, output, modelId: 'fake:model', tokensUsed: 42, ms: 3, error: null });

test('parseVerdict accepts pass/true, passed/false, fenced JSON, and garbage defensively', () => {
  assert.deepEqual(parseVerdict('{"pass": true, "issues": []}'), { pass: true, issues: [] });
  assert.deepEqual(parseVerdict('```json\n{"passed": false, "issues": ["missing tests"]}\n```'), {
    pass: false,
    issues: ['missing tests'],
  });
  assert.deepEqual(parseVerdict('{"verdict": "fail", "issues": ["a", 3, "b"]}'), {
    pass: false,
    issues: ['a', 'b'],
  });
  assert.deepEqual(parseVerdict('here is some prose, no json'), { pass: null, issues: [] });
  assert.deepEqual(parseVerdict(''), { pass: null, issues: [] });
  assert.deepEqual(parseVerdict(null), { pass: null, issues: [] });
});

test('buildVerifyPrompt carries the master prompt, every path, and caps content', () => {
  const files = [
    { path: 'a.js', content: 'x'.repeat(5000) },
    { path: 'b.js', content: 'short' },
  ];
  const prompt = buildVerifyPrompt('build a widget', files);
  assert.ok(prompt.includes('build a widget'));
  assert.ok(prompt.includes('a.js'));
  assert.ok(prompt.includes('b.js'));
  // a.js's 5000 chars are capped at MAX_VERIFY_FILE_CHARS=1500.
  assert.ok(prompt.includes('x'.repeat(1500)));
  assert.ok(!prompt.includes('x'.repeat(1501)));
});

test('runVerification skips when there are no files', async () => {
  const pools = { fake: new FakeAdapter({ pool: 'fake', modelId: 'fake:model', result: okResult('{"pass":true,"issues":[]}') }) };
  const res = await runVerification({ pools, capabilityRegistry: fakeRegistry(), masterPrompt: 'x', files: [] });
  assert.equal(res.state, 'skipped');
  assert.equal(res.ran, false);
});

test('runVerification passes with a passing verdict and reports spend', async () => {
  const adapter = new FakeAdapter({ pool: 'fake', modelId: 'fake:model', result: okResult('{"pass":true,"issues":[]}') });
  const pools = { fake: adapter };
  const res = await runVerification({
    pools,
    capabilityRegistry: fakeRegistry(),
    masterPrompt: 'build x',
    files: [{ path: 'a.js', content: 'console.log(1)' }],
    taskTimeoutMs: 1000,
  });
  assert.equal(res.state, 'passed');
  assert.equal(res.ran, true);
  assert.equal(res.tokensUsed, 42);
  assert.equal(res.modelId, 'fake:model');
  assert.ok(adapter.calls >= 1);
});

test('runVerification fails (never blocks) with a failing verdict and its issues', async () => {
  const pools = {
    fake: new FakeAdapter({ pool: 'fake', modelId: 'fake:model', result: okResult('{"pass":false,"issues":["missing file","no tests"]}') }),
  };
  const res = await runVerification({
    pools,
    capabilityRegistry: fakeRegistry(),
    masterPrompt: 'build x',
    files: [{ path: 'a.js', content: 'x' }],
    taskTimeoutMs: 1000,
  });
  assert.equal(res.state, 'failed');
  assert.deepEqual(res.issues, ['missing file', 'no tests']);
});

test('runVerification is unavailable (not failed) when the model returns non-verdict text', async () => {
  const pools = {
    fake: new FakeAdapter({ pool: 'fake', modelId: 'fake:model', result: okResult('just some prose, nothing structured') }),
  };
  const res = await runVerification({
    pools,
    capabilityRegistry: fakeRegistry(),
    masterPrompt: 'build x',
    files: [{ path: 'a.js', content: 'x' }],
    taskTimeoutMs: 1000,
  });
  assert.equal(res.state, 'unavailable');
});

test('runVerification is unavailable (not failed) when the adapter call fails', async () => {
  const pools = {
    fake: new FakeAdapter({
      pool: 'fake',
      modelId: 'fake:model',
      result: { ok: false, output: null, modelId: 'fake:model', tokensUsed: null, ms: 3, error: { code: 'UPSTREAM_ERROR', message: 'boom' } },
    }),
  };
  const res = await runVerification({
    pools,
    capabilityRegistry: fakeRegistry(),
    masterPrompt: 'build x',
    files: [{ path: 'a.js', content: 'x' }],
    taskTimeoutMs: 1000,
  });
  assert.equal(res.state, 'unavailable');
  assert.equal(res.pass, undefined);
});
