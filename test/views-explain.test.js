import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQueueView, buildAnalyticsView, buildProvidersView, writeViews } from '../src/observability/views.js';
import { explainTask, replayTask, summarizeEvent } from '../src/observability/explain.js';
import { StateStore } from '../src/state/store.js';
import { ProviderHealthStore } from '../src/providers/health.js';
import { QuotaLedger } from '../src/reliability/quota.js';
import { taskDefaults } from '../src/state/schema.js';

const NOW = () => new Date('2026-05-01T12:00:00.000Z');
const t = (id, status, extra = {}) => ({ ...taskDefaults(), id, type: 'task', title: `T ${id}`, prompt: 'p', status, createdAt: '2026-05-01T10:00:00.000Z', ...extra });
const ev = (type, extra = {}) => ({ seq: 1, ts: '2026-05-01T11:00:00.000Z', pulseId: 'p', type, ...extra });

test('queue view: counts by status and wait reason, the next wake, the oldest pending, approvals and dead-letters', () => {
  const tasks = [
    t('a', 'pending', { createdAt: '2026-05-01T09:00:00.000Z' }), t('b', 'pending'),
    t('c', 'waiting', { waitReason: 'quota', wakeAt: '2026-05-01T12:30:00.000Z' }),
    t('d', 'waiting', { waitReason: 'provider', wakeAt: '2026-05-01T12:10:00.000Z' }),
    t('e', 'waiting', { waitReason: 'approval', wakeAt: '2026-05-01T11:00:00.000Z', issueNumber: 5 }),
    t('f', 'running', { claimedAt: '2026-05-01T11:59:00.000Z', lease: { owner: 'run-1', acquiredAt: '2026-05-01T11:59:00.000Z', expiresAt: '2026-05-01T12:04:00.000Z' } }),
    t('g', 'dead-lettered', { failure: { class: 'poisoned', code: 'NO_PROGRESS', message: 'x', at: '2026-05-01T11:30:00.000Z' }, completedAt: '2026-05-01T11:30:00.000Z' }),
    t('h', 'complete'),
  ];
  const v = buildQueueView({ tasks }, { now: NOW });
  assert.equal(v.total, 8);
  assert.deepEqual(v.byStatus, { pending: 2, waiting: 3, running: 1, 'dead-lettered': 1, complete: 1 });
  assert.deepEqual(v.byWaitReason, { quota: 1, provider: 1, approval: 1 });
  assert.equal(v.active, 6);
  assert.deepEqual(v.nextWake, { id: 'd', wakeAt: '2026-05-01T12:10:00.000Z', waitReason: 'provider' });
  assert.deepEqual([v.oldestPending.id, v.oldestPending.ageMinutes], ['a', 180]);
  assert.deepEqual(v.approvalsPending.map((x) => x.id), ['e']);
  assert.deepEqual(v.deadLettered, [{ id: 'g', title: 'T g', code: 'NO_PROGRESS', class: 'poisoned', at: '2026-05-01T11:30:00.000Z' }]);
  assert.deepEqual(v.running[0].lease, 'run-1');
});

