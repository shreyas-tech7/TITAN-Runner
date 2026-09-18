import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyControlAction, CONTROL_ACTIONS } from '../src/control/dispatch.js';
import { runControl } from '../src/control/cli.js';
import { StateStore, defaultControl } from '../src/state/store.js';
import { taskDefaults } from '../src/state/schema.js';

const NOW = () => new Date('2026-05-01T12:00:00.000Z');
function task(id, status, extra = {}) {
  return { ...taskDefaults(), id, type: 'task', title: id, prompt: 'p', status, createdAt: '2026-05-01T00:00:00.000Z', ...extra };
}
function world() {
  const events = [];
  return { events: { append: (type, data) => events.push({ type, ...data }) }, log: events, control: defaultControl(NOW()), tasksFile: { version: 2, tasks: [task('issue-1', 'pending'), task('issue-2', 'running'), task('issue-3', 'failed'), task('issue-4', 'waiting', { waitReason: 'approval', wakeAt: '2026-05-01T11:00:00.000Z' })] } };
}

test('switches: kill-switch, drain, and safe-mode take on/off, stamp who and why, and are audited', () => {
  const w = world();
  for (const action of ['kill-switch', 'drain', 'safe-mode']) {
    const on = applyControlAction({ action, argument: 'on', reason: 'incident', by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events });
    assert.ok(on.ok, on.message);
    assert.equal(on.outcome, `${action}-on`);
    w.control = on.control;
  }
  assert.deepEqual([w.control.killSwitch, w.control.drain, w.control.safeMode, w.control.updatedBy, w.control.reason], [true, true, true, 'owner-login', 'incident']);
  const again = applyControlAction({ action: 'drain', target: 'on', by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events });
  assert.equal(again.outcome, 'unchanged');
  const off = applyControlAction({ action: 'kill-switch', argument: 'off', by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events });
  assert.equal(off.control.killSwitch, false);
  const bad = applyControlAction({ action: 'drain', argument: 'maybe', by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events });
  assert.equal(bad.ok, false);
  assert.ok(w.log.every((e) => e.type === 'control.action' && e.audit === true && e.by === 'owner-login'));
});

test('autonomy takes only a known level; an unknown action or a missing actor is rejected and audited', () => {
  const w = world();
  const ok = applyControlAction({ action: 'autonomy', argument: 'propose', by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events });
  assert.deepEqual([ok.ok, ok.control.autonomy, ok.outcome], [true, 'propose', 'autonomy-propose']);
  const bad = applyControlAction({ action: 'autonomy', argument: 'yolo', by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events });
  assert.equal(bad.ok, false);
  assert.equal(applyControlAction({ action: 'explode', by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events }).outcome, 'rejected-unknown-action');
  assert.equal(applyControlAction({ action: 'drain', argument: 'on', by: '', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events }).outcome, 'rejected-no-actor');
  assert.equal(w.log.filter((e) => e.outcome.startsWith('rejected')).length, 3);
});

test('task actions reuse the /titan command semantics: cancel, pause, resume, retry, priority, approve, deny', () => {
  const w = world();
  const run = (action, target, argument) => applyControlAction({ action, target, argument, by: 'owner-login', control: w.control, tasksFile: w.tasksFile, now: NOW, events: w.events });
  const byId = (id) => w.tasksFile.tasks.find((t) => t.id === id);
  assert.equal(run('cancel', 'issue-1').outcome, 'cancelled');
  assert.equal(byId('issue-1').status, 'cancelled');
  assert.equal(run('cancel', 'issue-2').outcome, 'cancel-requested');
  assert.equal(byId('issue-2').cancelRequested, true);
  assert.equal(run('retry', 'issue-3').outcome, 'retried');
  assert.equal(byId('issue-3').status, 'pending');
  assert.equal(run('pause', 'issue-3').outcome, 'paused');
  assert.equal(run('resume', 'issue-3').outcome, 'resumed');
  assert.equal(run('priority', 'issue-3', 'urgent').outcome, 'priority-urgent');
  assert.equal(byId('issue-3').priority, 'urgent');
  assert.equal(run('priority', 'issue-3', 'silly').ok, false);
  assert.equal(run('approve', 'issue-4', 'tool:x:abcdef01').outcome, 'approval-recorded');
  assert.equal(byId('issue-4').status, 'pending', 'an approved waiting(approval) task wakes');
  assert.equal(byId('issue-4').approvals['tool:x:abcdef01'].by, 'owner-login');
  assert.equal(run('deny', 'issue-4').outcome, 'approval-recorded');
  assert.equal(byId('issue-4').approvals.all.decision, 'denied');
  assert.equal(run('retry', 'issue-9').outcome, 'rejected-no-such-task');
  assert.equal(run('retry').outcome, 'rejected-no-target');
  assert.ok(w.log.some((e) => e.taskId === 'issue-1' && e.outcome === 'cancelled' && e.audit));
  assert.deepEqual([...CONTROL_ACTIONS].sort(), ['approve', 'autonomy', 'cancel', 'deny', 'drain', 'kill-switch', 'pause', 'priority', 'resume', 'retry', 'safe-mode']);
});

test('the CLI applies an action to a state directory through the validated store and records the actor from the environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-control-'));
  try {
    const store = new StateStore({ stateDir: dir });
    store.ensureLayout();
    const file = store.loadTasks();
    file.tasks.push(task('issue-7', 'pending'));
    store.saveTasks(file);
    const r1 = runControl(['kill-switch', 'on', '--reason', 'stop everything'], { TITAN_STATE_DIR: dir, TITAN_CONTROL_ACTOR: 'dispatcher' });
    assert.ok(r1.ok, r1.message);
    const control = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'));
    assert.deepEqual([control.killSwitch, control.updatedBy, control.reason], [true, 'dispatcher', 'stop everything']);
    const r2 = runControl(['pause', 'issue-7'], { TITAN_STATE_DIR: dir, TITAN_CONTROL_ACTOR: 'dispatcher' });
    assert.ok(r2.ok, r2.message);
    assert.equal(JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).tasks[0].status, 'paused');
    const r3 = runControl(['autonomy', 'nope'], { TITAN_STATE_DIR: dir, TITAN_CONTROL_ACTOR: 'dispatcher' });
    assert.equal(r3.ok, false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')).autonomy, 'autonomous', 'a rejected action changes nothing');
    const events = readFileSync(join(dir, 'events', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    assert.ok(events.includes('"control.action"') && events.includes('"by":"dispatcher"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
