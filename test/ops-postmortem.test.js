import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendLesson, errorSignature, failureFacts, gitleaksScan, lessonsBlock, normalizeMessage, readLessons, relevantLessons, runPostmortems,
  sanitizeLine, templatePostmortem, writePostmortem,
} from '../src/ops/postmortem.js';
import { buildDecomposePrompt } from '../src/orchestrator/decomposer.js';
import { runPulse } from '../src/engine/pulse.js';
import { FakeProviderAgent } from '../src/fakes/fakeProvider.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { checkStateFile } from '../scripts/check-state.mjs';

const NOW = new Date('2026-10-12T10:00:00Z');
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'titan-pm-')); return { d, path: join(d, 'lessons.jsonl'), done: () => rmSync(d, { recursive: true, force: true }) }; };
const failure = (over = {}) => ({ class: 'rate_limited', code: 'RATE_LIMITED', message: 'Groq rate limited (429): try again in 12s', at: '2026-10-12T09:00:00.000Z', ...over });
const failedTask = (id, over = {}) => ({ id, type: 'task', status: 'failed', title: 'PRIVATE-TITLE-XYZ', prompt: 'PRIVATE-PROMPT-XYZ please email bob@example.com', attempts: 3, parks: 1, failure: failure(), ...over });

test('RO4 signature: the same kind of failure has the same signature, whatever the numbers, ids, and quoted text', () => {
  const a = errorSignature(failure());
  assert.equal(errorSignature(failure({ message: 'Groq rate limited (429): try again in 47s' })), a);
  assert.equal(errorSignature(failure({ message: 'Groq rate limited (429): try again in 3s' })), a);
  assert.notEqual(errorSignature(failure({ code: 'QUOTA' })), a);
  assert.notEqual(errorSignature(failure({ class: 'provider_down' })), a);
  assert.notEqual(errorSignature(failure({ message: 'Together rate limited (429): try again in 12s' })), a);
  const quoted = (t) => errorSignature({ class: 'permanent', code: 'VERIFICATION_FAILED', message: `The judge said "${t}" for issue-12 run 5f3a9c1e-1111-2222-3333-444455556666` });
  assert.equal(quoted('missing tests'), quoted('wrong output'), 'the quoted text varies');
  assert.match(a, /^rate_limited:RATE_LIMITED:[0-9a-f]{10}$/);
  assert.equal(normalizeMessage('see https://x.example/a?b=1 at 12:30 id 0123456789abcdef'), 'see <url> at <n>:<n> id <hash>');
  assert.equal(normalizeMessage('failed (tried: a) (skipped: b (c))'), 'failed');
  // The list of providers in parentheses changes with the breakers. It is the same cause.
  const all = (list) => errorSignature({ class: 'permanent', code: 'ALL_PROVIDERS_FAILED', message: `All providers failed for this request ${list}` });
  assert.equal(all('(tried: huggingface)'), all('(tried: none configured or healthy) (skipped: huggingface — breaker open: error)'));
});

test('RO4 template: it states the class, the code, the step category, and the providers, and holds no task text', () => {
  const run = { tasks: [{ state: 'complete', aspect: 'research' }, { state: 'failed', aspect: 'code-generation', attempts: [{ pool: 'phase2', ok: false }, { pool: 'opencode', ok: false }] }] };
  const facts = failureFacts(failedTask('issue-1'), run);
  assert.deepEqual([facts.class, facts.code, facts.aspect, facts.providers], ['rate_limited', 'RATE_LIMITED', 'code-generation', ['phase2', 'opencode']]);
  const pm = templatePostmortem(facts);
  assert.match(pm.what_failed, /A task failed in a "code-generation" step\. Failure class rate_limited, code RATE_LIMITED, after 3 attempt\(s\) and 1 wait\(s\)\. Providers tried: phase2, opencode\./);
  assert.match(pm.likely_cause, /429/);
  assert.equal(pm.source, 'template');
  const all = JSON.stringify(pm);
  assert.ok(!/PRIVATE|bob@/.test(all), 'no title, prompt, or address');
  assert.match(templatePostmortem(failureFacts(failedTask('x', { failure: failure({ class: 'permanent', code: 'VERIFICATION_FAILED' }) }))).suggested_fix, /more exact/);
  for (const cls of ['rate_limited', 'provider_down', 'timeout', 'malformed_output', 'tool_error', 'policy_blocked', 'budget_exhausted', 'poisoned', 'permanent', 'transient', 'something_new']) {
    const t = templatePostmortem(failureFacts(failedTask('x', { failure: failure({ class: cls, code: 'X' }) })));
    assert.ok(t.likely_cause.length > 10 && t.suggested_fix.length > 10, cls);
  }
});

