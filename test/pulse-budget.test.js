import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PulseBudget } from '../src/engine/pulseBudget.js';

test('claiming stops before the claim reserve and draining starts before the drain reserve', () => {
  let t = 0;
  const b = new PulseBudget({ budgetMs: 1000, claimReserveMs: 300, drainReserveMs: 100, now: () => t });
  assert.equal(b.canClaim(), true);
  assert.equal(b.shouldDrain(), false);
  t = 650;
  assert.equal(b.canClaim(), true, '350 left > 300 reserve');
  t = 701;
  assert.equal(b.canClaim(), false, '299 left');
  assert.equal(b.shouldDrain(), false);
  t = 901;
  assert.equal(b.shouldDrain(), true);
  assert.equal(b.remainingMs(), 99);
  t = 5000;
  assert.equal(b.remainingMs(), 0);
});

test('an explicit drain request stops claims and dispatch immediately regardless of time', () => {
  const b = new PulseBudget({ budgetMs: 100_000, now: () => 0 });
  b.requestDrain();
  assert.equal(b.canClaim(), false);
  assert.equal(b.shouldDrain(), true);
});

test('reserves are clamped so a tiny budget still allows some work', () => {
  const b = new PulseBudget({ budgetMs: 100, now: () => 0 });
  assert.ok(b.claimReserveMs <= 50);
  assert.ok(b.drainReserveMs <= 34);
  assert.equal(b.canClaim(), true);
});