test('analytics view: outcomes, retries by class, parks, loops, verification, tools, policy, cost, pulse percentiles', () => {
  const events = [
    ev('pulse.finished', { durationMs: 100, calls: 4, upstreamCalls: 6, tokens: 500 }),
    ev('pulse.finished', { durationMs: 300, calls: 2, upstreamCalls: 2, tokens: 100 }),
    ev('pulse.finished', { durationMs: 900, calls: 0, upstreamCalls: 0, tokens: 0 }),
    ev('task.transition', { taskId: 'a', to: 'complete', activeMs: 4000 }),
    ev('task.transition', { taskId: 'b', to: 'dead-lettered', failureClass: 'poisoned' }),
    ev('task.transition', { taskId: 'c', to: 'waiting', waitReason: 'quota' }),
    ev('task.transition', { taskId: 'c', to: 'waiting', waitReason: 'approval' }),
    ev('task.transition', { taskId: 'c', to: 'failed' }),
    ev('step.retry', { failureClass: 'rate_limited' }), ev('step.retry', { failureClass: 'rate_limited' }), ev('step.retry', { failureClass: 'permanent' }),
    ev('step.attempt-failed', { code: 'LOOP_DETECTED' }),
    ev('tool.call', { outcome: 'ok' }), ev('tool.call', { outcome: 'TOOL_DENIED' }),
    ev('verify.finished', { outcome: 'pass', unjudged: true }), ev('verify.finished', { outcome: 'fail', unjudged: false }), ev('verify.finished', { outcome: 'pass', unjudged: false }),
    ev('remediate.started', {}),
    ev('policy.decision', { outcome: 'approve' }), ev('policy.decision', { outcome: 'deny' }), ev('policy.decision', { outcome: 'allow' }),
    ev('run.finished', { taskId: 'a', calls: 3 }), ev('run.finished', { taskId: 'c', calls: 5 }),
  ];
  const v = buildAnalyticsView(events, { now: NOW, archive: [{ date: '2026-04-01', events: 50, calls: 12 }] });
  assert.deepEqual([v.tasks.finished, v.tasks.succeeded, v.tasks.successRate], [3, 1, 0.333]);
  assert.deepEqual(v.tasks.deadLetteredByClass, { poisoned: 1 });
  assert.deepEqual(v.reliability, { retriesByClass: { rate_limited: 2, permanent: 1 }, parks: 1, loops: 1, remediations: 1 });
  assert.deepEqual(v.verification, { runs: 3, passRate: 0.667, unjudged: 1 });
  assert.deepEqual(v.tools, { calls: 2, denied: 1 });
  assert.deepEqual(v.policy, { approvalsRequested: 1, denials: 1 });
  assert.deepEqual(v.cost, { modelCalls: 6, upstreamCalls: 8, tokens: 600, callsPerCompletedTask: 4, callsPerPulse: 2 });
  assert.deepEqual(v.pulses, { count: 3, p50Ms: 300, p95Ms: 900, maxMs: 900 });
  assert.deepEqual(v.window.archived, { days: 1, events: 50, calls: 12 });
  const empty = buildAnalyticsView([], { now: NOW });
  assert.deepEqual([empty.tasks.successRate, empty.pulses.p50Ms, empty.cost.callsPerPulse], [null, null, null]);
});

