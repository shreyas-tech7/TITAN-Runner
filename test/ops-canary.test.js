import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANARY_EXPECTED_SUM, SLOW_MS, describeError, healthMirror, judgeAnswer, judgeError, probeTarget, runCanary,
} from '../src/ops/canary.js';
import { buildTargets } from '../src/ops/canaryTargets.js';
import { UsageReporter } from '../src/ops/usageReporter.js';
import { PROVIDERS } from '../src/providers/catalog.js';
import { checkStateFile } from '../scripts/check-state.mjs';

const NOW = () => new Date('2026-10-12T08:00:00Z');
const noSleep = async () => {};
/** A clock that answers the given values in order, and then repeats the last one. */
const stepClock = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };
const chatTarget = (call, over = {}) => ({ id: 'groq', model: 'llama', kind: 'chat', call, ...over });
const ok = (text = '{"sum": 42}') => async () => ({ text, model: 'llama', tokensIn: 20, tokensOut: 6 });
const deps = (over = {}) => ({ now: NOW, sleep: noSleep, ...over });
const fail = (props) => async () => { throw Object.assign(new Error('boom'), props); };

test('RO2 judge: the right sum in valid JSON passes, in a fence or after other text too', () => {
  for (const text of ['{"sum": 42}', '{"sum":42}', '```json\n{"sum": 42}\n```', 'Thinking...\n{"sum": 42}', '{"sum": "42"}', ' \n{"sum": 42.0}\n']) assert.deepEqual(judgeAnswer(text), { ok: true, errorClass: null }, text);
  assert.equal(CANARY_EXPECTED_SUM, 42);
});

test('RO2 judge: a wrong sum is wrong_answer, and text that is not the JSON is bad_format', () => {
  for (const text of ['{"sum": 41}', '{"sum": 420}', '{"sum": true}', '{"sum": null}']) assert.deepEqual(judgeAnswer(text), { ok: false, errorClass: 'wrong_answer' }, text);
  for (const text of ['42', 'The sum is 42', '', undefined, '{"total": 42}', '[42]', '{sum: 42', '```\nnot json\n```']) assert.deepEqual(judgeAnswer(text), { ok: false, errorClass: 'bad_format' }, String(text));
});

test('RO2 judge: a 403 that names the model is model_invalid, and a plain 403 is still auth', () => {
  const e = (status, message) => Object.assign(new Error(message), { status });
  assert.deepEqual(judgeError(e(403, 'OpenRouter rejected the request (403): thinkingmachines/inkling-small:free is only available on agentic harnesses.')), { status: 'down', errorClass: 'model_invalid' });
  assert.equal(judgeError(e(403, 'The model requires terms acceptance. Please have the org admin accept the terms.')).errorClass, 'model_invalid');
  assert.equal(judgeError(e(403, 'Forbidden')).errorClass, 'auth');
  assert.equal(judgeError(e(401, 'This model is only available to paying users')).errorClass, 'auth', 'a 401 is always the key');
});

test('RO2 judge: errors map to a status and a class', () => {
  assert.deepEqual(judgeError(Object.assign(new Error('x'), { status: 429, code: 'RATE_LIMITED' })), { status: 'degraded', errorClass: 'rate_limited' });
  assert.deepEqual(judgeError(Object.assign(new Error('x'), { status: 401 })), { status: 'down', errorClass: 'auth' });
  assert.deepEqual(judgeError(Object.assign(new Error('x'), { status: 403 })), { status: 'down', errorClass: 'auth' });
  assert.deepEqual(judgeError(Object.assign(new Error('x'), { status: 402 })), { status: 'down', errorClass: 'quota' });
  assert.deepEqual(judgeError(Object.assign(new Error('x'), { status: 404 })), { status: 'down', errorClass: 'model_invalid' });
  assert.equal(judgeError(Object.assign(new Error('x'), { status: 503 })).status, 'down');
  assert.equal(judgeError(new Error('socket closed')).status, 'down');
});

test('RO2 status: healthy when the answer is right, the JSON is valid, and the call is fast', async () => {
  const r = await probeTarget(chatTarget(ok()), deps({ clock: stepClock(0, 420) }));
  assert.deepEqual(r, { provider: 'groq', model: 'llama', status: 'healthy', latency_ms: 420, checked_at: '2026-10-12T08:00:00.000Z', error_class: null, detail: null });
});

