import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile } from '../src/task/reconcile.js';
import { LeaseManager } from '../src/task/leases.js';
import { StateStore } from '../src/state/store.js';
import { taskDefaults } from '../src/state/schema.js';

function setup(nowIso = '2026-01-02T00:00:00.000Z') {
  const dir = mkdtempSync(join(tmpdir(), 'titan-reconcile-'));
  const now = () => new Date(nowIso);
  const events = [];
  const store = new StateStore({ stateDir: dir, now, events: { append: (type, f) => events.push({ type, ...f }) } });
  store.ensureLayout();
  const leases = new LeaseManager({ dir: store.leasesDir, owner: 'this-pulse', ttlMs: 60_000, now });
  return { dir, now, events, store, leases, ctx: { leases, store, now, events: { append: (type, f) => events.push({ type, ...f }) } }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function task(id, status, extra = {}) {
  return { ...taskDefaults(), id, type: 'task', title: id, prompt: 'p', status, createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

test('a running task whose lease expired is reclaimed to pending with attempts+1 and its checkpoint kept', () => {
  const s = setup();
  try {
    const zombie = task('issue-1', 'running', { attempts: 0, maxAttempts: 3, lease: { owner: 'dead', acquiredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z' } });
    s.store.saveCheckpoint({ version: 1, taskId: 'issue-1', runId: 'r', phase: 'executing', graph: { tasks: [] }, subtasks: {}, sideEffects: {}, remediations: 0, updatedAt: 'x' });
    const file = { tasks: [zombie] };
    const counts = reconcile(file, s.ctx);
    assert.equal(counts.reclaimed, 1);
    assert.equal(zombie.status, 'pending');
    assert.equal(zombie.attempts, 1);
    assert.equal(zombie.lease, null);
    assert.ok(s.store.loadCheckpoint('issue-1'), 'checkpoint retained for resume');
    assert.ok(s.events.some((e) => e.type === 'task.transition' && e.to === 'pending'));
  } finally {
    s.cleanup();
  }
});

test('a running task with a live lease (another pulse) is left alone', () => {
  const s = setup();
  try {
    const other = new LeaseManager({ dir: s.store.leasesDir, owner: 'other-pulse', ttlMs: 60_000, now: s.now });
    other.acquire('issue-2');
    const live = task('issue-2', 'running', { lease: other.read('issue-2') });
    const counts = reconcile({ tasks: [live] }, s.ctx);
    assert.equal(counts.reclaimed, 0);
    assert.equal(live.status, 'running');
  } finally {
    s.cleanup();
  }
});

test('lease churn at the attempt ceiling dead-letters the task and drops its checkpoint', () => {
  const s = setup();
  try {
    const t = task('issue-3', 'running', { attempts: 2, maxAttempts: 3, lease: { owner: 'dead', acquiredAt: 'a', expiresAt: '2026-01-01T00:00:00.000Z' } });
    s.store.saveCheckpoint({ version: 1, taskId: 'issue-3', runId: 'r', phase: 'executing', graph: null, subtasks: {}, sideEffects: {}, remediations: 0, updatedAt: 'x' });
    const counts = reconcile({ tasks: [t] }, s.ctx);
    assert.equal(counts.deadLettered, 1);
    assert.equal(t.status, 'dead-lettered');
    assert.equal(t.failure.class, 'poisoned');
    assert.equal(s.store.loadCheckpoint('issue-3'), null);
  } finally {
    s.cleanup();
  }
});

test('waiting tasks wake at wakeAt, dependency waiters follow their dependency, approval and pause time out, pr-open expires', () => {
  const s = setup('2026-03-01T00:00:00.000Z');
  try {
    const tasks = [
      task('w-backoff', 'waiting', { waitReason: 'backoff', wakeAt: '2026-02-28T00:00:00.000Z' }),
      task('w-future', 'waiting', { waitReason: 'backoff', wakeAt: '2026-03-02T00:00:00.000Z' }),
      task('dep-ok', 'complete', { completedAt: '2026-02-01T00:00:00.000Z' }),
      task('dep-bad', 'failed', { completedAt: '2026-02-01T00:00:00.000Z' }),
      task('w-dep-ok', 'waiting', { waitReason: 'dependency', wakeAt: '2026-02-01T00:00:00.000Z', dependsOn: ['dep-ok'] }),
      task('w-dep-bad', 'waiting', { waitReason: 'dependency', wakeAt: '2026-02-01T00:00:00.000Z', dependsOn: ['dep-bad'] }),
      task('w-approval', 'waiting', { waitReason: 'approval', wakeAt: '2026-02-01T00:00:00.000Z' }),
      task('paused-old', 'paused', { history: [{ at: '2026-02-01T00:00:00.000Z', from: 'pending', to: 'paused' }] }),
      task('paused-new', 'paused', { history: [{ at: '2026-02-28T00:00:00.000Z', from: 'pending', to: 'paused' }] }),
      task('pr-old', 'pr-open', { completedAt: '2026-01-01T00:00:00.000Z', prNumber: 1 }),
      task('ttl', 'pending', { expiresAt: '2026-02-01T00:00:00.000Z' }),
      task('deadline', 'pending', { deadline: '2026-02-01T00:00:00.000Z' }),
    ];
    const counts = reconcile({ tasks }, s.ctx);
    const by = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
    assert.equal(by['w-backoff'], 'pending');
    assert.equal(by['w-future'], 'waiting');
    assert.equal(by['w-dep-ok'], 'pending');
    assert.equal(by['w-dep-bad'], 'dead-lettered');
    assert.equal(by['w-approval'], 'expired');
    assert.equal(by['paused-old'], 'expired');
    assert.equal(by['paused-new'], 'paused');
    assert.equal(by['pr-old'], 'cancelled');
    assert.equal(by.ttl, 'expired');
    assert.equal(by.deadline, 'expired');
    assert.equal(counts.woken, 2);
    assert.equal(counts.dependencyFailed, 1);
    assert.equal(counts.expired, 5);
  } finally {
    s.cleanup();
  }
});

test('orphaned checkpoints and leases (no live task behind them) are removed', () => {
  const s = setup();
  try {
    s.store.saveCheckpoint({ version: 1, taskId: 'gone', runId: 'r', phase: 'executing', graph: null, subtasks: {}, sideEffects: {}, remediations: 0, updatedAt: 'x' });
    const done = task('done', 'complete', { completedAt: '2026-01-01T00:00:00.000Z' });
    s.leases.acquire('done');
    const counts = reconcile({ tasks: [done] }, s.ctx);
    assert.equal(counts.orphansRemoved, 2);
    assert.equal(s.store.listCheckpoints().length, 0);
    assert.equal(s.leases.read('done'), null);
  } finally {
    s.cleanup();
  }
});
