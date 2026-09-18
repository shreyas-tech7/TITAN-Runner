import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, summarizeChecks } from '../src/verify/checks.js';
import { acceptanceCriteria, pickJudgeProvider, buildJudgeMessages, parseJudgeVerdict, askJudge } from '../src/verify/judge.js';
import { verifyRun } from '../src/verify/verify.js';
import { remediationTargets } from '../src/engine/orchestrate.js';

const step = (id, aspect, state = 'complete', extra = {}) => [id, { id, title: `Step ${id}`, aspect, state, output: 'ok output', attempts: [{ modelId: 'phase2:groq', ok: true }], dependsOn: [], ...extra }];
const file = (path, content, sourceTaskId = 'code') => ({ path, content, sourceTaskId, conflict: false });
const graph = { sharedContext: '', tasks: [{ id: 'plan', title: 'Plan', aspect: 'architecture', deliverable: 'a plan', dependsOn: [] }, { id: 'code', title: 'Code', aspect: 'code-generation', deliverable: 'src/x.js', dependsOn: ['plan'] }, { id: 'docs', title: 'Docs', aspect: 'documentation', deliverable: 'README', dependsOn: ['code'] }] };

test('deterministic checks pass a clean run and point at the step behind each failure', () => {
  const good = runChecks({ graph, synthesis: { files: [file('src/x.js', 'export const x = 1;\n'), file('data.json', '{"a":1}')], conflicts: [] }, tasksById: new Map([step('plan', 'architecture'), step('code', 'code-generation')]) });
  assert.equal(summarizeChecks(good).ok, true, JSON.stringify(good.filter((c) => !c.ok)));
  assert.ok(good.find((c) => c.id === 'js-syntax').ok);

  const bad = runChecks({
    graph,
    synthesis: { files: [file('src/x.js', 'export const = ;\n'), file('empty.txt', '   '), file('stub.js', '// TODO: implement\n'), file('cfg.json', '{nope'), file('key.txt', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab')], conflicts: [{ path: 'a', versions: [{ taskId: 'code' }, { taskId: 'plan' }] }] },
    tasksById: new Map([step('plan', 'architecture'), step('code', 'code-generation'), step('other', 'code-generation', 'failed'), step('lonely', 'code-generation')]),
  });
  const failed = Object.fromEntries(bad.filter((c) => !c.ok).map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(failed).sort(), ['code-steps-produced', 'files-non-empty', 'js-syntax', 'json-parses', 'no-conflicts', 'no-placeholders', 'no-secrets', 'steps-complete']);
  assert.equal(failed['no-conflicts'].severity, 'warn', 'a resolved conflict warns, it does not fail');
  assert.deepEqual(summarizeChecks(bad).warned, ['no-conflicts']);
  assert.deepEqual(failed['steps-complete'].steps, ['other']);
  assert.deepEqual(failed['code-steps-produced'].steps, ['lonely']);
  assert.deepEqual(failed['js-syntax'].steps, ['code']);
  assert.match(failed['js-syntax'].detail, /SyntaxError/);
  assert.equal(summarizeChecks(bad).ok, false);
});

test('the judge is a provider that produced no step; the prompt carries the criteria, steps, and files; the verdict parses strictly', () => {
  const tasksById = new Map([step('plan', 'architecture', 'complete', { attempts: [{ modelId: 'phase2:groq' }] }), step('code', 'code-generation', 'complete', { attempts: [{ modelId: 'phase2:together' }, { modelId: 'phase2:openrouter' }] })]);
  assert.equal(pickJudgeProvider(tasksById), 'gemini');
  assert.equal(pickJudgeProvider(tasksById, ['groq', 'together']), null);
  const criteria = acceptanceCriteria({ title: 'Build it', prompt: 'p' }, graph);
  assert.equal(criteria.length, graph.tasks.length + 2);
  const messages = buildJudgeMessages({ task: { id: 't', title: 'Build it', prompt: 'p' }, graph, synthesis: { files: [file('src/x.js', 'export const x = 1;')] }, tasksById, checks: [] });
  assert.match(messages[0].content, /^You are the verifier/);
  assert.match(messages[1].content, /^VERIFY:/);
  assert.ok(messages[1].content.includes('src/x.js') && messages[1].content.includes('Step code'));
  assert.deepEqual(parseJudgeVerdict('```json\n{"verdict":"FAIL","reason":"stub","issues":[{"step":"code","problem":"empty"}]}\n```'), { verdict: 'fail', reason: 'stub', issues: [{ step: 'code', problem: 'empty' }] });
  assert.deepEqual(parseJudgeVerdict('{"verdict":"pass","reason":"good"}').issues, []);
  assert.equal(parseJudgeVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseJudgeVerdict('not json'), null);
});

test('askJudge never throws: an unreachable or unparsable judge is reported as no verdict', async () => {
  const run = { task: { id: 't', title: 'x', prompt: 'p' }, graph, synthesis: { files: [] }, tasksById: new Map([step('code', 'code-generation')]), checks: [] };
  const down = await askJudge({ run, provider: 'gemini', chat: async () => { throw new Error('503'); } });
  assert.deepEqual([down.verdict, down.error], [null, '503']);
  const garbage = await askJudge({ run, provider: 'gemini', chat: async () => ({ text: 'hmm', service: 'gemini' }) });
  assert.equal(garbage.verdict, null);
  const good = await askJudge({ run, provider: 'gemini', chat: async (msgs, opts) => ({ text: `{"verdict":"pass","reason":"fine ${opts.service}"}`, service: opts.service }) });
  assert.deepEqual([good.verdict, good.provider, good.reason], ['pass', 'gemini', 'fine gemini']);
});

test('verifyRun: failed checks skip the judge; passed checks ask the judge; no judge means unjudged (or fail under strict)', async () => {
  const task = { id: 't', title: 'x', prompt: 'p' };
  const okSynth = { files: [file('src/x.js', 'export const x = 1;\n')], conflicts: [] };
  const tasksById = new Map([step('plan', 'architecture'), step('code', 'code-generation')]);
  let judgeCalls = 0;
  const chat = async (msgs, opts) => { judgeCalls += 1; return { text: '{"verdict":"fail","reason":"missing tests","issues":[{"step":"code","problem":"no tests"}]}', service: opts.service }; };

  const failedChecks = await verifyRun({ task, graph, synthesis: { files: [], conflicts: [] }, tasksById, judge: { enabled: true, chat }, checkSyntax: false });
  assert.equal(failedChecks.verdict, 'fail');
  assert.equal(judgeCalls, 0, 'no judge on a certain failure');
  assert.deepEqual(failedChecks.issues.map((i) => i.step), ['code']);

  const judged = await verifyRun({ task, graph, synthesis: okSynth, tasksById, judge: { enabled: true, chat }, checkSyntax: false });
  assert.deepEqual([judged.verdict, judged.unjudged, judged.judge.provider, judgeCalls], ['fail', false, 'together', 1]);
  assert.deepEqual(judged.issues, [{ step: 'code', problem: 'no tests' }]);

  const unjudged = await verifyRun({ task, graph, synthesis: okSynth, tasksById, judge: { enabled: false }, checkSyntax: false });
  assert.deepEqual([unjudged.verdict, unjudged.unjudged], ['pass', true]);
  const strict = await verifyRun({ task, graph, synthesis: okSynth, tasksById, judge: { enabled: true, chat: async () => { throw new Error('down'); }, strict: true }, checkSyntax: false });
  assert.deepEqual([strict.verdict, strict.unjudged], ['fail', true]);
});

test('remediation targets: the named steps plus everything downstream, else every code step', () => {
  assert.deepEqual([...remediationTargets(graph, [{ step: 'code', problem: 'x' }])].sort(), ['code', 'docs']);
  assert.deepEqual([...remediationTargets(graph, [{ step: 'plan', problem: 'x' }])].sort(), ['code', 'docs', 'plan']);
  assert.deepEqual([...remediationTargets(graph, [{ step: null, problem: 'x' }])].sort(), ['code', 'docs']);
  assert.deepEqual([...remediationTargets(graph, [{ step: 'ghost', problem: 'x' }])].sort(), ['code', 'docs']);
  assert.deepEqual([...remediationTargets({ tasks: [{ id: 'only', aspect: 'research', dependsOn: [] }] }, [])], ['only']);
});
