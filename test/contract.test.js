import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRunEnvelope, CONTRACT_VERSION, majorOf } from '../src/state/contract.js';

function envelope(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    runId: 'a1b2c3d4-0000-4000-8000-000000000000',
    taskId: 'issue-1',
    title: 'Do the thing',
    status: 'done',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    redacted: true,
    subtasks: [
      {
        id: 't1', title: 'Sub 1', agent: 'phase2', provider: 'groq', model: 'llama', status: 'complete',
        startedAt: null, endedAt: null, attempts: 1, tokensIn: null, tokensOut: 42, costUsd: 0, artifacts: [],
      },
    ],
    reviewer: { verdict: 'allow', reasons: [], ruleIds: [] },
    metrics: { durationMs: 100, providerCalls: 1, retries: 0, failoverHops: 0 },
    ...overrides,
  };
}

test('a well-formed envelope validates clean', () => {
  const { ok, errors } = validateRunEnvelope(envelope());
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test('missing contractVersion is rejected before anything else is even checked', () => {
  const { ok, errors } = validateRunEnvelope(envelope({ contractVersion: undefined }));
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /contractVersion/);
});

test('an unknown major version is rejected loudly rather than best-effort parsed', () => {
  const { ok, errors } = validateRunEnvelope(envelope({ contractVersion: '2.0.0' }));
  assert.equal(ok, false);
  assert.match(errors.join(' '), /major version 2 is not supported/);
});

test('redacted: false is always a hard failure, whatever else is valid', () => {
  const { ok, errors } = validateRunEnvelope(envelope({ redacted: false }));
  assert.equal(ok, false);
  assert.match(errors.join(' '), /redacted: must be true/);
});

test('an invalid status enum member is rejected', () => {
  const { ok, errors } = validateRunEnvelope(envelope({ status: 'in-progress-ish' }));
  assert.equal(ok, false);
  assert.match(errors.join(' '), /status: expected one of/);
});

test('costUsd must always be exactly 0 on every subtask', () => {
  const { ok, errors } = validateRunEnvelope(
    envelope({ subtasks: [{ id: 't1', title: 'x', costUsd: 0.02, artifacts: [] }] }),
  );
  assert.equal(ok, false);
  assert.match(errors.join(' '), /costUsd: must always be 0/);
});

test('reviewer.verdict must be one of allow|block|needs-human', () => {
  const { ok, errors } = validateRunEnvelope(envelope({ reviewer: { verdict: 'maybe', reasons: [], ruleIds: [] } }));
  assert.equal(ok, false);
  assert.match(errors.join(' '), /reviewer\.verdict/);
});

test('a completely non-object value is rejected without throwing', () => {
  assert.doesNotThrow(() => validateRunEnvelope(null));
  assert.doesNotThrow(() => validateRunEnvelope('a string'));
  assert.doesNotThrow(() => validateRunEnvelope(42));
  assert.equal(validateRunEnvelope(null).ok, false);
});

test('majorOf parses the leading semver component and rejects garbage', () => {
  assert.equal(majorOf('1.0.0'), 1);
  assert.equal(majorOf('12.34.56'), 12);
  assert.equal(majorOf('not-a-version'), null);
  assert.equal(majorOf(undefined), null);
});