test('RO4 model: a free model writes the cause and the fix, and its text is cleaned', async () => {
  const seen = [];
  const chat = async (messages, opts) => { seen.push({ messages, opts }); return { text: '```json\n{"likely_cause": "The free limit of the provider was reached, see https://groq.example/limits.", "suggested_fix": "Wait for the reset."}\n```' }; };
  const pm = await writePostmortem(failureFacts(failedTask('i')), { chat, scan: () => ({ clean: true }) });
  assert.equal(pm.source, 'model');
  assert.equal(pm.likely_cause, 'The free limit of the provider was reached, see [link].');
  assert.equal(pm.suggested_fix, 'Wait for the reset.');
  assert.equal(seen[0].opts.priority, 'low', 'a low priority call that leaves the quota reserve alone');
  const prompt = JSON.stringify(seen[0].messages);
  assert.ok(!/PRIVATE|bob@/.test(prompt), 'the prompt of the model holds the facts and no task text');
  assert.match(prompt, /failure class: rate_limited/);
});

test('RO4 model: it falls back to the template when the model fails, answers badly, leaks a secret or an address, or fails the scan', async () => {
  const facts = failureFacts(failedTask('i'));
  const key = ['gsk', 'q'.repeat(30)].join('_');
  const cases = {
    'throws': async () => { throw new Error('all providers failed'); },
    'not json': async () => ({ text: 'I think it was the rate limit.' }),
    'a field is missing': async () => ({ text: '{"likely_cause": "The limit was reached."}' }),
    'a secret': async () => ({ text: JSON.stringify({ likely_cause: `The key ${key} hit the limit.`, suggested_fix: 'Wait for the reset today.' }) }),
    'an address': async () => ({ text: JSON.stringify({ likely_cause: 'Ask bob@example.com about the limit.', suggested_fix: 'Wait for the reset today.' }) }),
    'too short': async () => ({ text: '{"likely_cause": "x", "suggested_fix": "y"}' }),
  };
  for (const [name, chat] of Object.entries(cases)) {
    const pm = await writePostmortem(facts, { chat, scan: () => ({ clean: true }) });
    assert.equal(pm.source, 'template', name);
    assert.ok(!pm.likely_cause.includes(key) && !pm.likely_cause.includes('bob@'), name);
  }
  const dirty = await writePostmortem(facts, { chat: async () => ({ text: '{"likely_cause": "The limit was reached for this account.", "suggested_fix": "Wait for the reset."}' }), scan: () => ({ clean: false }) });
  assert.equal(dirty.source, 'template', 'a finding of the scan drops the model text');
  assert.equal((await writePostmortem(facts, {})).source, 'template', 'no model at all');
  assert.equal(sanitizeLine('```code```'), null);
});

test('RO4 scan: gitleaks runs on the text when the binary exists, flags a secret, and is skipped when it is missing', () => {
  assert.deepEqual(gitleaksScan('anything', { bin: '/nonexistent/gitleaks' }), { scanned: false, clean: true });
  const bin = process.env.GITLEAKS_BIN;
  if (bin) {
    assert.deepEqual(gitleaksScan('The limit was reached.', { bin }), { scanned: true, clean: true });
    assert.deepEqual(gitleaksScan(`token ${['gsk', 'Ab1'.repeat(14)].join('_')}`, { bin }), { scanned: true, clean: false });
  }
});

