import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, mergeTasksByOwnership } from '../src/state/store.js';
import { migrateTasks, TASKS_SCHEMA_VERSION, TASKS_FILE_SCHEMA } from '../src/state/schema.js';
import { check } from '../src/lib/validate.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'titan-store-'));
  const events = [];
  const store = new StateStore({ stateDir: dir, now: () => new Date('2026-01-05T00:00:00.000Z'), events: { append: (type, f) => events.push({ type, ...f }) } });
  return { dir, store, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("today's v1 tasks.json (fixture) loads, migrates to v2 with defaults, validates, and keeps every legacy field and status", () => {
  const { dir, store, events, cleanup } = fresh();
  try {
    cpSync(join(FIXTURES, 'state-v1', 'tasks.json'), join(dir, 'tasks.json'));
    const file = store.loadTasks();
    assert.equal(file.version, TASKS_SCHEMA_VERSION);
    assert.equal(file.tasks.length, 4);
    assert.deepEqual(file.tasks.map((t) => t.status), ['failed', 'complete', 'pr-open', 'pending']);
    const t = file.tasks[0];
    assert.equal(t.runId, '10181d1d-8d5d-4f9b-98b2-978e68747234');
    assert.equal(t.priority, 'normal', 'null priority normalised');
    assert.equal(t.attempts, 0);
    assert.equal(t.maxAttempts, 3);
    assert.equal(t.lease, null);
    assert.deepEqual(t.dependsOn, []);
    assert.equal(file.tasks[2].priority, 'high');
    assert.equal(file.tasks[2].prNumber, 7);
    assert.ok(check(file, TASKS_FILE_SCHEMA).ok);
    assert.ok(events.some((e) => e.type === 'state.migrated' && e.from === 1 && e.to === 2));
    // Round trip: saving writes v2, and v1 code would still read the legacy fields.
    assert.equal(store.saveTasks(file), true);
    const written = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
    assert.equal(written.version, 2);
    assert.equal(written.tasks[1].title, 'write a haiku generator');
    // Migrating a v2 file is a no-op.
    assert.equal(migrateTasks(written).migrated, false);
  } finally {
    cleanup();
  }
});

test('a corrupt tasks.json is repaired from the backup, the bytes are quarantined, and an event records it', () => {
  const { dir, store, events, cleanup } = fresh();
  try {
    store.ensureLayout();
    const file = store.loadTasks();
    file.tasks.push({ id: 'issue-1', type: 'task', title: 'a', prompt: 'b', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', attempts: 0, maxAttempts: 3, dependsOn: [], history: [], priority: 'normal' });
    store.saveTasks(file);
    file.tasks.push({ id: 'issue-2', type: 'task', title: 'a', prompt: 'b', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', attempts: 0, maxAttempts: 3, dependsOn: [], history: [], priority: 'normal' });
    store.saveTasks(file); // backup now holds the 1-task version
    writeFileSync(join(dir, 'tasks.json'), '<<<<<<< HEAD\n{"version":2,"tasks":[\n=======\ngarbage\n>>>>>>> theirs\n');
    const store2 = new StateStore({ stateDir: dir, now: () => new Date('2026-01-05T00:00:00.000Z'), events: { append: (type, f) => events.push({ type, ...f }) } });
    const repaired = store2.loadTasks();
    assert.equal(repaired.tasks.length, 1, 'repaired from the last good backup');
    assert.equal(store2.repairs.length, 1);
    assert.equal(store2.repairs[0].repairedFrom, 'backup');
    const quarantined = readdirSync(join(dir, 'quarantine'));
    assert.ok(quarantined.some((f) => f.startsWith('tasks.json.') && f.endsWith('.corrupt')));
    assert.ok(events.some((e) => e.type === 'state.repaired' && e.from === 'backup'));
  } finally {
    cleanup();
  }
});

test('a schema-invalid file (parses, wrong shape) is also treated as corrupt; a valid write refuses invalid data', () => {
  const { dir, store, cleanup } = fresh();
  try {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [{ id: 'x', status: 'flying' }] }));
    const file = store.loadTasks();
    assert.equal(file.tasks.length, 0, 'fell back to the default (no backup existed)');
    assert.equal(store.repairs[0].repairedFrom, null);
    assert.throws(() => store.saveTasks({ version: 2, tasks: [{ id: 'y', status: 'flying' }] }), /refusing to write invalid/);
  } finally {
    cleanup();
  }
});

test('writing unchanged content is a no-op (an idle pulse does not churn the queue)', () => {
  const { dir, store, cleanup } = fresh();
  try {
    store.ensureLayout();
    const file = store.loadTasks();
    const before = readFileSync(join(dir, 'tasks.json'), 'utf8');
    assert.equal(store.saveTasks(file), false);
    assert.equal(readFileSync(join(dir, 'tasks.json'), 'utf8'), before);
    assert.equal(store.saveHeartbeat(store.loadHeartbeat()), false);
  } finally {
    cleanup();
  }
});

test('ownership merge: our changed tasks win, untouched tasks take the on-disk version, new tasks are appended', () => {
  const loaded = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }];
  const ours = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'complete' }, { id: 'c', status: 'pending' }];
  const theirs = [{ id: 'a', status: 'running', lease: { owner: 'other' } }, { id: 'b', status: 'pending' }, { id: 'd', status: 'pending' }];
  const merged = mergeTasksByOwnership(ours, theirs, JSON.stringify(loaded));
  assert.deepEqual(merged.map((t) => `${t.id}:${t.status}`), ['a:running', 'b:complete', 'd:pending', 'c:pending']);
});

