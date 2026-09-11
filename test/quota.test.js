import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaLedger, dailyLimitFor, FREE_TIER_DAILY_LIMITS } from '../src/state/quota.js';

function withLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'titan-quota-'));
  const path = join(dir, 'quota.json');
  try {
    fn(new QuotaLedger(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh ledger counts 0 for every provider and never reports wouldExceed for a positive limit', () => {
  withLedger((ledger) => {
    assert.equal(ledger.countToday('groq'), 0);
    assert.equal(ledger.wouldExceed('groq'), false);
  });
});

test('recordCall increments today\'s count; wouldExceed trips once the limit is reached', () => {
  withLedger((ledger) => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const limit = dailyLimitFor('openrouter');
    for (let i = 0; i < limit; i += 1) ledger.recordCall('openrouter', now);
    assert.equal(ledger.countToday('openrouter', now), limit);
    assert.equal(ledger.wouldExceed('openrouter', now), true);
  });
});

test('a provider not in FREE_TIER_DAILY_LIMITS and with no env override never blocks on quota', () => {
  withLedger((ledger) => {
    for (let i = 0; i < 100000; i += 1) ledger.recordCall('some-future-provider');
    assert.equal(dailyLimitFor('some-future-provider'), null);
    assert.equal(ledger.wouldExceed('some-future-provider'), false);
  });
});

test('the count resets at UTC midnight — yesterday\'s count does not carry over', () => {
  withLedger((ledger) => {
    const limit = dailyLimitFor('gemini');
    const yesterday = new Date('2026-01-01T23:59:00.000Z');
    for (let i = 0; i < limit; i += 1) ledger.recordCall('gemini', yesterday);
    assert.equal(ledger.wouldExceed('gemini', yesterday), true);

    const today = new Date('2026-01-02T00:05:00.000Z');
    assert.equal(ledger.countToday('gemini', today), 0);
    assert.equal(ledger.wouldExceed('gemini', today), false);
  });
});

test('save() + a fresh QuotaLedger over the same path round-trips today\'s counts', () => {
  withLedger((ledger, path) => {
    const now = new Date();
    ledger.recordCall('groq', now);
    ledger.recordCall('groq', now);
    ledger.save();

    const reloaded = new QuotaLedger(path);
    assert.equal(reloaded.countToday('groq', now), 2);
  });
});

test('an env override (`<PROVIDER>_DAILY_LIMIT`) takes precedence over the hardcoded floor', () => {
  const prev = process.env.GROQ_DAILY_LIMIT;
  process.env.GROQ_DAILY_LIMIT = '7';
  try {
    assert.equal(dailyLimitFor('groq'), 7);
  } finally {
    if (prev === undefined) delete process.env.GROQ_DAILY_LIMIT;
    else process.env.GROQ_DAILY_LIMIT = prev;
  }
});

test('every documented provider in FREE_TIER_DAILY_LIMITS has a positive integer limit', () => {
  for (const [id, limit] of Object.entries(FREE_TIER_DAILY_LIMITS)) {
    assert.ok(Number.isInteger(limit) && limit > 0, `${id} must have a positive integer daily limit`);
  }
});
