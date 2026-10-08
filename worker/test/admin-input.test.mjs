// Covers the input checks and the secret handling on the Worker's two admin write routes (Wave 11 audit, updated in Wave 12):
// POST /tasks and POST /admin/keys. A provider key goes to GitHub as a sealed box and is never sent back to the browser,
// never logged, and never accepted when it is oversized or not one printable token. Network and database are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { MAX_PROVIDER_KEY_LENGTH, checkProviderKeyValue } from '../src/keys.js';
import { parseTaskType } from '../src/tasks.js';
import { ADMIN, FAKE_GROQ_KEY, FakeWorld, authed, captureConsole, post } from './helpers/world.mjs';

function setup(t) {
  const world = new FakeWorld().install(t);
  world.providers.host('api.groq.com').valid.add(FAKE_GROQ_KEY);
  return { world, env: world.env() };
}

test('parseTaskType accepts routing words and rejects the rest', () => {
  assert.deepEqual(parseTaskType(undefined), { value: 'auto' });
  assert.deepEqual(parseTaskType('  '), { value: 'auto' });
  assert.deepEqual(parseTaskType(' Groq '), { value: 'groq' });
  assert.deepEqual(parseTaskType('code-review_2'), { value: 'code-review_2' });
  for (const bad of ['has space', 'semi;colon', '"quote', '../x', '-lead', 'x'.repeat(41), '\u0000', 'é']) {
    assert.ok('error' in parseTaskType(bad), `should reject ${JSON.stringify(bad)}`);
  }
  assert.ok('error' in parseTaskType(7));
  assert.ok('error' in parseTaskType({}));
  assert.match(parseTaskType('osint').error, /reserved/);
  assert.match(parseTaskType('Meta-Lesson').error, /reserved/);
});

test('checkProviderKeyValue takes one printable token up to the cap', () => {
  assert.equal(checkProviderKeyValue(FAKE_GROQ_KEY), null);
  assert.equal(checkProviderKeyValue('a'.repeat(MAX_PROVIDER_KEY_LENGTH)), null);
  assert.match(checkProviderKeyValue('a'.repeat(MAX_PROVIDER_KEY_LENGTH + 1)), /too long/);
  assert.match(checkProviderKeyValue(''), /required/);
  for (const bad of ['two words', 'tab\there', 'line\nbreak', 'nul\u0000', 'bell\u0007', 'café', 'quote"inside\r']) {
    assert.ok(checkProviderKeyValue(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('both write routes refuse a request with no token or a wrong token, before touching anything', async (t) => {
  const { world, env } = setup(t);
  for (const path of ['/tasks', '/admin/keys']) {
    for (const headers of [{}, { 'X-Titan-Auth': 'wrong' }, { 'X-Titan-Auth': `${ADMIN}x` }, { 'X-Titan-Auth': '' }]) {
      const res = await worker.fetch(post(path, { brief: 'x', provider: 'groq', value: FAKE_GROQ_KEY }, headers), env);
      assert.equal(res.status, 401, `${path} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(world.trail().length, 0, 'no network call');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subagents').first()).n, 0);
});

test('a Worker with no admin token configured refuses everything, even an empty header', async (t) => {
  const { env } = setup(t);
  const res = await worker.fetch(post('/tasks', { brief: 'x' }, { 'X-Titan-Auth': '' }), { ...env, TITAN_ADMIN_TOKEN: undefined });
  assert.equal(res.status, 401);
});

test('POST /tasks stores a clean task type, and refuses a bad or reserved one without writing', async (t) => {
  const { env } = setup(t);
  const ok = await worker.fetch(post('/tasks', { brief: 'do a thing', task_type: ' Gemini ' }, authed), env);
  assert.equal(ok.status, 200);
  const none = await worker.fetch(post('/tasks', { brief: 'do a thing' }, authed), env);
  assert.equal(none.status, 200);
  const types = (await env.DB.prepare('SELECT task_type FROM subagents ORDER BY queued_at').all()).results.map((r) => r.task_type).sort();
  assert.deepEqual(types, ['auto', 'gemini']);
  for (const task_type of ['osint', 'meta-lesson', 'a b', 'x'.repeat(200), 5]) {
    const res = await worker.fetch(post('/tasks', { brief: 'do a thing', task_type }, authed), env);
    assert.equal(res.status, 400, JSON.stringify(task_type));
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM subagents').first()).n, 2, 'refused tasks write nothing');
  assert.equal((await worker.fetch(post('/tasks', '{not json', authed), env)).status, 400);
  assert.equal((await worker.fetch(post('/tasks', { task_type: 'groq' }, authed), env)).status, 400);
});

test('POST /admin/keys seals the key for GitHub and never sends it back', async (t) => {
  const { world, env } = setup(t);
  const res = await worker.fetch(post('/admin/keys', { provider: 'GROQ', value: ` ${FAKE_GROQ_KEY} ` }, authed), env);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'groq');
  assert.equal(body.secretName, 'GROQ_API_KEY');
  assert.ok(!text.includes(FAKE_GROQ_KEY), 'the response never holds the key');
  assert.equal(world.github.open('GROQ_API_KEY'), FAKE_GROQ_KEY, 'the sealed value opens to the exact trimmed key');
  assert.ok(!JSON.stringify(env.DB.dump()).includes(FAKE_GROQ_KEY), 'D1 never holds the key');
});

test('a GitHub failure on the way never puts the key in the response or the logs', async (t) => {
  const { world, env } = setup(t);
  const logs = captureConsole(t);
  world.github.fail.publicKey = 401;
  const res = await worker.fetch(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY }, authed), env);
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes(FAKE_GROQ_KEY));
  assert.ok(!logs().includes(FAKE_GROQ_KEY));
});

test('an oversized, spaced, or control-character key is refused before any network call, and the error does not repeat it', async (t) => {
  const { world, env } = setup(t);
  for (const value of ['k'.repeat(MAX_PROVIDER_KEY_LENGTH + 1), 'two words here', `${FAKE_GROQ_KEY}\n`.repeat(3), `${FAKE_GROQ_KEY}\u0000`]) {
    const res = await worker.fetch(post('/admin/keys', { provider: 'groq', value }, authed), env);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes(FAKE_GROQ_KEY));
    assert.ok(text.length < 300);
  }
  assert.equal(world.trail().length, 0);
});

test('an unknown provider is refused and the error does not carry the value', async (t) => {
  const { env } = setup(t);
  const res = await worker.fetch(post('/admin/keys', { provider: 'nope', value: FAKE_GROQ_KEY }, authed), env);
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes(FAKE_GROQ_KEY));
});
