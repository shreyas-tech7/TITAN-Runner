/**
 * The Hermes agent cluster client (providers/hermes.js,
 * orchestrator/hermesCluster.js, `titan hermes`): configuration from env,
 * the specialization router, dispatch with failover, secret hygiene, and
 * isolation from the five-provider ledger. Zero network — `fetch` is a stub.
 * (The instances themselves do not exist yet; see docs/RUNTIME.md.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHermesInstances, rankInstances, HermesCluster, buildHermesMessages, MAX_HERMES_INSTANCES } from '../src/orchestrator/hermesCluster.js';
import { HermesProvider } from '../src/providers/hermes.js';
import { providerHealth } from '../src/providers/health.js';
import { ASPECT_CATEGORIES } from '../src/orchestrator/taxonomy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY1 = 'key-one-0123456789';
const KEY2 = 'key-two-0123456789';
const KEY3 = 'key-three-0123456789';

const ENV = {
  HERMES_1_BASE_URL: 'https://hermes-code.up.railway.app/',
  HERMES_1_API_KEY: KEY1,
  HERMES_1_SPECIALIZATION: 'code-generation, refactoring',
  HERMES_1_NAME: 'coder',
  HERMES_2_BASE_URL: 'https://hermes-research.up.railway.app',
  HERMES_2_API_KEY: KEY2,
  HERMES_2_SPECIALIZATION: 'research,documentation',
  HERMES_2_MODEL: 'hermes-3-test',
  HERMES_3_BASE_URL: 'https://hermes-general.up.railway.app',
  HERMES_3_API_KEY: KEY3,
  HERMES_3_CHAT_PATH: 'v1/custom/chat',
};

/** A stub fetch: records every request, answers per origin. */
function stubFetch(byOrigin) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ origin: u.origin, path: u.pathname, headers: init.headers, body: JSON.parse(init.body) });
    const handler = byOrigin[u.origin];
    if (!handler) return new Response('{}', { status: 404 });
    return handler(init);
  };
  return { calls, fetchImpl };
}
const ok = (text, model) => () => new Response(JSON.stringify({ choices: [{ message: { content: text } }], ...(model ? { model } : {}), usage: { total_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code, body = '{"error":{"message":"nope"}}') => () => new Response(body, { status: code, headers: { 'content-type': 'application/json' } });

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

test('three instances load from HERMES_<N>_* with their own url, key, model, path, and specialization', () => {
  const { instances, warnings } = loadHermesInstances(ENV);
  assert.deepEqual(warnings, []);
  assert.equal(instances.length, 3);
  assert.deepEqual(instances.map((i) => [i.id, i.name, i.baseUrl, i.specialization]), [
    ['hermes-1', 'coder', 'https://hermes-code.up.railway.app', ['code-generation', 'refactoring']],
    ['hermes-2', 'hermes-2', 'https://hermes-research.up.railway.app', ['research', 'documentation']],
    ['hermes-3', 'hermes-3', 'https://hermes-general.up.railway.app', []],
  ]);
  assert.equal(instances[1].model, 'hermes-3-test');
  assert.equal(instances[2].chatPath, 'v1/custom/chat');
  assert.deepEqual(loadHermesInstances({}), { instances: [], warnings: [] });
  assert.equal(MAX_HERMES_INSTANCES, 3);
  assert.equal(loadHermesInstances({ ...ENV, HERMES_4_BASE_URL: 'https://x.example', HERMES_4_API_KEY: 'k' }).instances.length, 3, 'a fourth is ignored');
});

test('unsafe or incomplete instances are skipped with a warning that never contains a secret', () => {
  const env = {
    HERMES_1_BASE_URL: 'http://hermes.example.com', HERMES_1_API_KEY: KEY1,                       // plain http, not local
    HERMES_2_BASE_URL: 'https://user:pw-in-url@hermes.example.com', HERMES_2_API_KEY: KEY2,      // credentials in the URL
    HERMES_3_BASE_URL: 'https://hermes-3.example.com',                                         // no key
  };
  const { instances, warnings } = loadHermesInstances(env);
  assert.deepEqual(instances, []);
  assert.equal(warnings.length, 3);
  const all = warnings.join('\n');
  for (const secret of [KEY1, KEY2, 'pw-in-url']) assert.ok(!all.includes(secret), `warning leaked ${secret}`);
  assert.match(warnings[2], /HERMES_3_API_KEY is required/);

  // A placeholder is not a key; localhost over http is fine for development.
  assert.equal(loadHermesInstances({ HERMES_1_BASE_URL: 'https://h.example.com', HERMES_1_API_KEY: 'your_key_here' }).instances.length, 0);
  assert.equal(loadHermesInstances({ HERMES_1_BASE_URL: 'http://localhost:8642', HERMES_1_API_KEY: 'k' }).instances.length, 1);
  assert.equal(loadHermesInstances({ HERMES_1_BASE_URL: 'not a url', HERMES_1_API_KEY: 'k' }).instances.length, 0);
});

test('specialization accepts only real aspects; unknown ones are dropped with a warning; "any" means generalist', () => {
  const { instances, warnings } = loadHermesInstances({ HERMES_1_BASE_URL: 'https://h.example.com', HERMES_1_API_KEY: 'k', HERMES_1_SPECIALIZATION: 'Testing, bogus, any, testing, devops' });
  assert.deepEqual(instances[0].specialization, ['testing', 'devops']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"bogus" is not a known aspect/);
  for (const a of instances[0].specialization) assert.ok(ASPECT_CATEGORIES.includes(a));
});

/* -------------------------------------------------------------------------- */
/* The meta-router                                                             */
/* -------------------------------------------------------------------------- */

test('routing: a specialist for the aspect first, then generalists, then any other as a last resort', () => {
  const insts = loadHermesInstances(ENV).instances;
  assert.deepEqual(rankInstances('code-generation', insts).map((r) => r.id), ['hermes-1', 'hermes-3', 'hermes-2']);
  assert.deepEqual(rankInstances('research', insts).map((r) => r.id), ['hermes-2', 'hermes-3', 'hermes-1']);
  assert.deepEqual(rankInstances('devops', insts).map((r) => r.id), ['hermes-3', 'hermes-1', 'hermes-2'], 'nobody specialized: the generalist, then the rest in order');
  assert.deepEqual(rankInstances(undefined, insts).map((r) => r.id), ['hermes-3', 'hermes-1', 'hermes-2']);
  const reasons = Object.fromEntries(rankInstances('code-generation', insts).map((r) => [r.id, r.reason]));
  assert.match(reasons['hermes-1'], /specialized in code-generation/);
  assert.equal(reasons['hermes-3'], 'generalist');
  assert.match(reasons['hermes-2'], /last resort/);
});

test('routing: load breaks ties between equals, and an instance cooling down after failures drops behind', () => {
  const two = [{ id: 'a', specialization: ['testing'] }, { id: 'b', specialization: ['testing'] }];
  assert.deepEqual(rankInstances('testing', two).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(rankInstances('testing', two, { inFlight: new Map([['a', 3], ['b', 1]]) }).map((r) => r.id), ['b', 'a']);
  const cooled = rankInstances('testing', two, { coolingDown: new Set(['a']) });
  assert.deepEqual(cooled.map((r) => r.id), ['b', 'a']);
  assert.match(cooled[1].reason, /cooling down/);
});

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

test('dispatch sends the task to the specialist\'s own URL with ITS key, in the expected wire format', async () => {
  const { calls, fetchImpl } = stubFetch({
    'https://hermes-code.up.railway.app': ok('code result', 'hermes-code-model'),
    'https://hermes-research.up.railway.app': ok('research result'),
    'https://hermes-general.up.railway.app': ok('general result'),
  });
  const cluster = new HermesCluster({ env: ENV, fetchImpl });
  assert.equal(cluster.isConfigured(), true);

  const r = await cluster.dispatch({ id: 't1', title: 'Add a flag', aspect: 'code-generation', description: 'Add --json to the CLI.', deliverable: 'src/cli.js' }, { sharedContext: 'Node 20 project' });
  assert.deepEqual([r.ok, r.text, r.instance, r.model, r.error], [true, 'code result', 'hermes-1', 'hermes-code-model', null]);
  assert.equal(r.tried.length, 1);
  assert.equal(r.route[0].id, 'hermes-1');

  assert.equal(calls.length, 1, 'only the chosen instance was called');
  const c = calls[0];
  assert.deepEqual([c.origin, c.path], ['https://hermes-code.up.railway.app', '/v1/chat/completions']);
  assert.equal(c.headers.authorization, `Bearer ${KEY1}`, 'its own key, no other instance\'s');
  assert.equal(c.body.model, 'hermes-agent');
  assert.equal(c.body.stream, false);
  assert.equal(c.body.messages[0].role, 'system');
  assert.match(c.body.messages[1].content, /Task: Add a flag[\s\S]*Area: code-generation[\s\S]*Add --json[\s\S]*Deliverable: src\/cli\.js[\s\S]*Node 20 project/);

  // A research task goes to the other specialist (with its own model), a debugging task to the generalist (custom path).
  await cluster.dispatch({ id: 't2', title: 'Survey', aspect: 'research', description: 'x' });
  await cluster.dispatch({ id: 't3', title: 'Bug', aspect: 'debugging', description: 'x' });
  assert.deepEqual(calls.slice(1).map((x) => [x.origin, x.path, x.headers.authorization, x.body.model]), [
    ['https://hermes-research.up.railway.app', '/v1/chat/completions', `Bearer ${KEY2}`, 'hermes-3-test'],
    ['https://hermes-general.up.railway.app', '/v1/custom/chat', `Bearer ${KEY3}`, 'hermes-agent'],
  ]);
});

test('dispatch fails over to the next-best instance, reports every attempt, and leaks no key', async () => {
  const { calls, fetchImpl } = stubFetch({
    'https://hermes-code.up.railway.app': status(500, `{"error":{"message":"boom ${KEY1}"}}`),
    'https://hermes-general.up.railway.app': ok('rescued by the generalist'),
    'https://hermes-research.up.railway.app': ok('never reached'),
  });
  const cluster = new HermesCluster({ env: ENV, fetchImpl });
  const r = await cluster.dispatch({ id: 't', aspect: 'code-generation', description: 'x' });
  assert.deepEqual([r.ok, r.text, r.instance], [true, 'rescued by the generalist', 'hermes-3']);
  assert.deepEqual(r.tried.map((t) => [t.id, t.ok]), [['hermes-1', false], ['hermes-3', true]]);
  assert.equal(calls.length, 2, 'bounded: the third instance was not tried');
  assert.ok(!JSON.stringify(r).includes(KEY1), 'a key echoed by the upstream error is scrubbed');

  // Every attempt fails: a clean result, not a throw.
  const dead = new HermesCluster({ env: ENV, fetchImpl: stubFetch({ 'https://hermes-code.up.railway.app': status(503), 'https://hermes-general.up.railway.app': status(401), 'https://hermes-research.up.railway.app': status(503) }).fetchImpl });
  const f = await dead.dispatch({ id: 't', aspect: 'code-generation', description: 'x' });
  assert.deepEqual([f.ok, f.text, f.instance, f.error.code], [false, null, null, 'ALL_INSTANCES_FAILED']);
  assert.equal(f.tried.length, 2);
  assert.match(f.tried[1].error, /rejected the request \(401\)/);
  assert.deepEqual(new HermesCluster({ env: ENV, fetchImpl: stubFetch({}).fetchImpl }).route('research').map((x) => x.id), ['hermes-2', 'hermes-3', 'hermes-1']);
});

test('an instance that keeps failing is demoted for a while, then restored', async () => {
  let t = 1_000_000;
  const { fetchImpl } = stubFetch({
    'https://hermes-code.up.railway.app': status(500),
    'https://hermes-research.up.railway.app': ok('r'),
    'https://hermes-general.up.railway.app': ok('g'),
  });
  const cluster = new HermesCluster({ env: ENV, fetchImpl, now: () => t, cooldownMs: 60_000 });
  const task = { id: 't', aspect: 'code-generation', description: 'x' };
  assert.equal(cluster.route('code-generation')[0].id, 'hermes-1');
  await cluster.dispatch(task);
  assert.equal(cluster.route('code-generation')[0].id, 'hermes-1', 'one failure is not enough');
  await cluster.dispatch(task);
  const demoted = cluster.route('code-generation');
  assert.notEqual(demoted[0].id, 'hermes-1');
  assert.match(demoted.find((x) => x.id === 'hermes-1').reason, /cooling down/);
  t += 61_000;
  assert.equal(cluster.route('code-generation')[0].id, 'hermes-1', 'cooldown expired');
});

test('not configured, aborted, and unusable replies all come back as results, never exceptions', async () => {
  const empty = new HermesCluster({ env: {} });
  assert.equal(empty.isConfigured(), false);
  assert.deepEqual(empty.describe(), []);
  const r = await empty.dispatch({ id: 't', description: 'x' });
  assert.deepEqual([r.ok, r.error.code], [false, 'NOT_CONFIGURED']);

  const { fetchImpl } = stubFetch({ 'https://hermes-code.up.railway.app': ok('x'), 'https://hermes-research.up.railway.app': ok('x'), 'https://hermes-general.up.railway.app': ok('x') });
  const cluster = new HermesCluster({ env: ENV, fetchImpl });
  const ac = new AbortController();
  ac.abort();
  const aborted = await cluster.dispatch({ id: 't', description: 'x' }, { signal: ac.signal });
  assert.deepEqual([aborted.ok, aborted.error.code], [false, 'ABORTED']);

  const junk = new HermesCluster({ env: ENV, fetchImpl: stubFetch({ 'https://hermes-general.up.railway.app': () => new Response('{"unexpected":true}', { status: 200 }), 'https://hermes-code.up.railway.app': () => new Response('<html>', { status: 200 }), 'https://hermes-research.up.railway.app': status(500) }).fetchImpl });
  const j = await junk.dispatch({ id: 't', aspect: 'debugging', description: 'x' });
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'ALL_INSTANCES_FAILED');
});

test('describe() and ping() carry no secrets; ping reports each instance on its own', async () => {
  const { fetchImpl } = stubFetch({
    'https://hermes-code.up.railway.app': ok('pong', 'm1'),
    'https://hermes-research.up.railway.app': status(502),
    'https://hermes-general.up.railway.app': ok(`pong ${KEY3}`, 'm3'),
  });
  const cluster = new HermesCluster({ env: ENV, fetchImpl });
  const description = JSON.stringify(cluster.describe());
  for (const k of [KEY1, KEY2, KEY3]) assert.ok(!description.includes(k));
  assert.deepEqual(cluster.describe().map((d) => [d.id, d.origin, d.specialization]), [
    ['hermes-1', 'https://hermes-code.up.railway.app', ['code-generation', 'refactoring']],
    ['hermes-2', 'https://hermes-research.up.railway.app', ['research', 'documentation']],
    ['hermes-3', 'https://hermes-general.up.railway.app', ['generalist']],
  ]);
  const results = await cluster.ping();
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['hermes-1', true], ['hermes-2', false], ['hermes-3', true]]);
  assert.ok(!JSON.stringify(results).includes(KEY3), 'a key echoed in a reply is scrubbed');
});

test('a Hermes instance never touches the five-provider health ledger', async () => {
  const before = providerHealth.list().map((r) => r.id).sort();
  const { fetchImpl } = stubFetch({ 'https://hermes-code.up.railway.app': ok('ok'), 'https://hermes-research.up.railway.app': status(500), 'https://hermes-general.up.railway.app': status(500) });
  const cluster = new HermesCluster({ env: ENV, fetchImpl });
  await cluster.dispatch({ id: 't', aspect: 'code-generation', description: 'x' });
  await cluster.dispatch({ id: 't', aspect: 'research', description: 'x' });
  assert.deepEqual(providerHealth.list().map((r) => r.id).sort(), before);
  assert.ok(!providerHealth.list().some((r) => String(r.id).startsWith('hermes')));
});

test('HermesProvider is configured only with both a URL and a key, and normalises its path', () => {
  const base = { id: 'hermes-9', baseUrl: 'https://h.example.com//', apiKey: 'k' };
  assert.equal(new HermesProvider(base).isConfigured(), true);
  assert.equal(new HermesProvider({ ...base, apiKey: '' }).isConfigured(), false);
  assert.equal(new HermesProvider({ ...base, baseUrl: '' }).isConfigured(), false);
  const p = new HermesProvider({ ...base, chatPath: 'x/y' });
  assert.deepEqual([p.baseUrl, p.chatPath, p.model], ['https://h.example.com', '/x/y', 'hermes-agent']);
  assert.match(buildHermesMessages({ id: 'only-id' })[1].content, /^Task: only-id/);
});

/* -------------------------------------------------------------------------- */
/* The CLI                                                                     */
/* -------------------------------------------------------------------------- */

function titan(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'titan.js'), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

test('titan hermes status lists what is configured without any secret; ping refuses to run unconfigured or in dry-run', () => {
  const none = titan(['hermes', 'status', '--json']);
  assert.equal(none.code, 0);
  assert.deepEqual(JSON.parse(none.stdout.trim().split('\n').pop()), { configured: false, instances: [], warnings: [] });

  const some = titan(['hermes', 'status', '--json'], ENV);
  assert.equal(some.code, 0);
  for (const k of [KEY1, KEY2, KEY3]) assert.ok(!some.stdout.includes(k), 'status leaked a key');
  const out = JSON.parse(some.stdout.trim().split('\n').pop());
  assert.equal(out.configured, true);
  assert.equal(out.instances.length, 3);

  const text = titan(['hermes', 'status'], ENV);
  assert.match(text.stdout, /3 Hermes instance\(s\) configured/);
  assert.ok(!text.stdout.includes(KEY1));

  assert.equal(titan(['hermes', 'ping']).code, 1, 'nothing configured');
  const dry = titan(['hermes', 'ping', '--json'], { ...ENV, TITAN_DRY_RUN: '1' });
  assert.equal(dry.code, 1);
  assert.match(dry.stdout, /forbids network calls/);
  assert.equal(titan(['hermes', 'bogus']).code, 2);
});
