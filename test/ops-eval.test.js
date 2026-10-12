import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOLDEN_TASKS, EVAL_VERSION, selectTasks, tasksFingerprint } from '../src/ops/goldenTasks.js';
import { checkAnswer, runCodeCases, unfence } from '../src/ops/goldenCheck.js';
import { DEFAULT_MAX_CALLS, capabilityIdFor, evalMirror, feedCapabilityCache, runEval } from '../src/ops/eval.js';
import { UsageReporter } from '../src/ops/usageReporter.js';
import { CapabilityRegistry } from '../src/orchestrator/capabilityRegistry.js';
import { ASPECT_CATEGORIES } from '../src/orchestrator/taxonomy.js';
import { rankModels } from '../src/orchestrator/router.js';
import { checkStateFile } from '../scripts/check-state.mjs';

// ---------------------------------------------------------------------
// The tasks
// ---------------------------------------------------------------------

test('RO3 tasks: 12 to 20 tasks cover every category of the shared taxonomy, and each has a deterministic checker', () => {
  assert.ok(GOLDEN_TASKS.length >= 12 && GOLDEN_TASKS.length <= 20, `${GOLDEN_TASKS.length} tasks`);
  assert.deepEqual([...new Set(GOLDEN_TASKS.map((t) => t.category))].sort(), [...ASPECT_CATEGORIES].sort());
  assert.equal(new Set(GOLDEN_TASKS.map((t) => t.id)).size, GOLDEN_TASKS.length, 'unique ids');
  for (const t of GOLDEN_TASKS) {
    assert.ok(['exact', 'regex', 'json', 'code'].includes(t.checker.type), `${t.id}: no model judges`);
    assert.ok(t.prompt.length > 20 && t.reference && t.wrong, t.id);
    if (t.checker.type === 'code') assert.ok(t.checker.cases.length >= 2 && t.checker.fn, t.id);
  }
});

for (const task of GOLDEN_TASKS) {
  test(`RO3 checker ${task.id}: the reference answer passes and the wrong answer fails`, async () => {
    assert.deepEqual(await checkAnswer(task, task.reference), { pass: true, reason: 'ok' });
    const wrong = await checkAnswer(task, task.wrong);
    assert.equal(wrong.pass, false, `the wrong answer must fail (${wrong.reason})`);
    assert.equal((await checkAnswer(task, '')).pass, false);
    assert.equal((await checkAnswer(task, undefined)).pass, false);
  });
}

test('RO3 tasks: the fingerprint of the tasks is pinned, so a changed task must change EVAL_VERSION', () => {
  // If this fails, you changed a task. Bump EVAL_VERSION in src/ops/goldenTasks.js, then update this value.
  assert.equal(EVAL_VERSION, 'v1');
  assert.equal(tasksFingerprint(), 'e4bc4b9eb2ba');
});

test('RO3 checkers: answers are cleaned, fenced code is read, and a chatty answer to an exact task fails', async () => {
  const exact = GOLDEN_TASKS.find((t) => t.id === 'research-iphone-year');
  for (const ok of ['2007', ' 2007. ', '"2007"', '`2007`', '```\n2007\n```']) assert.equal((await checkAnswer(exact, ok)).pass, true, ok);
  for (const bad of ['The year was 2007', '2007 and 2008', 'year 2007']) assert.equal((await checkAnswer(exact, bad)).pass, false, bad);
  const code = GOLDEN_TASKS.find((t) => t.id === 'code-sum-evens');
  assert.equal((await checkAnswer(code, '```js\nfunction sumEvens(a){return a.filter(n=>n%2===0).reduce((s,n)=>s+n,0)}\n```')).pass, true);
  assert.equal(unfence('```js\nx = 1\n```'), 'x = 1');
  const json = GOLDEN_TASKS.find((t) => t.id === 'data-posts-table');
  assert.equal((await checkAnswer(json, 'Here you go:\n```json\n{"table":"posts","columns":["id","title","body","author_id"]}\n```')).pass, true);
  assert.equal((await checkAnswer(json, '{"table":"posts","columns":["id","title","body","created"]}')).reason, 'missing_values');
  assert.equal((await checkAnswer(json, '{"table":"posts","columns":["id","title","body"]}')).reason, 'schema', 'too few columns');
  assert.equal((await checkAnswer(json, 'not json')).reason, 'bad_json');
  assert.equal((await checkAnswer(json, '{"table":5,"columns":[]}')).reason, 'schema');
});

