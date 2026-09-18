import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPulse } from '../src/engine/pulse.js';
import { FakeProviderAgent, happyPathScript } from '../src/fakes/fakeProvider.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { StateStore } from '../src/state/store.js';
import { readEventsDir } from '../src/observability/events.js';

const OWNER = { login: 'owner-login' };
function issue(number, title, body, extra = {}) {
  return { number, title, body, user: OWNER, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }], ...extra };
}

function world({ issues = [], script = happyPathScript(), pulseId = 'p1', now } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'titan-engine-'));
  const github = new FakeGitHub({ fixture: { issues }, repository: 'owner-login/repo' });
  const fake = new FakeProviderAgent({ script, quiet: true });
  const deps = (extra = {}) => ({ stateDir, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, pulseId, now, ...extra });
  const tasks = () => JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8')).tasks;
  const events = () => readEventsDir(join(stateDir, 'events'));
  return { stateDir, github, fake, deps, tasks, events, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('happy path: an authorized issue becomes a task, runs through plan/execute/deliver, is commented on once and closed, with a full event trail and no leftover checkpoint or lease', async () => {
  const w = world({ issues: [issue(1, 'Build', 'Build the thing')] });
  try {
    const summary = await runPulse(w.deps());
    assert.equal(summary.error, null);
    assert.deepEqual([summary.tasksClaimed, summary.tasksCompleted], [1, 1]);
    const [t] = w.tasks();
    assert.equal(t.status, 'complete');
    assert.equal(t.lease, null);
    assert.equal(w.github.counts().commentOnIssue, 1);
    assert.equal(w.github.counts().closeIssue, 1);
    assert.equal(existsSync(join(w.stateDir, 'checkpoints', 'issue-1.json')), false);
    assert.equal(existsSync(join(w.stateDir, 'leases', 'issue-1.json')), false);
    const types = w.events().map((e) => e.type);
    for (const expected of ['pulse.started', 'intake.accepted', 'claim.acquired', 'gate.verdict', 'plan.finished', 'step.started', 'step.finished', 'run.finished', 'side-effect.fired', 'task.transition', 'pulse.finished']) {
      assert.ok(types.includes(expected), `missing event ${expected}`);
    }
    assert.ok(readFileSync(join(w.stateDir, 'control.json'), 'utf8').includes('"killSwitch": false'));
  } finally {
    w.cleanup();
  }
});

test('resume: a checkpoint with finished steps is continued, not re-run — the second pulse executes only the remaining step', async () => {
  const w = world({ issues: [issue(1, 'Long', 'Two steps')] });
  try {
    // Pulse 1 with a budget so small the scheduler drains after the first step.
    const s1 = await runPulse(w.deps({ pulseId: 'p1', budgetMs: 60, leaseTtlMs: 50 }));
    assert.equal(s1.tasksParked + s1.tasksCompleted, 1);
    const callsAfter1 = w.fake.calls;
    const t1 = w.tasks()[0];
    if (t1.status === 'waiting') {
      assert.equal(t1.waitReason, 'pulse-budget');
      assert.ok(existsSync(join(w.stateDir, 'checkpoints', 'issue-1.json')), 'checkpoint retained');
      const cp = JSON.parse(readFileSync(join(w.stateDir, 'checkpoints', 'issue-1.json'), 'utf8'));
      assert.ok(cp.graph, 'plan checkpointed');
      const done = Object.values(cp.subtasks).filter((s) => s.state === 'complete').length;
      // Pulse 2: plenty of budget; must not re-plan and must not re-run finished steps.
      await new Promise((r) => setTimeout(r, 60));
      const s2 = await runPulse(w.deps({ pulseId: 'p2', budgetMs: 60_000 }));
      assert.equal(s2.tasksCompleted, 1);
      const subtaskCalls = w.fake.history.filter((h) => h.kind === 'subtask').length;
      const decompositions = w.fake.history.filter((h) => h.kind === 'decompose').length;
      assert.equal(decompositions, 1, 'planned exactly once across both pulses');
      assert.equal(subtaskCalls, 2, `each step ran once (${done} restored)`);
      assert.ok(w.fake.calls > callsAfter1);
    }
    assert.equal(w.tasks()[0].status, 'complete');
    assert.equal(w.github.counts().commentOnIssue, 1);
  } finally {
    w.cleanup();
  }
});

test('a zombie from a dead pulse (running, expired lease) is reclaimed and finished by the next pulse', async () => {
  const w = world({ issues: [issue(3, 'Zombie', 'Finish me')] });
  try {
    const store = new StateStore({ stateDir: w.stateDir });
    store.ensureLayout();
    const file = store.loadTasks();
    file.tasks.push({ id: 'issue-3', type: 'task', issueNumber: 3, issueUrl: 'x', title: 'Zombie', prompt: 'Finish me', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', claimedAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', attempts: 0, maxAttempts: 3, dependsOn: [], history: [], priority: 'normal', lease: { owner: 'dead-pulse', acquiredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:20:00.000Z' } });
    store.saveTasks(file);
    const summary = await runPulse(w.deps());
    assert.equal(summary.tasksCompleted, 1);
    const t = w.tasks()[0];
    assert.equal(t.status, 'complete');
    assert.equal(t.attempts, 1, 'the dead attempt was counted');
    assert.ok(w.events().some((e) => e.type === 'reconcile.finished' && e.reclaimed === 1));
  } finally {
    w.cleanup();
  }
});

test('kill switch: the pulse reconciles and heartbeats but claims nothing and calls no model', async () => {
  const w = world({ issues: [issue(1, 'Build', 'Build the thing')] });
  try {
    const store = new StateStore({ stateDir: w.stateDir });
    store.ensureLayout();
    store.saveControl({ ...store.loadControl(), killSwitch: true, updatedBy: 'owner-login', reason: 'test' });
    const summary = await runPulse(w.deps());
    assert.equal(summary.tasksClaimed, 0);
    assert.equal(w.fake.calls, 0);
    assert.equal(w.github.counts().listOpenTaskIssues ?? 0, 0, 'no intake either');
    assert.ok(w.events().some((e) => e.type === 'pulse.halted' && e.audit === true));
    assert.ok(existsSync(join(w.stateDir, 'heartbeat.json')));
  } finally {
    w.cleanup();
  }
});

test('drain control: intake still happens but nothing is claimed', async () => {
  const w = world({ issues: [issue(1, 'Build', 'Build the thing')] });
  try {
    const store = new StateStore({ stateDir: w.stateDir });
    store.ensureLayout();
    store.saveControl({ ...store.loadControl(), drain: true });
    const summary = await runPulse(w.deps());
    assert.equal(summary.tasksClaimed, 0);
    assert.equal(w.tasks().length, 1);
    assert.equal(w.tasks()[0].status, 'pending');
    assert.equal(w.fake.calls, 0);
  } finally {
    w.cleanup();
  }
});

test('duplicate submission: the second identical issue is cancelled as a duplicate, answered once, and never orchestrated', async () => {
  const w = world({ issues: [issue(1, 'Same', 'Build the widget'), issue(2, 'Same', 'Build the widget')] });
  try {
    await runPulse(w.deps());
    const by = Object.fromEntries(w.tasks().map((t) => [t.id, t]));
    assert.equal(by['issue-1'].status, 'complete');
    assert.equal(by['issue-2'].status, 'cancelled');
    assert.equal(by['issue-2'].duplicateOf, 'issue-1');
    assert.equal(w.fake.history.filter((h) => h.kind === 'decompose').length, 1);
    const dupComments = w.github.calls.filter((c) => c.op === 'commentOnIssue' && c.args.number === 2);
    assert.equal(dupComments.length, 1);
    assert.match(dupComments[0].args.body, /duplicate of issue-1/);
  } finally {
    w.cleanup();
  }
});

test('task dependencies: the consumer waits until the producer completes and then runs on a later pulse', async () => {
  const consumerBody = '<!-- titan-task-v1\ntitle: Consumer\ndescription: |\n  Consume it.\ndependsOn: issue-1\n-->';
  const w = world({ issues: [issue(2, 'Consumer', consumerBody), issue(1, 'Producer', 'Produce it')] });
  try {
    const s1 = await runPulse(w.deps({ pulseId: 'p1' }));
    const after1 = Object.fromEntries(w.tasks().map((t) => [t.id, t.status]));
    assert.equal(after1['issue-1'], 'complete');
    assert.ok(['waiting', 'complete'].includes(after1['issue-2']), JSON.stringify(after1));
    if (after1['issue-2'] === 'waiting') {
      const s2 = await runPulse(w.deps({ pulseId: 'p2' }));
      assert.equal(s2.tasksCompleted, 1);
    }
    assert.equal(w.tasks().find((t) => t.id === 'issue-2').status, 'complete');
    const order = w.events().filter((e) => e.type === 'task.transition' && e.to === 'running').map((e) => e.taskId);
    assert.deepEqual(order, ['issue-1', 'issue-2'], 'producer ran before consumer');
    assert.ok(s1.tasksClaimed >= 1);
  } finally {
    w.cleanup();
  }
});

test('an authorized /titan cancel comment cancels a pending task; a stranger\'s does not', async () => {
  const w = world({ issues: [] });
  try {
    const store = new StateStore({ stateDir: w.stateDir });
    store.ensureLayout();
    store.saveControl({ ...store.loadControl(), drain: true }); // keep the task pending across the pulse
    w.github.data.issues.push(
      { ...issue(1, 'A', 'a'), state: 'open', comments: [{ id: 1, body: '/titan cancel', created_at: '2026-01-02T00:00:00.000Z', user: { login: 'random' }, author_association: 'NONE' }], updated_at: '2026-01-02T00:00:00.000Z' },
      { ...issue(2, 'B', 'b'), state: 'open', comments: [{ id: 1, body: '/titan cancel', created_at: '2026-01-02T00:00:00.000Z', user: OWNER, author_association: 'OWNER' }], updated_at: '2026-01-02T00:00:00.000Z' },
    );
    await runPulse(w.deps({ pulseId: 'p1' }));
    // Intake stamps issueUpdatedAtSeen = updated_at, so bump the issues to make the comments "new".
    for (const i of w.github.data.issues) i.updated_at = '2026-01-03T00:00:00.000Z';
    await runPulse(w.deps({ pulseId: 'p2' }));
    const by = Object.fromEntries(w.tasks().map((t) => [t.id, t.status]));
    assert.equal(by['issue-1'], 'pending');
    assert.equal(by['issue-2'], 'cancelled');
    assert.ok(w.events().some((e) => e.type === 'control.command' && e.verb === 'cancel' && e.by === 'owner-login' && e.audit));
    assert.ok(w.events().some((e) => e.type === 'control.rejected'));
  } finally {
    w.cleanup();
  }
});