test('saveTasks with a foreign write on disk merges instead of clobbering', () => {
  const { dir, store, events, cleanup } = fresh();
  try {
    store.ensureLayout();
    const file = store.loadTasks();
    file.tasks.push({ id: 'a', type: 'task', title: 'a', prompt: 'p', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', attempts: 0, maxAttempts: 3, dependsOn: [], history: [], priority: 'normal' });
    file.tasks.push({ id: 'b', type: 'task', title: 'b', prompt: 'p', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', attempts: 0, maxAttempts: 3, dependsOn: [], history: [], priority: 'normal' });
    store.saveTasks(file);

    // Two pulses load the same file.
    const pulseA = new StateStore({ stateDir: dir, now: () => new Date('2026-01-05T00:00:01.000Z') });
    const pulseB = new StateStore({ stateDir: dir, now: () => new Date('2026-01-05T00:00:02.000Z'), events: { append: (type, f) => events.push({ type, ...f }) } });
    const a = pulseA.loadTasks();
    const b = pulseB.loadTasks();
    const snapB = JSON.stringify(b.tasks);
    // A finishes task a and writes first.
    a.tasks[0].status = 'complete';
    pulseA.saveTasks(a, { loadedSnapshot: JSON.stringify(a.tasks) });
    // B only touched task b; its stale copy of a must not win.
    b.tasks[1].status = 'cancelled';
    pulseB.saveTasks(b, { loadedSnapshot: snapB });
    const final = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
    assert.deepEqual(final.tasks.map((t) => `${t.id}:${t.status}`), ['a:complete', 'b:cancelled']);
    assert.ok(events.some((e) => e.type === 'state.merged'));
  } finally {
    cleanup();
  }
});

test('archiveOldTasks moves old terminal tasks to a monthly archive and keeps the working set', () => {
  const { dir, store, cleanup } = fresh();
  try {
    const mk = (id, status, completedAt) => ({ id, type: 'task', title: id, prompt: 'p', status, createdAt: '2025-11-01T00:00:00.000Z', completedAt, attempts: 0, maxAttempts: 3, dependsOn: [], history: [], priority: 'normal' });
    const file = { version: 2, tasks: [] };
    for (let i = 0; i < 25; i += 1) file.tasks.push(mk(`old-${i}`, 'complete', '2025-11-02T00:00:00.000Z'));
    file.tasks.push(mk('recent', 'failed', '2026-01-04T00:00:00.000Z'));
    file.tasks.push(mk('live', 'pending', null));
    const archived = store.archiveOldTasks(file, { maxAgeDays: 30, keepMin: 2 });
    assert.equal(archived, 25);
    assert.deepEqual(file.tasks.map((t) => t.id), ['recent', 'live']);
    const lines = readFileSync(join(dir, 'archive', 'tasks-2025-11.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 25);
    assert.ok(existsSync(join(dir, 'archive')));
  } finally {
    cleanup();
  }
});
