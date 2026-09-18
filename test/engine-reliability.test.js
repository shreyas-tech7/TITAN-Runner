/**
 * Wave 3 end to end: the failure taxonomy, the retry policy, parking on a
 * provider-side fault, dead-lettering, the quota ledger, and the call
 * budgets — all through `runPulse()` with the fakes under the real stack.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPulse } from '../src/engine/pulse.js';
import { FakeProviderAgent } from '../src/fakes/fakeProvider.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { readEventsDir } from '../src/observability/events.js';
import { PARK_BACKOFF_MS } from '../src/reliability/retryPolicy.js';

const OWNER = { login: 'owner-login' };
const T0 = Date.parse('2026-04-01T09:00:00.000Z');
const at = (offsetMs) => () => new Date(T0 + offsetMs);

function issue(number, title, body) {
  return { number, title, body, user: OWNER, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }] };
}
const ONE_STEP = { reply: 'graph', graph: { sharedContext: 'ctx', tasks: [{ id: 'only', title: 'Only', aspect: 'code-generation', description: 'Do it.', dependsOn: [], estimatedComplexity: 'low', deliverable: 'src/only.js' }] } };
const ENVELOPE = { reply: 'envelope', files: [{ path: 'src/only.js', content: 'export const only = true;\n' }] };
function script(rules) {
  return {
    seed: 3,
    latencyMs: [1, 3],
    rules: [
      { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
      { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] },
      ...rules,
      { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] },
    ],
  };
}

function world({ issues, script: s }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'titan-reliability-'));
  const github = new FakeGitHub({ fixture: { issues }, repository: 'owner-login/repo' });
  const fake = new FakeProviderAgent({ script: s, quiet: true });
  const deps = (extra = {}) => ({ stateDir, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, now: at(0), ...extra });
  const tasks = () => JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8')).tasks;
  const task = (id = 'issue-1') => tasks().find((t) => t.id === id);
  const events = () => readEventsDir(join(stateDir, 'events'));
  const subtaskCalls = () => fake.history.filter((h) => h.kind === 'subtask').length;
  const checkpoint = (id = 'issue-1') => existsSync(join(stateDir, 'checkpoints', `${id}.json`));
  return { stateDir, github, fake, deps, tasks, task, events, subtaskCalls, checkpoint, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('a permanent error (401) on every provider is bounded: at most three calls, the task fails for good, the filer is told once', async () => {
  const w = world({ issues: [issue(1, 'Doomed', 'Every attempt is rejected upstream.')], script: script([
    { kind: 'decompose', sequence: [ONE_STEP] },
    { kind: 'subtask', sequence: [{ fault: 'unauthorized-401' }] },
  ]) });
  try {
    const summary = await runPulse(w.deps({ pulseId: 'p1' }));
    assert.equal(summary.tasksFailed, 1);
    const t = w.task();
    assert.equal(t.status, 'failed');
    assert.equal(t.failure.class, 'permanent');
    assert.ok(w.subtaskCalls() <= 3, `${w.subtaskCalls()} sub-task calls`);
    assert.equal(w.github.counts().commentOnIssue, 1);
    assert.equal(w.checkpoint(), false);
    const retries = w.events().filter((e) => e.type === 'step.retry');
    assert.ok(retries.every((e) => e.action === 'retry-next' || e.action === 'give-up'), 'a permanent error never retries the same model');
    assert.ok(w.events().some((e) => e.type === 'routing.decision' && e.outcome === 'failed' && e.failureClass === 'permanent'));
    assert.ok(existsSync(join(w.stateDir, 'quota.json')), 'the quota ledger was persisted');
    assert.ok(summary.modelCalls >= 2 && summary.upstreamCalls >= 2);
  } finally {
    w.cleanup();
  }
});

test('an exhausted quota parks the task: waiting(quota) with a wake time, no failure comment; it stays asleep until then and resumes from its checkpoint', async () => {
  const w = world({ issues: [issue(1, 'Quota', 'Provider reports the quota is gone.')], script: script([
    { kind: 'decompose', sequence: [ONE_STEP] },
    { kind: 'subtask', sequence: [{ fault: 'quota-402' }, { fault: 'quota-402' }, ENVELOPE] },
  ]) });
  try {
    const s1 = await runPulse(w.deps({ pulseId: 'p1', now: at(0) }));
    assert.equal(s1.tasksParked, 1);
    let t = w.task();
    assert.equal(t.status, 'waiting');
    assert.equal(t.waitReason, 'quota');
    assert.equal(t.parks, 1);
    assert.equal(Date.parse(t.wakeAt), T0 + PARK_BACKOFF_MS[0]);
    assert.equal(t.failure.class, 'budget_exhausted');
    assert.equal(w.subtaskCalls(), 2, 'one hop, then park: no sweep across every provider');
    assert.equal(w.github.counts().commentOnIssue ?? 0, 0, 'a parked task is not a failure to report');
    assert.ok(w.checkpoint(), 'checkpoint retained for the resume');
    assert.ok(w.events().some((e) => e.type === 'run.parked' && e.outcome === 'quota'));

    // Two minutes later: not yet time.
    const s2 = await runPulse(w.deps({ pulseId: 'p2', now: at(2 * 60_000) }));
    assert.equal(s2.tasksClaimed, 0);
    assert.equal(w.task().status, 'waiting');
    assert.equal(w.subtaskCalls(), 2, 'nothing was called while parked');

    // Six minutes later: woken, resumed without re-planning, finished.
    const s3 = await runPulse(w.deps({ pulseId: 'p3', now: at(6 * 60_000) }));
    assert.equal(s3.tasksCompleted, 1);
    t = w.task();
    assert.equal(t.status, 'complete');
    assert.equal(w.fake.history.filter((h) => h.kind === 'decompose').length, 1, 'planned once across three pulses');
    assert.equal(w.subtaskCalls(), 3);
    assert.equal(w.github.counts().commentOnIssue, 1);
    assert.equal(w.checkpoint(), false);
    assert.ok(t.usage.calls >= 4, `usage accumulated across pulses: ${JSON.stringify(t.usage)}`);
  } finally {
    w.cleanup();
  }
});

test('a provider outage during planning parks the task instead of degrading the plan to a single step', async () => {
  const w = world({ issues: [issue(1, 'Outage', 'Every provider is down while planning.')], script: script([
    { kind: 'decompose', sequence: [{ fault: 'http-503' }, { fault: 'http-503' }, { fault: 'http-503' }, ONE_STEP] },
    { kind: 'subtask', sequence: [ENVELOPE] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1', now: at(0) }));
    const t = w.task();
    assert.equal(t.status, 'waiting');
    assert.equal(t.waitReason, 'provider');
    assert.equal(w.fake.history.filter((h) => h.kind === 'decompose').length, 3, 'at most three providers per planning call');
    assert.equal(w.subtaskCalls(), 0, 'no step ran on a degraded plan');
    assert.ok(w.events().some((e) => e.type === 'plan.parked' && e.failureClass === 'provider_down'));
    const cp = JSON.parse(readFileSync(join(w.stateDir, 'checkpoints', 'issue-1.json'), 'utf8'));
    assert.equal(cp.graph, null, 'no plan was recorded');

    await runPulse(w.deps({ pulseId: 'p2', now: at(6 * 60_000) }));
    assert.equal(w.task().status, 'complete');
    assert.equal(w.fake.history.filter((h) => h.kind === 'decompose').length, 4);
  } finally {
    w.cleanup();
  }
});

test('a malformed answer is repaired: the same model is re-prompted with the repair hint and the step then succeeds', async () => {
  const w = world({ issues: [issue(1, 'Malformed', 'Broken JSON first.')], script: script([
    { kind: 'decompose', sequence: [ONE_STEP] },
    // Rule order matters: the repair prompt is recognised by its hint.
    { kind: 'subtask', promptIncludes: 'REPAIR:', sequence: [ENVELOPE] },
    { kind: 'subtask', sequence: [{ fault: 'malformed-json' }] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    assert.equal(w.task().status, 'complete');
    assert.equal(w.subtaskCalls(), 2);
    const retry = w.events().find((e) => e.type === 'step.retry');
    assert.deepEqual([retry.failureClass, retry.action], ['malformed_output', 'retry-same']);
  } finally {
    w.cleanup();
  }
});

test('the same failure recurring verbatim on the same model is poisoned and dead-lettered, not retried into a storm', async () => {
  const w = world({ issues: [issue(1, 'Stuck', 'Same odd failure every time.')], script: script([
    { kind: 'decompose', sequence: [ONE_STEP] },
    { kind: 'subtask', sequence: [{ fault: 'error', message: 'the same odd failure' }] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    const t = w.task();
    assert.equal(t.status, 'dead-lettered');
    assert.equal(t.failure.class, 'poisoned');
    assert.equal(t.failure.code, 'NO_PROGRESS');
    assert.equal(w.subtaskCalls(), 2);
    assert.equal(w.github.counts().commentOnIssue, 1, 'told once, via the dead-letter note');
    assert.equal(w.checkpoint(), false);
  } finally {
    w.cleanup();
  }
});

test('past the park ceiling a task is dead-lettered with one note instead of waiting forever', async () => {
  const w = world({ issues: [issue(1, 'Quota', 'Never comes back.')], script: script([
    { kind: 'decompose', sequence: [ONE_STEP] },
    { kind: 'subtask', sequence: [{ fault: 'quota-402' }] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1', limits: { maxParks: 0 } }));
    const t = w.task();
    assert.equal(t.status, 'dead-lettered');
    assert.equal(t.failure.code, 'PARK_CEILING');
    assert.equal(t.failure.class, 'budget_exhausted');
    assert.equal(w.github.counts().commentOnIssue, 1);
    assert.equal(w.checkpoint(), false);
  } finally {
    w.cleanup();
  }
});

test('a task that exceeds its model-call budget is dead-lettered at the next step boundary with its usage recorded', async () => {
  const w = world({ issues: [issue(1, 'Greedy', 'Two steps, one call allowed.')], script: script([
    { kind: 'decompose', sequence: [{ reply: 'graph', graph: { sharedContext: 'ctx', tasks: [
      { id: 'a', title: 'A', aspect: 'architecture', description: 'a', dependsOn: [], estimatedComplexity: 'low', deliverable: 'a' },
      { id: 'b', title: 'B', aspect: 'code-generation', description: 'b', dependsOn: ['a'], estimatedComplexity: 'low', deliverable: 'b' },
    ] } }] },
    { kind: 'subtask', sequence: [ENVELOPE] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1', limits: { taskMaxCalls: 1 } }));
    const t = w.task();
    assert.equal(t.status, 'dead-lettered');
    assert.equal(t.failure.code, 'TASK_BUDGET');
    assert.equal(t.failure.class, 'budget_exhausted');
    assert.ok(t.usage.calls >= 2, JSON.stringify(t.usage));
    assert.ok(w.subtaskCalls() <= 2, 'the budget stopped the run early');
    assert.equal(w.github.counts().commentOnIssue, 1);
    assert.equal(w.checkpoint(), false);
  } finally {
    w.cleanup();
  }
});

test('the pulse-level model-call ceiling drains the running task and claims nothing more; the next pulse finishes both', async () => {
  const w = world({ issues: [issue(1, 'First', 'first'), issue(2, 'Second', 'second')], script: script([
    { kind: 'decompose', sequence: [ONE_STEP] },
    { kind: 'subtask', sequence: [ENVELOPE] },
  ]) });
  try {
    const s1 = await runPulse(w.deps({ pulseId: 'p1', limits: { pulseMaxCalls: 1 } }));
    assert.equal(s1.tasksClaimed, 1);
    const by = Object.fromEntries(w.tasks().map((t) => [t.id, t]));
    assert.equal(by['issue-1'].status, 'waiting');
    assert.equal(by['issue-1'].waitReason, 'pulse-budget');
    assert.match(by['issue-1'].history.at(-1).reason, /model-call ceiling/);
    assert.equal(by['issue-2'].status, 'pending');
    assert.ok(w.events().some((e) => e.type === 'claim.skipped' && e.outcome === 'pulse-call-budget'));
    const finished = w.events().find((e) => e.type === 'pulse.finished');
    assert.ok(finished.calls >= 1 && Number.isInteger(finished.upstreamCalls));

    const s2 = await runPulse(w.deps({ pulseId: 'p2', now: at(60_000) }));
    assert.equal(s2.tasksCompleted, 2);
    assert.ok(w.tasks().every((t) => t.status === 'complete'));
  } finally {
    w.cleanup();
  }
});
