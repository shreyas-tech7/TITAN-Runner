/**
 * RT7: every file under state/ matches a strict schema, and every kind of state file has one.
 *
 * The test checks three things:
 *   1. the committed state/ folder of the repo,
 *   2. the folders that real pulses write in several scenarios (a run, a park with a checkpoint, an approval, a failure),
 *   3. the rules of the strict schemas themselves (no extra fields, no loose object).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { runPulse } from '../src/engine/pulse.js';
import { FakeProviderAgent } from '../src/fakes/fakeProvider.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { checkStateDir, checkStateFile } from '../scripts/check-state.mjs';
import { STATE_FILES, findLooseObjects, schemaFor } from '../src/state/strict.js';

const OWNER = { login: 'owner-login' };
const T0 = Date.parse('2026-04-01T09:00:00.000Z');
const at = (offsetMs) => () => new Date(T0 + offsetMs);
const issue = (number, title, body, extra = {}) => ({ number, title, body, user: OWNER, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }], state: 'open', comments: [], ...extra });
const ONE_STEP = { reply: 'graph', graph: { sharedContext: 'ctx', tasks: [{ id: 'only', title: 'Only', aspect: 'code-generation', description: 'Do it.', dependsOn: [], estimatedComplexity: 'low', deliverable: 'src/only.js' }] } };
const ENVELOPE = { reply: 'envelope', files: [{ path: 'src/only.js', content: 'export const only = true;\n' }] };
const JUDGE_PASS = { kind: 'judge', sequence: [{ reply: 'raw', text: '{"verdict":"pass","reason":"ok","issues":[]}' }] };
const script = (rules) => ({
  seed: 3, latencyMs: [1, 3],
  rules: [
    { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
    { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] },
    ...rules, JUDGE_PASS,
    { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] },
  ],
});

function world(issues, rules, control) {
  const stateDir = mkdtempSync(join(tmpdir(), 'titan-strict-'));
  if (control) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'control.json'), JSON.stringify({ version: 1, killSwitch: false, drain: false, safeMode: false, autonomy: control, updatedAt: '2026-04-01T08:00:00.000Z', updatedBy: 'test', reason: 'test' }));
  }
  const github = new FakeGitHub({ fixture: { issues }, repository: 'owner-login/repo' });
  const fake = new FakeProviderAgent({ script: script(rules), quiet: true });
  const deps = (extra = {}) => ({ stateDir, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, now: at(0), ...extra });
  return { stateDir, github, deps, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

function assertClean(stateDir, label) {
  const { files, problems } = checkStateDir(stateDir);
  assert.ok(files > 5, `${label}: the pulse wrote ${files} files`);
  assert.deepEqual(problems, [], `${label}: ${problems.slice(0, 5).join(' | ')}`);
}

test('the committed state/ folder matches its strict schemas', () => {
  const { files, problems } = checkStateDir(new URL('../state', import.meta.url).pathname);
  assert.ok(files > 20);
  assert.deepEqual(problems, []);
});

test('a pulse that runs a task, answers a stranger, and writes a run record leaves a valid tree', async () => {
  const w = world([issue(1, 'Run', 'Build it.'), issue(2, 'Stranger', 'Free compute.', { user: { login: 'stranger' }, author_association: 'NONE' })], [
    { kind: 'decompose', sequence: [ONE_STEP] }, { kind: 'subtask', sequence: [ENVELOPE] },
  ]);
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    await runPulse(w.deps({ pulseId: 'p2', now: at(60_000) }));
    assertClean(w.stateDir, 'happy path');
  } finally {
    w.cleanup();
  }
});

test('a parked task leaves a checkpoint, and the tree is valid', async () => {
  const w = world([issue(1, 'Quota', 'The quota is gone.')], [
    { kind: 'decompose', sequence: [ONE_STEP] }, { kind: 'subtask', sequence: [{ fault: 'quota-402' }, { fault: 'quota-402' }, ENVELOPE] },
  ]);
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    assert.ok(readFileSync(join(w.stateDir, 'checkpoints', 'issue-1.json'), 'utf8').includes('"taskId"'));
    assertClean(w.stateDir, 'parked');
  } finally {
    w.cleanup();
  }
});

test('an approval request and a denial leave a valid tree, and so does a failure that is dead-lettered', async () => {
  const w = world([issue(1, 'Propose', 'Ask before posting.')], [
    { kind: 'decompose', sequence: [ONE_STEP] }, { kind: 'subtask', sequence: [ENVELOPE] },
  ], 'propose');
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    const ask = w.github.data.issues[0].comments.find((c) => c.body.includes('/titan approve deliver:'));
    const key = ask.body.match(/\/titan approve (deliver:[0-9a-f-]+)/)[1];
    w.github.data.issues[0].comments.push({ id: 5, body: `/titan deny ${key}`, created_at: '2026-04-01T09:30:00.000Z', user: OWNER, author_association: 'OWNER' });
    w.github.data.issues[0].updated_at = '2026-04-01T09:30:00.000Z';
    await runPulse(w.deps({ pulseId: 'p2', now: () => new Date('2026-04-01T09:31:00.000Z') }));
    assertClean(w.stateDir, 'approval');
  } finally {
    w.cleanup();
  }
  const f = world([issue(1, 'Doomed', 'Rejected upstream.')], [
    { kind: 'decompose', sequence: [ONE_STEP] }, { kind: 'subtask', sequence: [{ fault: 'unauthorized-401' }] },
  ]);
  try {
    await runPulse(f.deps({ pulseId: 'p1' }));
    assertClean(f.stateDir, 'failure');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------
// The rules of the schemas
// ---------------------------------------------------------------------

test('every file kind has a schema, and the registry has no loose object', () => {
  for (const f of STATE_FILES) {
    if (f.kind === 'text') continue;
    assert.ok(f.schema, f.id);
    assert.deepEqual(findLooseObjects(f.schema), [], `${f.id} lists keys but allows extra ones`);
  }
});

test('an extra field fails at the top level and at a nested level', () => {
  const heartbeat = JSON.parse(readFileSync(new URL('../state/heartbeat.json', import.meta.url), 'utf8'));
  assert.deepEqual(checkStateFile('heartbeat.json', Buffer.from(JSON.stringify(heartbeat))), []);
  const top = checkStateFile('heartbeat.json', Buffer.from(JSON.stringify({ ...heartbeat, leaked: 'x' })));
  assert.ok(top.some((p) => /leaked.*unexpected property/.test(p)), top.join('|'));
  const nested = checkStateFile('heartbeat.json', Buffer.from(JSON.stringify({ ...heartbeat, budget: { ...heartbeat.budget, extra: 1 } })));
  assert.ok(nested.some((p) => /budget\.extra/.test(p)), nested.join('|'));
});

test('a file with no schema fails, and the message says what to do', () => {
  const p = checkStateFile('notes/private.md', Buffer.from('hello'));
  assert.equal(p.length, 1);
  assert.match(p[0], /no schema.*src\/state\/strict\.js/);
  assert.equal(schemaFor('anything/else.json'), null);
});

test('an event may carry extra scalar fields but not a deep object, and a secret in a file fails', () => {
  const base = { seq: 1, ts: '2026-10-11T00:00:00.000Z', type: 'pulse.started', pulseId: 'p1' };
  const ok = checkStateFile('events/2026-10-11.jsonl', Buffer.from(`${JSON.stringify({ ...base, budgetMs: 5, note: 'x', quota: { a: 1, b: [1, 2] } })}\n`));
  assert.deepEqual(ok, []);
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.ok(checkStateFile('events/2026-10-11.jsonl', Buffer.from(`${JSON.stringify({ ...base, deep })}\n`)).length > 0);
  const key = ['gsk', 'z'.repeat(30)].join('_');
  const leak = checkStateFile('events/2026-10-11.jsonl', Buffer.from(`${JSON.stringify({ ...base, note: key })}\n`));
  assert.ok(leak.some((p) => /secret-shaped/.test(p)));
  assert.ok(!leak.join('\n').includes(key), 'a message never holds the value');
});

test('a compressed monthly archive is decompressed, validated, and scanned', () => {
  const run = { runId: 'r1', taskId: 't', taskTitle: 'x', createdAt: '2026-05-01T00:00:00.000Z', durationMs: 1, state: 'complete', sharedContext: '', tasks: [], files: [], markdownSummary: '' };
  const good = gzipSync(Buffer.from(`${JSON.stringify(run)}\n`));
  assert.deepEqual(checkStateFile('archive/runs-2026-05.jsonl.gz', good), []);
  const bad = gzipSync(Buffer.from(`${JSON.stringify({ ...run, extra: true })}\n`));
  assert.ok(checkStateFile('archive/runs-2026-05.jsonl.gz', bad).some((p) => /extra/.test(p)));
  assert.ok(checkStateFile('archive/runs-2026-05.jsonl.gz', Buffer.from('not gzip')).some((p) => /not valid gzip/.test(p)));
});
