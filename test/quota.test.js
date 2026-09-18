import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaLedger, DEFAULT_LIMITS, DEFAULT_RESERVE_FRACTION } from '../src/reliability/quota.js';

function clock(startIso) {
  let t = Date.parse(startIso);
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

test('a fresh ledger lets every provider spend, and counts each call against the minute and the day', () => {
  const c = clock('2026-03-01T10:00:00.000Z');
  const q = new QuotaLedger({ now: c.now, env: {} });
  assert.equal(q.canSpend('groq').ok, true);
  q.record('groq', { tokens: 120 });
  q.record('groq', { tokens: 80 });
  const s = q.snapshot().groq;
  assert.deepEqual([s.usedMinute, s.usedDay, s.tokensToday, s.perMinute, s.perDay], [2, 2, 200, DEFAULT_LIMITS.groq.perMinute, DEFAULT_LIMITS.groq.perDay]);
});

test('a spent per-minute window refuses until the minute rolls over, and says when that is', () => {
  const c = clock('2026-03-01T10:00:30.000Z');
  const q = new QuotaLedger({ now: c.now, env: {}, limits: { groq: { perMinute: 2, perDay: 100 } } });
  q.record('groq');
  q.record('groq');
  const refused = q.canSpend('groq');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /per-minute/);
  assert.equal(q.nextMinuteResetMs(), 30_000);
  c.advance(30_000);
  assert.equal(q.canSpend('groq').ok, true, 'new minute, new window');
  assert.equal(q.snapshot().groq.usedDay, 2, 'the day count carries over');
});

test('the daily reserve is held back for high-priority work: normal work stops early, urgent work spends to the end', () => {
  const c = clock('2026-03-01T10:00:00.000Z');
  const q = new QuotaLedger({ now: c.now, env: {}, limits: { groq: { perMinute: 1000, perDay: 20 } } });
  const reserve = Math.ceil(20 * DEFAULT_RESERVE_FRACTION);
  for (let i = 0; i < 20 - reserve; i += 1) q.record('groq');
  const normal = q.canSpend('groq', { priority: 'normal' });
  assert.equal(normal.ok, false);
  assert.match(normal.reason, /reserve/);
  assert.equal(q.canSpend('groq', { priority: 'urgent' }).ok, true);
  for (let i = 0; i < reserve; i += 1) q.record('groq');
  assert.equal(q.canSpend('groq', { priority: 'urgent' }).ok, false, 'the reserve is finite too');
  c.advance(24 * 3_600_000);
  assert.equal(q.canSpend('groq').ok, true, 'a new UTC day resets the day window');
  assert.equal(q.snapshot().groq.tokensToday, 0);
});

test('environment overrides replace one ceiling without losing the other, and unknown providers get a conservative fallback', () => {
  const q = new QuotaLedger({ env: { TITAN_QUOTA_GROQ_PER_MINUTE: '3', TITAN_QUOTA_NEWONE_PER_DAY: '7', TITAN_QUOTA_GEMINI_PER_DAY: 'not-a-number' } });
  assert.deepEqual(q.limitFor('groq'), { perMinute: 3, perDay: DEFAULT_LIMITS.groq.perDay });
  assert.equal(q.limitFor('newone').perDay, 7);
  assert.deepEqual(q.limitFor('gemini'), DEFAULT_LIMITS.gemini, 'a junk value is ignored');
  assert.ok(q.limitFor('never-heard-of-it').perMinute > 0);
});

test('save() writes through the injected writer only when dirty, and a new ledger over the same file resumes the counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-quota-'));
  try {
    const path = join(dir, 'quota.json');
    const c = clock('2026-03-01T10:00:00.000Z');
    const writes = [];
    const writeJson = (p, data) => { writes.push(p); writeFileSync(p, JSON.stringify(data)); };
    const q = new QuotaLedger({ path, now: c.now, env: {}, writeJson });
    assert.equal(q.save(), false, 'nothing to save yet');
    q.record('together', { tokens: 5, status: 429 });
    assert.equal(q.save(), true);
    assert.equal(q.save(), false, 'clean after a save');
    assert.deepEqual(writes, [path]);
    assert.ok(existsSync(path));
    const again = new QuotaLedger({ path, now: c.now, env: {} });
    const s = again.snapshot().together;
    assert.deepEqual([s.usedMinute, s.usedDay, s.tokensToday], [1, 1, 5]);
    assert.equal(s.last429At, '2026-03-01T10:00:00.000Z');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt quota file degrades to an empty ledger instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-quota-'));
  try {
    const path = join(dir, 'quota.json');
    writeFileSync(path, '{not json');
    const q = new QuotaLedger({ path, env: {} });
    assert.equal(q.canSpend('groq').ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