test('RO4 lessons: a new failure adds a line, a repeat raises the count, and the same failure is never counted twice', () => {
  const { path, done } = tmp();
  try {
    const lesson = (over = {}) => ({ signature: errorSignature(failure()), task_type: 'code-generation', what_failed: 'A task failed.', likely_cause: 'The limit was reached.', suggested_fix: 'Wait.', source: 'template', ...over });
    assert.equal(appendLesson(path, lesson(), 'issue-1@a', NOW).outcome, 'new');
    const second = appendLesson(path, lesson(), 'issue-2@b', new Date(NOW.getTime() + 3600_000));
    assert.equal(second.outcome, 'merged');
    assert.deepEqual([second.lesson.count, second.lesson.first_seen, second.lesson.last_seen], [2, NOW.toISOString(), '2026-10-12T11:00:00.000Z']);
    assert.equal(appendLesson(path, lesson(), 'issue-2@b', NOW).outcome, 'duplicate');
    assert.equal(readLessons(path).length, 1);
    assert.equal(readLessons(path)[0].count, 2);
    // A model text replaces a template text, and never the other way round.
    appendLesson(path, lesson({ source: 'model', likely_cause: 'A better cause text.', suggested_fix: 'A better fix text.' }), 'issue-3@c', NOW);
    assert.equal(readLessons(path)[0].likely_cause, 'A better cause text.');
    appendLesson(path, lesson({ source: 'template', likely_cause: 'Worse.' }), 'issue-4@d', NOW);
    assert.equal(readLessons(path)[0].likely_cause, 'A better cause text.');
    for (let i = 0; i < 10; i += 1) appendLesson(path, lesson(), `many-${i}@x`, NOW);
    assert.equal(readLessons(path)[0].run_ids.length, 5, 'only the last 5 run keys stay');
    appendLesson(path, lesson({ signature: 'other:CODE:0123456789' }), 'issue-9@z', NOW);
    assert.equal(readLessons(path).length, 2);
    assert.deepEqual(checkStateFile('lessons.jsonl', readFileSync(path)), [], 'the file passes the strict state check');
  } finally {
    done();
  }
});

test('RO4 lessons: the file holds at most 200 lessons, drops the rarest, and skips a line that cannot be read', () => {
  const { path, done } = tmp();
  try {
    writeFileSync(path, 'not json\n');
    for (let i = 0; i < 205; i += 1) appendLesson(path, { signature: `c:C${i}:0123456789`, task_type: null, what_failed: 'x failed.', likely_cause: 'cause cause', suggested_fix: 'fix fix fix', source: 'template' }, `r${i}@x`, new Date(NOW.getTime() + i * 1000));
    for (let i = 0; i < 3; i += 1) appendLesson(path, { signature: 'c:C204:0123456789', task_type: null, what_failed: 'x failed.', likely_cause: 'cause cause', suggested_fix: 'fix fix fix', source: 'template' }, `again${i}@x`, NOW);
    const lessons = readLessons(path);
    assert.equal(lessons.length, 200);
    assert.ok(lessons.some((l) => l.signature === 'c:C204:0123456789' && l.count === 4), 'a frequent lesson stays');
  } finally {
    done();
  }
});

