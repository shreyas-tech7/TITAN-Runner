import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, readLock } from '../src/state/lock.js';

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'titan-lock-'));
  const path = join(dir, 'lock.json');
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('acquireLock succeeds against an unlocked (missing) lock file', () => {
  withScratch((path) => {
    assert.equal(readLock(path), null);
    const result = acquireLock({ runId: 'run-1', holder: 'pulse', path });
    assert.equal(result.ok, true);
    const stored = readLock(path);
    assert.equal(stored.runId, 'run-1');
    assert.equal(stored.holder, 'pulse');
  });
});

test('a second run cannot acquire a live, unexpired lock held by a different run', () => {
  withScratch((path) => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    acquireLock({ runId: 'run-1', holder: 'pulse', path, now, ttlMs: 10 * 60_000 });
    const second = acquireLock({ runId: 'run-2', holder: 'pulse', path, now: new Date('2026-01-01T00:05:00.000Z') });
    assert.equal(second.ok, false);
    assert.equal(second.heldBy.runId, 'run-1');
  });
});

test('an expired (stale) lock is reclaimed by the next run', () => {
  withScratch((path) => {
    const acquiredAt = new Date('2026-01-01T00:00:00.000Z');
    acquireLock({ runId: 'run-1', holder: 'pulse', path, now: acquiredAt, ttlMs: 60_000 }); // expires 00:01:00
    const later = new Date('2026-01-01T00:05:00.000Z'); // 4 minutes past expiry
    const result = acquireLock({ runId: 'run-2', holder: 'pulse', path, now: later });
    assert.equal(result.ok, true);
    assert.equal(readLock(path).runId, 'run-2');
  });
});

test('the same run id re-acquiring its own lock always succeeds (idempotent)', () => {
  withScratch((path) => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    acquireLock({ runId: 'run-1', holder: 'pulse', path, now });
    const result = acquireLock({ runId: 'run-1', holder: 'pulse', path, now });
    assert.equal(result.ok, true);
  });
});

test('releaseLock clears the lock when called by its own holder', () => {
  withScratch((path) => {
    acquireLock({ runId: 'run-1', holder: 'pulse', path });
    releaseLock('run-1', path);
    const stored = readLock(path);
    assert.equal(stored.runId, null);
    // Released, so a different run can now acquire it immediately.
    const result = acquireLock({ runId: 'run-2', holder: 'pulse', path });
    assert.equal(result.ok, true);
  });
});

test('releaseLock is a no-op if the lock was already reclaimed by a different run', () => {
  withScratch((path) => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    acquireLock({ runId: 'run-1', holder: 'pulse', path, now, ttlMs: 60_000 });
    // run-1 overran its TTL; run-2 reclaimed the stale lock.
    acquireLock({ runId: 'run-2', holder: 'pulse', path, now: new Date('2026-01-01T00:05:00.000Z') });
    // run-1's late release must not clobber run-2's live lock.
    releaseLock('run-1', path);
    assert.equal(readLock(path).runId, 'run-2');
  });
});