test('RO2 status: degraded when the call is slow, the format is wrong, or the answer is wrong', async () => {
  const slow = await probeTarget(chatTarget(ok()), deps({ clock: stepClock(0, SLOW_MS + 1) }));
  assert.deepEqual([slow.status, slow.error_class], ['degraded', 'slow']);
  const format = await probeTarget(chatTarget(ok('The answer is forty-two')), deps());
  assert.deepEqual([format.status, format.error_class], ['degraded', 'bad_format']);
  const wrong = await probeTarget(chatTarget(ok('{"sum": 40}')), deps());
  assert.deepEqual([wrong.status, wrong.error_class], ['degraded', 'wrong_answer']);
  const limited = await probeTarget(chatTarget(fail({ status: 429, code: 'RATE_LIMITED' })), deps());
  assert.deepEqual([limited.status, limited.error_class], ['degraded', 'rate_limited']);
});

test('RO2 status: a first failure that works on the second try is degraded and flaky, and a double failure is down', async () => {
  let n = 0;
  const flaky = await probeTarget(chatTarget(async () => { n += 1; if (n === 1) throw Object.assign(new Error('x'), { status: 503 }); return { text: '{"sum": 42}', model: 'llama' }; }), deps());
  assert.deepEqual([flaky.status, flaky.error_class, n], ['degraded', 'flaky', 2]);
  let m = 0;
  const wrongThenRight = await probeTarget(chatTarget(async () => { m += 1; return { text: m === 1 ? 'nope' : '{"sum": 42}', model: 'llama' }; }), deps());
  assert.deepEqual([wrongThenRight.status, wrongThenRight.error_class], ['degraded', 'flaky']);
  let k = 0;
  const down = await probeTarget(chatTarget(async () => { k += 1; throw Object.assign(new Error('x'), { status: 503 }); }), deps());
  assert.deepEqual([down.status, down.error_class, k], ['down', 'provider_down', 2]);
  assert.equal((await probeTarget(chatTarget(fail({ code: 'ECONNREFUSED' })), deps())).status, 'down');
});

test('RO2 status: a rejected key, a spent quota, and a bad model are down at once, with no second try', async () => {
  for (const [props, errorClass] of [[{ status: 401 }, 'auth'], [{ status: 402 }, 'quota'], [{ status: 404 }, 'model_invalid']]) {
    let n = 0;
    const r = await probeTarget(chatTarget(async () => { n += 1; throw Object.assign(new Error('x'), props); }), deps());
    assert.deepEqual([r.status, r.error_class, n], ['down', errorClass, 1], errorClass);
  }
});

test('RO2 status: no key is not_configured, and Freebuff has no public API', async () => {
  const none = await probeTarget({ id: 'together', model: null, kind: 'none', skip: 'no_key' }, deps());
  assert.deepEqual([none.status, none.error_class, none.latency_ms, none.model], ['not_configured', 'no_key', null, '*']);
  const freebuff = await probeTarget({ id: 'freebuff', model: null, kind: 'none', skip: 'no_public_api' }, deps());
  assert.deepEqual([freebuff.status, freebuff.error_class], ['not_configured', 'no_public_api']);
});

test('RO2 hermes: the agent only lists models and gets no prompt', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, method: init?.method ?? 'GET', body: init?.body }); return new Response(JSON.stringify({ data: [{ id: 'hermes-agent' }] }), { status: 200 }); };
  const targets = await buildTargets({
    env: { HERMES_1_BASE_URL: 'https://hermes.example.com/', HERMES_1_API_KEY: 'k'.repeat(30) },
    only: ['hermes_1', 'hermes_2'], fetchImpl, isConfigured: (id) => id === 'hermes_1', makeAdapter: async () => { throw new Error('no adapter call'); },
  });
  assert.deepEqual(targets.map((t) => [t.id, t.kind]), [['hermes_1', 'list'], ['hermes_2', 'none']]);
  const r = await probeTarget(targets[0], deps());
  assert.equal(r.status, 'healthy');
  assert.deepEqual(calls.map((c) => [c.url, c.method, c.body]), [['https://hermes.example.com/v1/models', 'GET', undefined]]);
  const refused = await probeTarget({ ...targets[0], call: async () => { throw Object.assign(new Error('x'), { status: 401 }); } }, deps());
  assert.deepEqual([refused.status, refused.error_class], ['down', 'auth']);
});