test('RO4 sweep: only failed and dead-lettered tasks get one, a dependency failure is skipped, it runs once, and it holds no task text', async () => {
  const { path, done } = tmp();
  try {
    const tasks = [
      failedTask('issue-1'),
      failedTask('issue-2', { status: 'dead-lettered' }),
      { ...failedTask('issue-3'), status: 'complete' },
      failedTask('issue-4', { failure: failure({ class: 'permanent', code: 'DEPENDENCY_FAILED', message: 'dependency failed' }) }),
      failedTask('issue-5', { failure: null }),
    ];
    const events = [];
    const res = await runPostmortems({ tasks, lessonsPath: path, now: NOW, events: { append: (t, f) => events.push({ t, ...f }) } });
    assert.deepEqual(res, { written: 1, merged: 1, skipped: 1 });
    assert.equal(readLessons(path)[0].count, 2, 'the two rate limits are one lesson');
    assert.deepEqual(events.map((e) => e.outcome), ['new', 'merged']);
    assert.deepEqual(await runPostmortems({ tasks, lessonsPath: path, now: NOW }), { written: 0, merged: 0, skipped: 1 }, 'a second sweep adds nothing');
    const text = readFileSync(path, 'utf8');
    assert.ok(!/PRIVATE|bob@|example\.com/.test(text), 'no title, no prompt, no address');
    const many = Array.from({ length: 6 }, (_, i) => failedTask(`m${i}`, { failure: failure({ code: `CODE_${i}` }) }));
    assert.equal((await runPostmortems({ tasks: many, lessonsPath: path, now: NOW })).written, 3, 'at most 3 for each pulse, so the pulse stays short');
  } finally {
    done();
  }
});

test('RO4 relevance: the five most relevant lessons come first, by shared words, count, and recency', () => {
  const l = (signature, text, count, lastSeen, taskType = null) => ({ signature, id: signature.slice(0, 8), what_failed: text, likely_cause: 'cause cause', suggested_fix: 'fix fix', count, last_seen: lastSeen, task_type: taskType, first_seen: lastSeen, source: 'template', run_ids: [] });
  const lessons = [
    l('a:A:1', 'A task failed in a "code-generation" step with a parser error', 1, '2026-10-01T00:00:00.000Z', 'code-generation'),
    l('b:B:2', 'A task failed in a "research" step', 9, '2026-10-12T00:00:00.000Z', 'research'),
    l('c:C:3', 'A task failed in a "devops" step about docker containers', 1, '2026-09-01T00:00:00.000Z', 'devops'),
    ...Array.from({ length: 6 }, (_, i) => l(`z:Z${i}:9`, 'A task failed somewhere else', 1, '2026-08-01T00:00:00.000Z')),
  ];
  const top = relevantLessons(lessons, 'Write a parser for a config file and add the code', 5, NOW);
  assert.equal(top.length, 5);
  assert.equal(top[0].signature, 'a:A:1', 'shared words and the category decide');
  assert.deepEqual(relevantLessons(lessons, 'List the docker containers', 1, NOW).map((x) => x.signature), ['c:C:3']);
  assert.deepEqual(relevantLessons([], 'anything'), []);
  const block = lessonsBlock(top.slice(0, 2));
  assert.equal(block.split('\n').length, 2);
  assert.match(block, /^- \(1x\) A task failed/);
  assert.equal(lessonsBlock([]), '');
});

test('RO4 decomposer: the lessons go into the planning prompt, and a prompt with no lessons is unchanged', () => {
  const plain = buildDecomposePrompt('Build a thing', 8);
  const withLessons = buildDecomposePrompt('Build a thing', 8, undefined, '- (2x) A task failed. Likely cause: x. Fix: y.');
  assert.ok(!plain.includes('Lessons'));
  assert.match(withLessons, /Lessons from earlier failed runs of this system\. Plan so that you do not repeat them:\n- \(2x\) A task failed\./);
  assert.ok(withLessons.indexOf('Lessons') < withLessons.indexOf('Master prompt:'), 'the lessons come before the task');
  assert.equal(buildDecomposePrompt('Build a thing', 8, ['bad json']).includes('Lessons'), false);
});

// ---------------------------------------------------------------------
// A whole pulse
// ---------------------------------------------------------------------

