import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pruneTasks, DEFAULT_MAX_TERMINAL_TASKS } from '../src/state/prune.js';

function makeTask(id, status, completedAt) {
  return {
    id,
    type: 'task',
    issueNumber: null,
    issueUrl: null,
    title: `Task ${id}`,
    prompt: 'x',
    status,
    createdAt: new Date().toISOString(),
    completedAt: completedAt ?? null,
  };
}

test('pruneTasks leaves the queue alone when under the cap', () => {
  const tasksState = { tasks: [makeTask('a', 'complete', 'x'), makeTask('b', 'pending', null)] };
  const res = pruneTasks(tasksState, { maxTasks: 10, now: new Date('2026-09-04T00:00:00Z') });
  assert.equal(res.archivedCount, 0);
  assert.equal(tasksState.tasks.length, 2);
});

test('pruneTasks archives the oldest complete/cancelled tasks and writes a digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-task-prune-'));
  const digestsDir = join(dir, 'digests');
  mkdirSync(digestsDir, { recursive: true });
  try {
    const tasks = [
      makeTask('c1', 'complete', 't1'),
      makeTask('c2', 'complete', 't2'),
      makeTask('x1', 'cancelled', 't3'),
      makeTask('f1', 'failed', 't4'),
      makeTask('b1', 'blocked', 't5'),
      makeTask('p1', 'pending', null),
      makeTask('c3', 'complete', 't6'),
    ];
    const tasksState = { tasks };
    const res = pruneTasks(tasksState, { maxTasks: 2, now: new Date('2026-09-04T00:00:00Z'), digestsDir });

    // 4 archivable (c1, c2, x1, c3), cap 2 -> the two oldest (c1, c2) archived.
    assert.equal(res.archivedCount, 2);
    assert.deepEqual(res.archivedIds, ['c1', 'c2']);
    assert.deepEqual(tasksState.tasks.map((t) => t.id), ['x1', 'f1', 'b1', 'p1', 'c3']);

    const digestFiles = readdirSync(digestsDir).filter((f) => f.includes('archive'));
    assert.equal(digestFiles.length, 1);
    const digest = readFileSync(join(digestsDir, digestFiles[0]), 'utf8');
    assert.ok(digest.includes('c1'));
    assert.ok(digest.includes('c2'));
    assert.ok(!digest.includes('f1')); // failed never archived
    assert.ok(!digest.includes('p1')); // pending never archived
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneTasks never archives failed/blocked/pending/pr-open, even past the cap', () => {
  const tasks = [
    makeTask('f1', 'failed'),
    makeTask('b1', 'blocked'),
    makeTask('p1', 'pending'),
    makeTask('r1', 'pr-open'),
    makeTask('r2', 'running'),
  ];
  const tasksState = { tasks };
  const res = pruneTasks(tasksState, { maxTasks: 0, now: new Date('2026-09-04T00:00:00Z') });
  assert.equal(res.archivedCount, 0);
  assert.equal(tasksState.tasks.length, 5);
});

test('DEFAULT_MAX_TERMINAL_TASKS is well above the dashboard history strip', () => {
  assert.ok(DEFAULT_MAX_TERMINAL_TASKS >= 30);
});

test('pruneTasks tolerates a missing/empty tasks array', () => {
  assert.deepEqual(pruneTasks({}, { maxTasks: 5 }), { archivedCount: 0, archivedIds: [] });
  assert.deepEqual(pruneTasks({ tasks: [] }, { maxTasks: 5 }), { archivedCount: 0, archivedIds: [] });
  const dir = mkdtempSync(join(tmpdir(), 'titan-task-prune-empty-'));
  try {
    // With no digestsDir writable target passed, still must not throw when archivable is empty.
    assert.deepEqual(pruneTasks({ tasks: [] }, { maxTasks: 0, now: new Date(), digestsDir: dir }), { archivedCount: 0, archivedIds: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the digest file is idempotently appended across calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-task-prune-append-'));
  const digestsDir = join(dir, 'digests');
  mkdirSync(digestsDir, { recursive: true });
  try {
    const now = new Date('2026-09-04T00:00:00Z');
    let tasksState = { tasks: [makeTask('a', 'complete'), makeTask('b', 'complete'), makeTask('c', 'complete')] };
    pruneTasks(tasksState, { maxTasks: 1, now, digestsDir });
    assert.deepEqual(tasksState.tasks.map((t) => t.id), ['c']);
    const firstDigest = readdirSync(digestsDir).find((f) => f.includes('archive'));
    const before = readFileSync(join(digestsDir, firstDigest), 'utf8');
    assert.ok(before.includes('a'));

    tasksState = { tasks: [makeTask('d', 'complete'), makeTask('e', 'complete'), makeTask('f', 'complete')] };
    pruneTasks(tasksState, { maxTasks: 1, now, digestsDir });
    const after = readFileSync(join(digestsDir, firstDigest), 'utf8');
    assert.ok(after.includes('a')); // previous archive preserved
    assert.ok(after.includes('d')); // new archive appended
    assert.ok(after.length > before.length);
    // A second prune on the same day appends to the same dated digest file.
    assert.equal(readdirSync(digestsDir).filter((f) => f.includes('archive')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
