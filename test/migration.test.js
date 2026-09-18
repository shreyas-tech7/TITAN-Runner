/**
 * Migration and repair on real and legacy state: the repository's own
 * committed files load through the v2 store untouched, a v1 queue with
 * legacy tasks migrates without losing a field, and a file that fails its
 * schema is repaired rather than trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../src/state/store.js';
import { migrateTasks, TASKS_SCHEMA_VERSION, TASK_STATUSES } from '../src/state/schema.js';
import { check } from '../src/lib/validate.js';
import { SCHEMA_FILES } from '../src/state/schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the repository\'s own committed state/ loads through the v2 store with no repair and validates against the exported schemas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-migration-'));
  try {
    for (const f of ['tasks.json', 'heartbeat.json', 'providers.json', 'agents.json', 'pulse-history.json']) {
      if (existsSync(join(ROOT, 'state', f))) cpSync(join(ROOT, 'state', f), join(dir, f));
    }
    const store = new StateStore({ stateDir: dir });
    store.ensureLayout();
    const tasks = store.loadTasks();
    assert.equal(tasks.version, TASKS_SCHEMA_VERSION);
    assert.deepEqual(store.repairs, [], 'nothing needed repair');
    const heartbeat = store.loadHeartbeat();
    assert.ok(Number.isInteger(heartbeat.totalPulses));
    assert.ok(check(tasks, SCHEMA_FILES.tasks).ok);
    assert.ok(check(heartbeat, SCHEMA_FILES.heartbeat).ok);
    const control = store.loadControl();
    assert.ok(check(control, SCHEMA_FILES.control).ok, 'a default control file is written when none exists');
    assert.equal(control.autonomy, 'autonomous');
    assert.equal(control.killSwitch, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a v1 queue with every legacy status migrates forward: statuses unchanged, every field kept, defaults added, and it round-trips as v2', () => {
  const legacy = ['pending', 'running', 'complete', 'failed', 'blocked', 'cancelled', 'pr-open'];
  const v1 = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', tasks: legacy.map((status, i) => ({ id: `issue-${i}`, type: i % 2 ? 'self-improve' : 'task', issueNumber: i, issueUrl: `https://example.invalid/${i}`, title: `T${i}`, prompt: 'p', status, createdAt: '2026-01-01T00:00:00.000Z', claimedAt: null, startedAt: null, completedAt: null, runId: null, prNumber: null, prUrl: null, error: null, priority: i === 0 ? 'bogus' : 'high', routingHint: 'fast', customField: { kept: true } })) };
  const { file, migrated, from } = migrateTasks(v1);
  assert.deepEqual([migrated, from, file.version], [true, 1, 2]);
  assert.deepEqual(file.tasks.map((t) => t.status), legacy, 'legacy statuses map 1:1');
  assert.ok(file.tasks.every((t) => TASK_STATUSES.includes(t.status)));
  assert.equal(file.tasks[0].priority, 'normal', 'an unknown priority normalises');
  assert.equal(file.tasks[1].priority, 'high');
  assert.deepEqual(file.tasks[3].customField, { kept: true }, 'an unknown field is never deleted');
  assert.deepEqual([file.tasks[2].attempts, file.tasks[2].maxAttempts, file.tasks[2].dependsOn, file.tasks[2].history], [0, 3, [], []]);
  assert.equal(migrateTasks(file).migrated, false, 'v2 is a no-op');

  const dir = mkdtempSync(join(tmpdir(), 'titan-migration-'));
  try {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify(v1));
    const store = new StateStore({ stateDir: dir });
    store.ensureLayout();
    const loaded = store.loadTasks();
    assert.equal(loaded.version, 2);
    store.saveTasks(loaded);
    const onDisk = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.tasks.length, legacy.length);
    assert.ok(check(onDisk, SCHEMA_FILES.tasks).ok);
    assert.ok(existsSync(join(dir, 'backup', 'tasks.json')), 'the v1 file was backed up before the v2 write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a control file with an unknown autonomy level or a corrupt body is repaired to the previous good copy or the default, never trusted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-migration-'));
  try {
    mkdirSync(join(dir, 'backup'), { recursive: true });
    writeFileSync(join(dir, 'backup', 'control.json'), JSON.stringify({ version: 1, killSwitch: true, drain: false, safeMode: false, autonomy: 'propose', updatedAt: null, updatedBy: 'owner', reason: 'last good' }));
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ version: 1, killSwitch: false, drain: false, safeMode: false, autonomy: 'god-mode' }));
    const store = new StateStore({ stateDir: dir });
    store.ensureLayout();
    const control = store.loadControl();
    assert.equal(control.autonomy, 'propose', 'the backup, not the invalid file, wins');
    assert.equal(control.killSwitch, true);
    assert.ok(store.repairs.length >= 1);
    assert.ok(existsSync(join(dir, 'quarantine')), 'the bad bytes are kept for a human');

    rmSync(join(dir, 'backup'), { recursive: true, force: true });
    writeFileSync(join(dir, 'control.json'), '{ not json');
    const store2 = new StateStore({ stateDir: dir });
    store2.ensureLayout();
    const fallback = store2.loadControl();
    assert.equal(fallback.autonomy, 'autonomous', 'no backup: the safe default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