test('RO2 coverage: there is one target for every provider of the catalog, and an empty environment makes each one not_configured', async () => {
  const targets = await buildTargets({ env: {}, isConfigured: () => false });
  assert.deepEqual(targets.map((t) => t.id).sort(), PROVIDERS.map((p) => p.id).sort());
  assert.ok(targets.every((t) => t.kind === 'none'));
  assert.equal(targets.find((t) => t.id === 'freebuff').skip, 'no_public_api');
  assert.ok(targets.filter((t) => t.id !== 'freebuff').every((t) => t.skip === 'no_key'));
});

test('RO2 coverage: a configured provider gets the fixed task, with a low temperature and few tokens', async () => {
  const seen = [];
  const adapter = { model: 'llama', chat: async (messages, opts) => { seen.push({ messages, opts }); return { text: '{"sum": 42}', model: 'llama' }; } };
  const targets = await buildTargets({ env: {}, only: ['groq'], isConfigured: () => true, makeAdapter: async () => adapter });
  const r = await probeTarget(targets[0], deps());
  assert.equal(r.status, 'healthy');
  assert.equal(seen[0].messages.length, 1);
  assert.match(seen[0].messages[0].content, /17 and 25/);
  assert.deepEqual([seen[0].opts.maxTokens, seen[0].opts.temperature], [64, 0]);
});

test('RO2 run: it probes each target in turn, reports usage, and builds the mirror of contract v1 that passes the strict state check', async () => {
  const usage = new UsageReporter({ workerUrl: 'https://w.example', token: 'T'.repeat(30), now: NOW });
  const results = await runCanary([
    chatTarget(ok()), { id: 'together', model: null, kind: 'none', skip: 'no_key' }, chatTarget(fail({ status: 401 }), { id: 'gemini', model: 'gemini-flash' }),
  ], deps({ usage, clock: stepClock(0, 100) }));
  assert.deepEqual(results.map((r) => [r.provider, r.status]), [['groq', 'healthy'], ['together', 'not_configured'], ['gemini', 'down']]);
  assert.deepEqual(usage.batch().map((r) => [r.provider, r.status, r.requests]).sort(), [['gemini', 'error', 1], ['groq', 'ok', 1]]);
  const mirror = healthMirror(results, NOW());
  assert.equal(mirror.contract, '1');
  assert.deepEqual(Object.keys(mirror.providers), ['gemini', 'groq', 'together']);
  assert.deepEqual(Object.keys(mirror.providers.groq.llama), ['status', 'latency_ms', 'checked_at', 'error_class']);
  assert.deepEqual(checkStateFile('ops/health.json', Buffer.from(JSON.stringify(mirror))), []);
  assert.ok(!JSON.stringify(mirror).includes('sum'), 'no answer text in the mirror');
});

test('RO2 detail: a failed probe keeps a short redacted error text for the log, and the mirror never holds it', async () => {
  const secret = ['gsk', 'Fake'.repeat(8)].join('_'); // built at run time, so the file holds no key shape
  const err = Object.assign(new Error(`Groq rejected the request (400): The model \`orpheus\`\nrequires terms acceptance. key ${secret}`), { status: 404 });
  const r = await probeTarget(chatTarget(async () => { throw err; }), deps({ clock: stepClock(0, 90) }));
  assert.equal(r.status, 'down');
  assert.match(r.detail, /^Groq rejected the request \(400\): The model `orpheus` requires terms acceptance\./, 'one line, from the provider');
  assert.ok(!r.detail.includes(secret), 'the secret is cut out');
  assert.ok(r.detail.length <= 160);
  const mirror = healthMirror([r], NOW());
  assert.ok(!JSON.stringify(mirror).includes('requires terms'), 'the detail is not in the mirror');
  assert.deepEqual(Object.keys(mirror.providers.groq.llama), ['status', 'latency_ms', 'checked_at', 'error_class']);
  assert.deepEqual(checkStateFile('ops/health.json', Buffer.from(JSON.stringify(mirror))), []);
  // A healthy probe, and a provider that is not set up, have no detail.
  assert.equal((await probeTarget(chatTarget(ok()), deps({ clock: stepClock(0, 90) }))).detail, null);
  assert.equal((await probeTarget({ id: 'together', model: null, kind: 'none', skip: 'no_key' }, deps())).detail, null);
  assert.equal(describeError(new Error('')), null);
  assert.equal(describeError(undefined), null);
});