const ONE_STEP = { reply: 'graph', graph: { sharedContext: 'ctx', tasks: [{ id: 'only', title: 'Only', aspect: 'code-generation', description: 'Do it.', dependsOn: [], estimatedComplexity: 'low', deliverable: 'src/only.js' }] } };
const issue = (number, title, body) => ({ number, title, body, user: { login: 'owner-login' }, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }], state: 'open', comments: [] });
const script = (rules) => ({ seed: 3, latencyMs: [1, 3], rules: [{ kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] }, { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] }, ...rules, { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] }] });

test('RO4 pulse: two failures of one kind become one lesson with a count of 2, and the next plan reads it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'titan-pm-pulse-'));
  try {
    const github = new FakeGitHub({ fixture: { issues: [issue(1, 'First doomed task PRIVATE-TITLE-XYZ', 'Build a parser.'), issue(2, 'Second doomed task', 'Build another parser.')] }, repository: 'owner-login/repo' });
    const fake = new FakeProviderAgent({ script: script([{ kind: 'decompose', sequence: [ONE_STEP, ONE_STEP, ONE_STEP] }, { kind: 'subtask', sequence: [{ fault: 'unauthorized-401' }, { fault: 'unauthorized-401' }, { fault: 'unauthorized-401' }, { fault: 'unauthorized-401' }] }]), quiet: true });
    const deps = (id) => ({ stateDir, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, pulseId: id, now: () => new Date('2026-10-12T10:00:00Z') });
    await runPulse(deps('p1'));
    const lessons = readLessons(join(stateDir, 'lessons.jsonl'));
    assert.equal(lessons.length, 1, 'both tasks failed the same way');
    assert.equal(lessons[0].count, 2);
    assert.match(lessons[0].signature, /^permanent:ALL_PROVIDERS_FAILED:/);
    assert.equal(lessons[0].source, 'template', 'no free model in a simulation');
    assert.ok(!/PRIVATE-TITLE/.test(readFileSync(join(stateDir, 'lessons.jsonl'), 'utf8')));
    assert.deepEqual(checkStateFile('lessons.jsonl', readFileSync(join(stateDir, 'lessons.jsonl'))), []);
    // A new task: the decomposer prompt carries the lesson.
    const prompts = [];
    const original = fake.engine.next.bind(fake.engine);
    fake.engine.next = (kind, taskId, prompt) => { prompts.push({ kind, prompt: String(prompt) }); return original(kind, taskId, prompt); };
    github.data.issues.push(issue(3, 'Third task', 'Build a parser for config files.'));
    await runPulse(deps('p2'));
    const plan = prompts.filter((p) => p.kind === 'decompose').at(-1);
    assert.ok(plan, 'the third task was planned');
    assert.match(plan.prompt, /Lessons from earlier failed runs of this system\. Plan so that you do not repeat them:/);
    assert.match(plan.prompt, /- \(2x\) A task failed in a "code-generation" step\. Failure class permanent, code ALL_PROVIDERS_FAILED/);
    assert.ok(plan.prompt.indexOf('Lessons from') < plan.prompt.indexOf('Master prompt:'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('RO4 pulse: TITAN_POSTMORTEM=0 turns the sweep off', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'titan-pm-off-'));
  const old = process.env.TITAN_POSTMORTEM;
  process.env.TITAN_POSTMORTEM = '0';
  try {
    const github = new FakeGitHub({ fixture: { issues: [issue(1, 'Doomed', 'Build it.')] }, repository: 'owner-login/repo' });
    const fake = new FakeProviderAgent({ script: script([{ kind: 'decompose', sequence: [ONE_STEP] }, { kind: 'subtask', sequence: [{ fault: 'unauthorized-401' }] }]), quiet: true });
    await runPulse({ stateDir, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, pulseId: 'p', now: () => new Date('2026-10-12T10:00:00Z') });
    assert.equal(existsSync(join(stateDir, 'lessons.jsonl')), false);
  } finally {
    if (old === undefined) delete process.env.TITAN_POSTMORTEM; else process.env.TITAN_POSTMORTEM = old;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
