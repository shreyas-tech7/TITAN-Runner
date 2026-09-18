/**
 * Chaos: seeded random provider faults over several pulses, in process,
 * and the invariants that must hold whatever happened:
 *   - every task is in a schema status; none is left `running`;
 *   - no lease file without a running task; no checkpoint for a terminal task;
 *   - at most one completion comment and one close per issue;
 *   - the event log's seq is continuous and every event validates;
 *   - every state file validates against its schema;
 *   - calls per task stay under the ceiling (no retry storm).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPulse } from '../src/engine/pulse.js';
import { FakeProviderAgent } from '../src/fakes/fakeProvider.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { readEventsDir } from '../src/observability/events.js';
import { mulberry32 } from '../src/fakes/rng.js';
import { check } from '../src/lib/validate.js';
import { SCHEMA_FILES, TASK_STATUSES } from '../src/state/schema.js';

const OWNER = { login: 'owner-login' };
const FAULTS = ['http-503', 'http-500', 'http-429', 'quota-402', 'malformed-json', 'truncated', 'empty', 'refusal', 'error', 'dropped-connection', 'unauthorized-401'];
const T0 = Date.parse('2026-06-01T08:00:00.000Z');

function randomScript(rng, taskCount) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const steps = rng() < 0.5 ? [{ id: 'only', aspect: 'code-generation', dependsOn: [] }] : [{ id: 'a', aspect: 'architecture', dependsOn: [] }, { id: 'b', aspect: 'code-generation', dependsOn: ['a'] }];
  const graph = { reply: 'graph', graph: { sharedContext: 'chaos', tasks: steps.map((s) => ({ ...s, title: s.id, description: s.id, estimatedComplexity: 'low', deliverable: `src/${s.id}.js` })) } };
  const sequence = () => {
    const seq = [];
    const faults = Math.floor(rng() * 3);
    for (let i = 0; i < faults; i += 1) {
      const fault = pick(FAULTS);
      seq.push(fault === 'http-429' ? { fault, retryAfterMs: 100 } : { fault });
    }
    seq.push({ reply: 'envelope', files: [{ path: 'src/out.js', content: 'export const out = 1;\n' }] });
    return seq;
  };
  return {
    seed: Math.floor(rng() * 1e6), latencyMs: [1, 2],
    rules: [
      { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
      { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] },
      { kind: 'decompose', sequence: [...(rng() < 0.3 ? [{ fault: pick(['http-503', 'malformed-json']) }] : []), graph] },
      ...Array.from({ length: taskCount }, (_, i) => ({ kind: 'subtask', promptIncludes: `chaos task ${i + 1}`, sequence: sequence() })),
      { kind: 'subtask', sequence: sequence() },
      { kind: 'judge', sequence: [{ reply: 'raw', text: rng() < 0.2 ? '{"verdict":"fail","reason":"chaos","issues":[]}' : '{"verdict":"pass","reason":"ok","issues":[]}' }] },
      { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] },
    ],
  };
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`chaos seed ${seed}: three pulses of random faults leave consistent state`, async () => {
    const rng = mulberry32(seed);
    const stateDir = mkdtempSync(join(tmpdir(), 'titan-chaos-'));
    const taskCount = 2;
    const issues = Array.from({ length: taskCount }, (_, i) => ({ number: i + 1, title: `chaos task ${i + 1}`, body: `Do chaos task ${i + 1}.`, user: OWNER, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }], state: 'open', comments: [] }));
    const github = new FakeGitHub({ fixture: { issues }, repository: 'owner-login/repo', now: () => new Date(T0) });
    let totalCalls = 0;
    try {
      for (let p = 1; p <= 3; p += 1) {
        const fake = new FakeProviderAgent({ script: randomScript(rng, taskCount), quiet: true, pulseIndex: p });
        const now = () => new Date(T0 + (p - 1) * 15 * 60_000);
        const summary = await runPulse({ stateDir, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, pulseId: `chaos-${seed}-${p}`, now, leaseTtlMs: 60_000 });
        assert.equal(summary.error, null, `pulse ${p} errored: ${summary.error}`);
        totalCalls += fake.calls;
      }
      const tasksFile = JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8'));
      assert.ok(check(tasksFile, SCHEMA_FILES.tasks).ok, 'tasks.json validates');
      for (const t of tasksFile.tasks) {
        assert.ok(TASK_STATUSES.includes(t.status), t.status);
        assert.notEqual(t.status, 'running', `${t.id} left running after the pulse ended`);
        assert.equal(t.lease, null, `${t.id} keeps a lease while ${t.status}`);
        const terminal = ['complete', 'failed', 'blocked', 'cancelled', 'expired', 'dead-lettered'].includes(t.status);
        const hasCp = existsSync(join(stateDir, 'checkpoints', `${t.id}.json`));
        if (terminal) assert.equal(hasCp, false, `${t.id} is ${t.status} but still has a checkpoint`);
        if (t.status === 'waiting') assert.ok(t.wakeAt && t.waitReason, `${t.id} waits without a reason/wake time`);
        assert.ok((t.usage?.calls ?? 0) <= 40, `${t.id} used ${t.usage?.calls} calls`);
      }
      const leases = existsSync(join(stateDir, 'leases')) ? readdirSync(join(stateDir, 'leases')).filter((f) => f.endsWith('.json')) : [];
      assert.deepEqual(leases, [], 'no lease left behind');
      for (const issue of github.data.issues) {
        assert.ok(issue.comments.filter((c) => /finished this task/.test(c.body)).length <= 1, `issue ${issue.number} got more than one completion comment`);
        const task = tasksFile.tasks.find((t) => t.issueNumber === issue.number);
        if (issue.state === 'closed') assert.equal(task.status, 'complete', 'only a complete task closes its issue');
      }
      assert.equal(github.counts().closeIssue ?? 0, tasksFile.tasks.filter((t) => t.status === 'complete').length);
      const events = readEventsDir(join(stateDir, 'events'));
      assert.ok(events.length > 0);
      let last = 0;
      for (const e of events) {
        assert.ok(check(e, SCHEMA_FILES.event).ok, `event ${e.type} #${e.seq} does not validate`);
        assert.equal(e.seq, last + 1, `seq gap at ${e.seq}`);
        last = e.seq;
      }
      if (existsSync(join(stateDir, 'quota.json'))) assert.ok(check(JSON.parse(readFileSync(join(stateDir, 'quota.json'), 'utf8')), SCHEMA_FILES.quota).ok);
      assert.ok(totalCalls <= 3 * taskCount * 14 + 3 * 8, `${totalCalls} calls in three pulses is a storm`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}