test('providers view carries the breaker, the explain line, and quota use; writeViews writes all three files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-views-'));
  try {
    const health = new ProviderHealthStore(join(dir, 'providers.json'));
    health.markConfigured('groq');
    health.recordOutcome('groq', { ok: false, status: 429, code: 'RATE_LIMITED', retryAfterMs: 60_000 });
    health.markNotConfigured('together');
    const quota = new QuotaLedger({ env: {} });
    quota.record('groq', { tokens: 10 });
    const v = buildProvidersView({ health, ids: ['groq', 'together'], quota, now: NOW });
    assert.equal(v.providers.groq.breaker, 'open');
    assert.match(v.providers.groq.explain, /groq: breaker open/);
    assert.equal(v.providers.groq.quota.usedDay, 1);
    assert.equal(v.providers.together.breaker, 'disabled');

    const store = new StateStore({ stateDir: dir, now: NOW });
    store.ensureLayout();
    mkdirSync(join(dir, 'events'), { recursive: true });
    writeFileSync(join(dir, 'events', '2026-05-01.jsonl'), `${JSON.stringify(ev('pulse.finished', { durationMs: 50, calls: 1 }))}\n`);
    const idleQueue = { tasks: [t('x', 'complete', { completedAt: '2026-05-01T11:00:00.000Z' })] };
    const out = writeViews({ store, tasksFile: idleQueue, health, providerIds: ['groq'], quota, now: NOW });
    for (const name of ['queue', 'analytics', 'providers']) {
      assert.ok(existsSync(join(dir, 'views', `${name}.json`)), name);
      assert.equal(JSON.parse(readFileSync(join(dir, 'views', `${name}.json`), 'utf8')).version, 1);
    }
    assert.equal(out.queue.total, 1);
    assert.equal(out.analytics.pulses.count, 1);
    // An idle rebuild fifteen minutes later (nothing changed but the clock)
    // must not rewrite the files: three files of churn per idle pulse add up.
    const before = Object.fromEntries(['queue', 'analytics', 'providers'].map((n) => [n, readFileSync(join(dir, 'views', `${n}.json`), 'utf8')]));
    writeViews({ store, tasksFile: idleQueue, health, providerIds: ['groq'], quota, now: () => new Date('2026-05-01T12:15:00.000Z') });
    for (const n of ['queue', 'analytics', 'providers']) assert.equal(readFileSync(join(dir, 'views', `${n}.json`), 'utf8'), before[n], `${n}.json rewritten for a timestamp`);
    assert.equal(store.written.has(join(dir, 'views', 'queue.json')), true, 'the first write was recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explain: a waiting task says what it waits on and how to unblock it; replay lists its trail in order', () => {
  const events = [
    ev('task.transition', { seq: 3, taskId: 'issue-1', from: 'pending', to: 'running', reason: 'claimed' }),
    ev('policy.decision', { seq: 5, taskId: 'issue-1', action: 'tool:workspace_write', outcome: 'approve', approvalKey: 'tool:workspace_write:abcd1234' }),
    ev('run.parked', { seq: 6, taskId: 'issue-1', outcome: 'approval', approvalKey: 'tool:workspace_write:abcd1234' }),
    ev('task.transition', { seq: 7, taskId: 'issue-1', from: 'running', to: 'waiting', waitReason: 'approval' }),
    ev('pulse.finished', { seq: 8 }),
    ev('task.transition', { seq: 2, taskId: 'issue-2', to: 'complete', ts: '2026-05-01T10:00:00.000Z' }),
  ];
  const waiting = t('issue-1', 'waiting', { waitReason: 'approval', wakeAt: '2026-05-01T11:00:00.000Z', usage: { calls: 3, tokens: 400, wallMs: 12_000 }, history: [{ at: '2026-05-01T11:00:00.000Z', from: 'running', to: 'waiting', reason: 'waiting for approval' }] });
  const x = explainTask({ task: waiting, checkpoint: { phase: 'executing', runId: 'r1', subtasks: { look: { state: 'pending' } }, remediations: 0, gate: { verdict: 'allow', classification: 'caution', layer: 2 } }, events, control: { autonomy: 'approval' }, now: NOW });
  assert.equal(x.found, true);
  assert.match(x.headline, /approval of tool:workspace_write:abcd1234/);
  assert.match(x.unblock, /\/titan approve tool:workspace_write:abcd1234/);
  assert.ok(x.facts.some((f) => /3 model calls, 400 tokens, 12 s active/.test(f)));
  assert.ok(x.facts.some((f) => /gate: allow/.test(f)));
  assert.ok(x.facts.some((f) => /control: autonomy approval/.test(f)));
  assert.equal(x.lastEvents.length, 4, 'only this task\'s events');
  const r = replayTask('issue-1', events);
  assert.equal(r.count, 4);
  assert.deepEqual(r.events.map((e) => e.seq), [3, 5, 6, 7]);
  assert.match(r.lines[1], /policy\.decision .*outcome=approve/);

  const parked = explainTask({ task: t('p', 'waiting', { waitReason: 'quota', wakeAt: '2026-05-01T12:20:00.000Z', parks: 2 }), events: [], now: NOW });
  assert.match(parked.waitingOn, /quota.*in 20 min/);
  const dlq = explainTask({ task: t('d', 'dead-lettered', { failure: { class: 'poisoned', code: 'NO_PROGRESS', message: 'm', at: 'x' } }), events: [], now: NOW });
  assert.match(dlq.headline, /NO_PROGRESS/);
  assert.match(dlq.unblock, /titan retry/);
  const queued = explainTask({ task: t('q', 'pending'), events: [], control: { autonomy: 'autonomous', killSwitch: true }, now: NOW });
  assert.match(queued.waitingOn, /kill switch/);
  assert.equal(explainTask({ task: null }).found, false);
  assert.match(summarizeEvent(ev('x.y', { stepId: 's', outcome: 'ok' })), /x\.y stepId=s outcome=ok/);
});