test('RO3 checkers: the refactoring task needs reduce and refuses a for loop', async () => {
  const t = GOLDEN_TASKS.find((x) => x.id === 'refactor-total');
  assert.equal((await checkAnswer(t, 'function total(items){return items.reduce((a,i)=>a+i.price*i.qty,0)}')).pass, true);
  assert.equal((await checkAnswer(t, 'function total(items){let t=0;items.forEach(i=>{t+=i.price*i.qty});return t}')).reason, 'missing_construct');
  assert.equal((await checkAnswer(t, 'function total(items){for(const i of items){}return items.reduce((a,i)=>a+i.price*i.qty,0)}')).reason, 'forbidden_construct');
});

// ---------------------------------------------------------------------
// The sandbox for code from a model
// ---------------------------------------------------------------------

test('RO3 sandbox: without the permission model no model code runs, unless a person allows it on their own machine', async () => {
  const { runCodeCases: run } = await import('../src/ops/goldenCheck.js');
  // This Node has the permission model, so the child runs. The fail closed branch is read from the source.
  const src = (await import('node:fs')).readFileSync(new URL('../src/ops/goldenCheck.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!flag && process\.env\.TITAN_EVAL_ALLOW_UNSANDBOXED !== '1'\) return \{ passed: 0, total: cases\.length, error: 'no_sandbox' \}/);
  assert.equal((await run({ code: 'function f(){return 1}', fn: 'f', cases: [{ args: [], expect: 1 }] })).passed, 1);
});

test('RO3 sandbox: model code cannot see the environment of this process, files, or other processes, and a loop is stopped', async () => {
  process.env.TITAN_EVAL_TEST_SECRET = 'must-never-be-visible';
  try {
    const spy = (body) => `function f(){ try { const p = this.constructor.constructor("return process")(); ${body} } catch (e) { return "blocked" } }`;
    const run = (code, expect) => runCodeCases({ code, fn: 'f', cases: [{ args: [], expect }] });
    // The test reads each value through the expected result: the case passes only when the value matches.
    assert.equal((await run(spy('return Object.keys(p.env).length;'), 0)).passed, 1, 'the child environment is empty');
    assert.equal((await run(spy('return String(p.env.TITAN_EVAL_TEST_SECRET);'), 'undefined')).passed, 1, 'the secret is not visible');
    assert.equal((await run(spy('return p.mainModule.require("fs").readdirSync("/").length > 0 ? "read" : "empty";'), 'blocked')).passed, 1, 'no file access');
    assert.equal((await run(spy('return p.mainModule.require("child_process").execSync("echo hi").toString();'), 'blocked')).passed, 1, 'no process');
    const started = Date.now();
    const loop = await run('function f(){ while (true) {} }', 'x');
    assert.deepEqual([loop.passed, Date.now() - started < 6000], [0, true], 'an endless loop is stopped');
    assert.equal((await runCodeCases({ code: 'function f( {', fn: 'f', cases: [{ args: [], expect: 1 }] })).error, 'code_error');
    assert.equal((await runCodeCases({ code: 'function g(){}', fn: 'f', cases: [{ args: [], expect: 1 }] })).error, 'no_function');
    assert.equal((await run('function f(){ throw new Error("x") }', 1)).passed, 0, 'a case that throws fails');
  } finally {
    delete process.env.TITAN_EVAL_TEST_SECRET;
  }
});

// ---------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------

test('RO3 budget: selectTasks keeps every category as long as the budget allows, gives every model the same tasks, and stays inside the budget', () => {
  assert.equal(selectTasks(GOLDEN_TASKS, 10, 280).length, GOLDEN_TASKS.length, '10 models x 15 tasks = 150 calls');
  assert.equal(selectTasks(GOLDEN_TASKS, 14, 280).length, GOLDEN_TASKS.length, '14 x 15 = 210');
  const tight = selectTasks(GOLDEN_TASKS, 30, 280);
  assert.equal(tight.length, 9, '280 / 30 = 9');
  assert.equal(new Set(tight.map((t) => t.category)).size, 9, 'nine different categories');
  for (const n of [1, 5, 14, 20, 40, 100]) assert.ok(selectTasks(GOLDEN_TASKS, n, DEFAULT_MAX_CALLS).length * n <= DEFAULT_MAX_CALLS, `${n} models`);
  assert.deepEqual(selectTasks(GOLDEN_TASKS, 0, 100), []);
  assert.equal(selectTasks(GOLDEN_TASKS, 1000, 280).length, 0);
  assert.ok(DEFAULT_MAX_CALLS <= 300);
});

// ---------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------

const NOW = () => new Date('2026-10-18T12:00:00Z');
/** A model that answers every task with its reference answer, except the ids listed. */
const solver = (id, { model = `${id}-model`, wrongOn = [], throwOn = null, calls = [] } = {}) => ({
  id, model, kind: 'chat',
  ask: async (prompt) => {
    calls.push(prompt);
    const task = GOLDEN_TASKS.find((t) => t.prompt === prompt);
    if (throwOn && throwOn(task)) throw throwOn(task);
    return { text: wrongOn.includes(task.id) ? task.wrong : task.reference, model, tokensIn: 10, tokensOut: 5 };
  },
});

test('RO3 run: it scores each model by category, with the share that passed and the number of tasks run', async () => {
  const calls = [];
  const result = await runEval({ targets: [solver('groq', { wrongOn: ['code-sum-evens'], calls }), solver('together', { calls })], now: NOW });
  assert.equal(result.calls, GOLDEN_TASKS.length * 2);
  assert.equal(calls.length, result.calls);
  const row = (provider, category) => result.rows.find((r) => r.provider === provider && r.category === category);
  assert.deepEqual([row('groq', 'code-generation').score, row('groq', 'code-generation').tasks_run], [0.5, 2], 'one of two code-generation tasks failed');
  assert.equal(row('groq', 'architecture').score, 1);
  assert.equal(row('together', 'code-generation').score, 1);
  assert.equal(result.rows.filter((r) => r.provider === 'groq').length, ASPECT_CATEGORIES.length);
  assert.ok(result.rows.every((r) => r.eval_version === EVAL_VERSION && r.run_at === '2026-10-18T12:00:00.000Z'));
});

test('RO3 run: a provider error is not a wrong answer. The model stops, and its tasks that did not run are left out', async () => {
  let n = 0;
  const limited = solver('groq', { throwOn: () => { n += 1; return n > 4 ? Object.assign(new Error('x'), { status: 429, code: 'RATE_LIMITED' }) : null; } });
  const result = await runEval({ targets: [limited, solver('together')], now: NOW });
  const groq = result.rows.filter((r) => r.provider === 'groq');
  assert.equal(groq.reduce((a, r) => a + r.tasks_run, 0), 4, 'only the 4 answered tasks count');
  assert.ok(groq.every((r) => r.score === 1), 'no zero from a rate limit');
  assert.equal(result.calls, 5 + GOLDEN_TASKS.length, 'it stopped at the 5th call');
  const dead = await runEval({ targets: [solver('groq', { throwOn: () => Object.assign(new Error('x'), { status: 401 }) })], now: NOW });
  assert.deepEqual(dead.rows, [], 'a rejected key gives no score at all');
});

test('RO3 run: it stays inside the call budget, skips agents and providers with no key, and reports each call to the ledger', async () => {
  const usage = new UsageReporter({ workerUrl: 'https://w.example', token: 'T'.repeat(30), now: NOW });
  const targets = [solver('groq'), solver('together'), { id: 'hermes_1', model: 'hermes-agent', kind: 'list' }, { id: 'gemini', model: null, kind: 'none', skip: 'no_key' }];
  const result = await runEval({ targets, maxCalls: 20, usage, now: NOW });
  assert.ok(result.calls <= 20);
  assert.equal(result.tasksPerModel, 10, '20 calls / 2 models');
  assert.deepEqual(result.skipped, [{ provider: 'hermes_1', reason: 'agent' }, { provider: 'gemini', reason: 'no_key' }]);
  assert.deepEqual(usage.batch().map((r) => [r.provider, r.requests]).sort(), [['groq', 10], ['together', 10]]);
  const tight = await runEval({ targets: [solver('groq')], maxCalls: 3, now: NOW });
  assert.equal(tight.calls, 3);
});

test('RO3 mirror: the public mirror has the shape of contract v1 and passes the strict state check', async () => {
  const result = await runEval({ targets: [solver('groq')], now: NOW });
  const mirror = evalMirror(result.rows, NOW());
  assert.deepEqual(Object.keys(mirror), ['contract', 'generated_at', 'eval_version', 'models']);
  assert.deepEqual(Object.keys(mirror.models['groq-model']['code-generation']), ['score', 'tasks_run', 'run_at', 'eval_version']);
  assert.deepEqual(checkStateFile('ops/eval.json', Buffer.from(JSON.stringify(mirror))), []);
  assert.ok(!JSON.stringify(mirror).includes('function'), 'no answer text');
});

// ---------------------------------------------------------------------
// The capability cache and the router
// ---------------------------------------------------------------------

test('RO3 cache: scores go to the record of the provider, OpenCode models have their own record, and agents are left out', () => {
  assert.equal(capabilityIdFor('groq', 'llama'), 'phase2:groq');
  assert.equal(capabilityIdFor('custom_2', 'x'), 'phase2:custom_2');
  assert.equal(capabilityIdFor('opencode', 'mimo-v2.5-free'), 'mimo-v2.5-free');
  assert.equal(capabilityIdFor('opencode', '*'), null);
  assert.equal(capabilityIdFor('hermes_1', 'hermes-agent'), null);
  const dir = mkdtempSync(join(tmpdir(), 'titan-cap-'));
  try {
    const registry = new CapabilityRegistry(join(dir, 'agents.json'));
    const rows = [
      { provider: 'groq', model: 'llama', category: 'research', score: 0.5, tasks_run: 2, run_at: '2026-10-18T12:00:00.000Z', eval_version: 'v1' },
      { provider: 'hermes_1', model: 'hermes-agent', category: 'research', score: 1, tasks_run: 2, run_at: '2026-10-18T12:00:00.000Z', eval_version: 'v1' },
      { provider: 'groq', model: 'llama', category: 'not-a-category', score: 1, tasks_run: 1, run_at: '2026-10-18T12:00:00.000Z', eval_version: 'v1' },
    ];
    assert.equal(feedCapabilityCache(rows, registry), 1);
    const again = new CapabilityRegistry(join(dir, 'agents.json'));
    assert.deepEqual(again.get('phase2:groq').measured, { research: { score: 0.5, tasksRun: 2, runAt: '2026-10-18T12:00:00.000Z', evalVersion: 'v1' } });
    // A re-probe keeps the measured scores.
    again.setRecord({ ...again.get('phase2:groq'), measured: undefined, strengths: ['research'] });
    assert.ok(again.get('phase2:groq').measured.research);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RO3 router: a measured score beats an assumed strength for its category, and the lists still decide where nothing was measured', () => {
  const pools = { p: { inFlight: 0, maxConcurrency: 4 } };
  const candidates = [{ modelId: 'assumed', pool: 'p' }, { modelId: 'measured', pool: 'p' }];
  const m = (score, tasksRun = 3) => ({ research: { score, tasksRun, runAt: 'x', evalVersion: 'v1' } });
  const records = {
    // Believed strong at research, but the eval says it fails.
    assumed: { modelId: 'assumed', pool: 'p', strengths: ['research', 'testing'], weaknesses: [], latencyClass: 'fast', observed: {}, measured: m(0) },
    // Not listed as strong, but the eval says it is perfect.
    measured: { modelId: 'measured', pool: 'p', strengths: [], weaknesses: [], latencyClass: 'slow', observed: {}, measured: m(1) },
  };
  const registry = { get: (id) => records[id] };
  const research = rankModels({ aspect: 'research' }, candidates, { pools, capabilityRegistry: registry });
  assert.deepEqual(research.map((r) => r.modelId), ['measured', 'assumed']);
  assert.equal(research[0].score, 100);
  assert.equal(research[1].score, -50, 'a measured 0.0 scores like a weakness');
  assert.match(research[0].reason, /measured 100% on the "research" eval, 3 tasks/);
  const testing = rankModels({ aspect: 'testing' }, candidates, { pools, capabilityRegistry: registry });
  assert.equal(testing[0].modelId, 'assumed', 'testing was not measured, so the assumed strength decides');
  assert.equal(testing[0].score, 100);
  const half = rankModels({ aspect: 'research' }, [candidates[1]], { pools, capabilityRegistry: { get: () => ({ ...records.measured, measured: m(0.5) }) } });
  assert.equal(half[0].score, 0, '0.5 scores zero');
  const noRuns = rankModels({ aspect: 'research' }, [candidates[0]], { pools, capabilityRegistry: { get: () => ({ ...records.assumed, measured: m(0, 0) }) } });
  assert.equal(noRuns[0].score, 100, 'a score from zero tasks is ignored');
});
