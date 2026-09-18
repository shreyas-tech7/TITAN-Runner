/**
 * Wave 4 end to end through `runPulse()`: tool calls inside a step (jailed,
 * policy-gated, loop-detected), the approval flow, autonomy levels on
 * delivery, and verification with an independent judge and bounded
 * remediation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPulse } from '../src/engine/pulse.js';
import { FakeProviderAgent } from '../src/fakes/fakeProvider.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { StateStore } from '../src/state/store.js';
import { readEventsDir } from '../src/observability/events.js';

const OWNER = { login: 'owner-login' };
function issue(number, title, body, extra = {}) {
  return { number, title, body, user: OWNER, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }], state: 'open', comments: [], ...extra };
}
const ONE_CODE_STEP = { reply: 'graph', graph: { sharedContext: 'ctx', tasks: [{ id: 'only', title: 'Only', aspect: 'code-generation', description: 'Do it.', dependsOn: [], estimatedComplexity: 'low', deliverable: 'src/only.js' }] } };
const ONE_RESEARCH_STEP = { reply: 'graph', graph: { sharedContext: 'ctx', tasks: [{ id: 'look', title: 'Look', aspect: 'research', description: 'Read the readme and summarise it.', dependsOn: [], estimatedComplexity: 'low', deliverable: 'a summary' }] } };
const ENVELOPE = { reply: 'envelope', files: [{ path: 'src/only.js', content: 'export const only = true;\n' }] };
const JUDGE_PASS = { kind: 'judge', sequence: [{ reply: 'raw', text: '{"verdict":"pass","reason":"meets the criteria","issues":[]}' }] };
function script(rules, { judge = JUDGE_PASS } = {}) {
  return {
    seed: 5,
    latencyMs: [1, 3],
    rules: [
      { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
      { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation","research"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] },
      ...rules,
      judge,
      { kind: '*', sequence: [{ reply: 'prose', text: 'Done with the step.' }] },
    ],
  };
}

function world({ issues, script: s, control = null }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'titan-autonomy-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'titan-repo-'));
  mkdirSync(join(repoRoot, 'src'));
  writeFileSync(join(repoRoot, 'README.md'), '# Fixture repo\nThe readme says: the answer is forty-two.\n');
  writeFileSync(join(repoRoot, 'src', 'a.js'), 'export const a = 1;\n');
  // The fake GitHub shares the pulse's fixed clock, so an engine comment's
  // `updated_at` sits before the comments the test adds "later".
  const github = new FakeGitHub({ fixture: { issues }, repository: 'owner-login/repo', now: () => new Date('2026-04-01T09:00:00.000Z') });
  const fake = new FakeProviderAgent({ script: s, quiet: true });
  if (control) {
    const store = new StateStore({ stateDir });
    store.ensureLayout();
    store.saveControl({ ...store.loadControl(), ...control });
  }
  const deps = (extra = {}) => ({ stateDir, repoRoot, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, now: () => new Date('2026-04-01T09:00:00.000Z'), ...extra });
  const tasks = () => JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8')).tasks;
  const task = (id = 'issue-1') => tasks().find((t) => t.id === id);
  const events = () => readEventsDir(join(stateDir, 'events'));
  const calls = (kind) => fake.history.filter((h) => h.kind === kind);
  const checkpoint = (id = 'issue-1') => existsSync(join(stateDir, 'checkpoints', `${id}.json`));
  return { stateDir, repoRoot, github, fake, deps, tasks, task, events, calls, checkpoint, cleanup: () => { rmSync(stateDir, { recursive: true, force: true }); rmSync(repoRoot, { recursive: true, force: true }); } };
}

test('a research step can read the checkout through a tool, then answer; the tool result reached the prompt and the run is verified by an independent judge', async () => {
  const w = world({ issues: [issue(1, 'Research', 'What does the readme say?')], script: script([
    { kind: 'decompose', sequence: [ONE_RESEARCH_STEP] },
    // The second subtask prompt carries the tool result; the model then answers.
    { kind: 'subtask', promptIncludes: 'forty-two', sequence: [{ reply: 'prose', text: 'The readme says the answer is forty-two.' }] },
    { kind: 'subtask', sequence: [{ reply: 'tool', tool: 'repo_read_file', args: { path: 'README.md' } }] },
  ]) });
  try {
    const summary = await runPulse(w.deps({ pulseId: 'p1' }));
    assert.equal(summary.tasksCompleted, 1, JSON.stringify(w.task()?.failure));
    assert.equal(w.task().status, 'complete');
    assert.equal(w.calls('subtask').length, 2, 'one tool round, one answer');
    const toolEvents = w.events().filter((e) => e.type === 'tool.call');
    assert.equal(toolEvents.length, 1);
    assert.deepEqual([toolEvents[0].tool, toolEvents[0].outcome, toolEvents[0].effect], ['repo_read_file', 'ok', 'read']);
    assert.ok(w.events().some((e) => e.type === 'step.tool-round' && e.round === 1));
    // Verification: judged by a provider that produced no step.
    const producers = new Set(w.calls('subtask').map((c) => c.modelId).concat(w.calls('decompose').map((c) => c.modelId)));
    const judged = w.calls('judge');
    assert.equal(judged.length, 1, 'exactly one judge call');
    assert.ok(!producers.has(judged[0].modelId), `judge ${judged[0].modelId} must differ from producers ${[...producers]}`);
    const verified = w.events().find((e) => e.type === 'verify.finished');
    assert.deepEqual([verified.outcome, verified.layer, verified.unjudged], ['pass', 'judge', false]);
    assert.match(w.task().history.at(-1).reason, /verified/);
    assert.ok(w.github.data.issues[0].comments.some((c) => c.body.includes('Verification')), 'the issue comment reports the verification');
  } finally {
    w.cleanup();
  }
});

test('a step that asks for the same tool call over and over is a loop: poisoned, dead-lettered, bounded calls', async () => {
  const w = world({ issues: [issue(1, 'Loop', 'The model keeps asking for the same tool call.')], script: script([
    { kind: 'decompose', sequence: [ONE_RESEARCH_STEP] },
    { kind: 'subtask', sequence: [{ reply: 'tool', tool: 'repo_read_file', args: { path: 'README.md' } }] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    const t = w.task();
    assert.equal(t.status, 'dead-lettered');
    assert.equal(t.failure.class, 'poisoned');
    assert.equal(t.failure.code, 'NO_PROGRESS');
    assert.ok(w.calls('subtask').length <= 4, `${w.calls('subtask').length} sub-task calls`);
    assert.ok(w.events().some((e) => e.type === 'step.attempt-failed' && e.code === 'LOOP_DETECTED'));
    assert.equal(w.github.counts().commentOnIssue, 1);
  } finally {
    w.cleanup();
  }
});

test('a credential path (refused by the reviewer gate), a jailed path, and an unknown tool are each answered with an error the model can recover from, not a crash', async () => {
  const w = world({ issues: [issue(1, 'Nosy', 'Try to read a secret.')], script: script([
    { kind: 'decompose', sequence: [ONE_RESEARCH_STEP] },
    { kind: 'subtask', promptIncludes: 'ERROR TOOL_UNKNOWN', sequence: [{ reply: 'prose', text: 'I could not read it; here is what I know instead.' }] },
    { kind: 'subtask', promptIncludes: 'ERROR TOOL_ERROR', sequence: [{ reply: 'tool', tool: 'shell_exec', args: { cmd: 'ls' } }] },
    { kind: 'subtask', promptIncludes: 'ERROR TOOL_DENIED', sequence: [{ reply: 'tool', tool: 'repo_read_file', args: { path: '../outside.txt' } }] },
    { kind: 'subtask', sequence: [{ reply: 'tool', tool: 'repo_read_file', args: { path: '.env' } }] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    assert.equal(w.task().status, 'complete', JSON.stringify(w.task().failure));
    const outcomes = w.events().filter((e) => e.type === 'tool.call').map((e) => e.outcome);
    assert.deepEqual(outcomes, ['TOOL_DENIED', 'TOOL_ERROR', 'TOOL_UNKNOWN']);
    assert.ok(w.events().some((e) => e.type === 'tool.call' && e.outcome === 'TOOL_DENIED' && e.decision === 'deny'));
    assert.equal(w.calls('subtask').length, 4);
  } finally {
    w.cleanup();
  }
});

test('approval autonomy: a local write parks the task on waiting(approval) with one request comment; /titan approve <key> resumes it and the write then happens', async () => {
  const w = world({ issues: [issue(1, 'Draft', 'Write a draft into the workspace.')], control: { autonomy: 'approval' }, script: script([
    { kind: 'decompose', sequence: [ONE_RESEARCH_STEP] },
    { kind: 'subtask', promptIncludes: 'wrote', sequence: [{ reply: 'prose', text: 'The draft is written.' }] },
    { kind: 'subtask', sequence: [{ reply: 'tool', tool: 'workspace_write', args: { path: 'draft.md', content: 'hello' } }] },
  ]) });
  try {
    const s1 = await runPulse(w.deps({ pulseId: 'p1' }));
    assert.equal(s1.tasksParked, 1);
    let t = w.task();
    assert.equal(t.status, 'waiting');
    assert.equal(t.waitReason, 'approval');
    assert.equal(t.parks ?? 0, 0, 'an approval wait is not a provider park');
    assert.ok(w.checkpoint());
    const asks = w.github.data.issues[0].comments.filter((c) => c.body.includes('/titan approve tool:workspace_write:'));
    assert.equal(asks.length, 1);
    const key = asks[0].body.match(/\/titan approve (tool:workspace_write:[0-9a-f]{8})/)[1];
    assert.equal(existsSync(join(w.stateDir, 'workspaces', 'issue-1', 'draft.md')), false, 'nothing written before approval');

    // Same pulse again, still waiting: no second request, no calls.
    const callsBefore = w.fake.calls;
    await runPulse(w.deps({ pulseId: 'p2' }));
    assert.equal(w.task().status, 'waiting');
    assert.equal(w.fake.calls, callsBefore);
    assert.equal(w.github.data.issues[0].comments.filter((c) => c.body.includes('/titan approve')).length, 1);

    // The owner approves the tool call on the issue: the step resumes, the
    // write happens, the work is verified — and then delivery itself waits
    // for its own approval, because 'approval' gates every non-read effect.
    w.github.data.issues[0].comments.push({ id: 99, body: `/titan approve ${key}`, created_at: '2026-04-01T09:30:00.000Z', user: OWNER, author_association: 'OWNER' });
    w.github.data.issues[0].updated_at = '2026-04-01T09:30:00.000Z';
    const s3 = await runPulse(w.deps({ pulseId: 'p3', now: () => new Date('2026-04-01T09:31:00.000Z') }));
    assert.equal(s3.tasksParked, 1);
    t = w.task();
    assert.equal(t.status, 'waiting');
    assert.equal(t.waitReason, 'approval');
    assert.equal(t.approvals[key].decision, 'approved');
    assert.equal(readFileSync(join(w.stateDir, 'workspaces', 'issue-1', 'draft.md'), 'utf8'), 'hello');
    assert.ok(w.events().some((e) => e.type === 'policy.decision' && e.outcome === 'allow' && /approved by owner-login/.test(e.reason)));
    assert.ok(w.events().some((e) => e.type === 'verify.finished' && e.outcome === 'pass'));
    const deliverAsk = w.github.data.issues[0].comments.find((c) => c.body.includes('/titan approve deliver:'));
    assert.ok(deliverAsk, 'delivery asked for approval');
    assert.equal(w.github.counts().closeIssue ?? 0, 0);

    // The owner approves delivery: the result is posted once and the issue closed.
    const deliverKey = deliverAsk.body.match(/\/titan approve (deliver:[0-9a-f-]+)/)[1];
    w.github.data.issues[0].comments.push({ id: 100, body: `/titan approve ${deliverKey}`, created_at: '2026-04-01T09:40:00.000Z', user: OWNER, author_association: 'OWNER' });
    w.github.data.issues[0].updated_at = '2026-04-01T09:40:00.000Z';
    const judgeCalls = w.calls('judge').length;
    const s4 = await runPulse(w.deps({ pulseId: 'p4', now: () => new Date('2026-04-01T09:41:00.000Z') }));
    assert.equal(s4.tasksCompleted, 1);
    assert.equal(w.task().status, 'complete');
    assert.equal(w.calls('judge').length, judgeCalls, 'not re-verified on the delivery resume');
    assert.equal(w.github.data.issues[0].comments.filter((c) => c.body.includes('finished this task')).length, 1);
    assert.equal(w.github.counts().closeIssue, 1);
    assert.equal(w.checkpoint(), false);
  } finally {
    w.cleanup();
  }
});

test('propose autonomy: the work is done and verified, then delivery waits for approval; /titan deny cancels it without posting the result', async () => {
  const w = world({ issues: [issue(1, 'Propose', 'Build it, but ask before posting.')], control: { autonomy: 'propose' }, script: script([
    { kind: 'decompose', sequence: [ONE_CODE_STEP] },
    { kind: 'subtask', sequence: [ENVELOPE] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    const t = w.task();
    assert.equal(t.status, 'waiting');
    assert.equal(t.waitReason, 'approval');
    const ask = w.github.data.issues[0].comments.find((c) => c.body.includes('/titan approve deliver:'));
    assert.ok(ask, 'the approval request was posted');
    assert.equal(w.github.data.issues[0].comments.length, 1, 'no result posted yet');
    const key = ask.body.match(/\/titan approve (deliver:[0-9a-f-]+)/)[1];
    assert.equal(t.runId, key.slice('deliver:'.length));
    const cp = JSON.parse(readFileSync(join(w.stateDir, 'checkpoints', 'issue-1.json'), 'utf8'));
    assert.equal(cp.verification.verdict, 'pass');

    w.github.data.issues[0].comments.push({ id: 5, body: `/titan deny ${key}`, created_at: '2026-04-01T09:30:00.000Z', user: OWNER, author_association: 'OWNER' });
    w.github.data.issues[0].updated_at = '2026-04-01T09:30:00.000Z';
    const judgeCalls = w.calls('judge').length;
    await runPulse(w.deps({ pulseId: 'p2', now: () => new Date('2026-04-01T09:31:00.000Z') }));
    const after = w.task();
    assert.equal(after.status, 'cancelled', JSON.stringify(after.history.map((h) => h.reason)));
    assert.equal(w.calls('judge').length, judgeCalls, 'a denied delivery was not re-verified');
    assert.equal(w.github.data.issues[0].comments.filter((c) => c.body.includes('finished this task')).length, 0, 'the result was never posted');
    assert.equal(w.github.counts().closeIssue ?? 0, 0);
    assert.equal(w.checkpoint(), false);
  } finally {
    w.cleanup();
  }
});

test('dry-run autonomy: the task runs and completes but nothing reaches GitHub, and every suppressed effect is audited', async () => {
  const w = world({ issues: [issue(1, 'Quiet', 'Run silently.')], control: { autonomy: 'dry-run' }, script: script([
    { kind: 'decompose', sequence: [ONE_CODE_STEP] },
    { kind: 'subtask', sequence: [ENVELOPE] },
  ]) });
  try {
    const s = await runPulse(w.deps({ pulseId: 'p1' }));
    assert.equal(s.tasksCompleted, 1);
    assert.equal(w.task().status, 'complete');
    assert.equal(w.github.counts().commentOnIssue ?? 0, 0);
    assert.equal(w.github.counts().closeIssue ?? 0, 0);
    assert.ok(w.events().some((e) => e.type === 'delivery.suppressed' && e.audit));
    assert.ok(existsSync(join(w.stateDir, 'runs', `${w.task().runId}.json`)), 'the run record is still written');
  } finally {
    w.cleanup();
  }
});

test('verification: a judge that fails the run sends the step back once with its feedback in the prompt; the remediated run passes', async () => {
  const judge = { kind: 'judge', sequence: [
    { reply: 'raw', text: '{"verdict":"fail","reason":"the module exports nothing useful","issues":[{"step":"only","problem":"export a real function, not a boolean"}]}' },
    { reply: 'raw', text: '{"verdict":"pass","reason":"fixed","issues":[]}' },
  ] };
  const w = world({ issues: [issue(1, 'Judged', 'Build a module.')], script: script([
    { kind: 'decompose', sequence: [ONE_CODE_STEP] },
    { kind: 'subtask', promptIncludes: 'VERIFICATION FEEDBACK', sequence: [{ reply: 'envelope', files: [{ path: 'src/only.js', content: 'export function only() { return 42; }\n' }] }] },
    { kind: 'subtask', sequence: [ENVELOPE] },
  ], { judge }) });
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    const t = w.task();
    assert.equal(t.status, 'complete', JSON.stringify(t.failure));
    assert.equal(w.calls('subtask').length, 2, 'the step ran twice: once, and once remediated');
    assert.equal(w.calls('judge').length, 2);
    assert.ok(w.events().some((e) => e.type === 'remediate.started' && e.round === 1 && e.steps.includes('only')));
    const run = JSON.parse(readFileSync(join(w.stateDir, 'runs', `${t.runId}.json`), 'utf8'));
    assert.ok(run.files.some((f) => f.path === 'src/only.js'));
    assert.equal(w.github.counts().commentOnIssue, 1);
  } finally {
    w.cleanup();
  }
});

test('verification: a deterministic check failure (a code step with no files) is remediated without a judge call, and a run that still fails is failed honestly with the reason on the issue', async () => {
  const w = world({ issues: [issue(1, 'Stubborn', 'Build a module.')], script: script([
    { kind: 'decompose', sequence: [ONE_CODE_STEP] },
    { kind: 'subtask', sequence: [{ reply: 'prose', text: 'I described the module instead of writing it.' }] },
  ]) });
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    const t = w.task();
    assert.equal(t.status, 'failed');
    assert.equal(t.failure.code, 'VERIFICATION_FAILED');
    assert.match(t.error, /code-steps-produced/);
    assert.equal(w.calls('judge').length, 0, 'no judge on a certain failure');
    assert.equal(w.calls('subtask').length, 2, 'one remediation, then stop');
    const comment = w.github.data.issues[0].comments[0].body;
    assert.match(comment, /did not pass verification/);
    assert.match(comment, /code-steps-produced/);
    assert.equal(w.github.counts().closeIssue ?? 0, 0, 'a failed task does not close its issue');
    assert.equal(w.checkpoint(), false);
  } finally {
    w.cleanup();
  }
});
