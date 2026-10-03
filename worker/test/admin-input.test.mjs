// Covers the input checks and the secret handling on the Worker's two admin write routes (Wave 11 audit):
// POST /tasks and POST /admin/keys. A provider key goes to GitHub as a sealed box and is never sent back
// to the browser, never logged, and never accepted when it is oversized or not one printable token.
// Network and database are stubbed. The fake key below is built from parts so no key-shaped literal is
// committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import sealedbox from 'tweetnacl-sealedbox-js';
import worker, { MAX_PROVIDER_KEY_LENGTH, checkProviderKeyValue, parseTaskType } from '../src/index.js';

const ADMIN = ['admin', 'token', 'for', 'tests', '0123456789'].join('-');
const FAKE_KEY = ['gsk', 'x'.repeat(8), 'FAKE', 'y'.repeat(24)].join('_');

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
}
const envWith = (over = {}) => ({ TITAN_ADMIN_TOKEN: ADMIN, GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_PAT: 'fake-pat', DB: fakeDb(), ...over });
const post = (path, body, headers = {}) =>
  new Request(`https://worker.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const authed = { 'X-Titan-Auth': ADMIN };

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
  assert.equal(checkProviderKeyValue(FAKE_KEY), null);
  assert.equal(checkProviderKeyValue('a'.repeat(MAX_PROVIDER_KEY_LENGTH)), null);
  assert.match(checkProviderKeyValue('a'.repeat(MAX_PROVIDER_KEY_LENGTH + 1)), /too long/);
  assert.match(checkProviderKeyValue(''), /required/);
  for (const bad of ['two words', 'tab\there', 'line\nbreak', 'nul\u0000', 'bell\u0007', 'café', 'quote"inside\r']) {
    assert.ok(checkProviderKeyValue(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('both write routes refuse a request with no token or a wrong token, before touching anything', async (t) => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched = true;
    throw new Error('no network on an unauthorized call');
  });
  const env = envWith();
  for (const path of ['/tasks', '/admin/keys']) {
    for (const headers of [{}, { 'X-Titan-Auth': 'wrong' }, { 'X-Titan-Auth': ADMIN + 'x' }, { 'X-Titan-Auth': '' }]) {
      const res = await worker.fetch(post(path, { brief: 'x', provider: 'groq', value: FAKE_KEY }, headers), env);
      assert.equal(res.status, 401, `${path} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(env.DB.calls.length, 0);
  assert.equal(fetched, false);
});

test('a Worker with no admin token configured refuses everything, even an empty header', async () => {
  const env = envWith({ TITAN_ADMIN_TOKEN: undefined });
  const res = await worker.fetch(post('/tasks', { brief: 'x' }, { 'X-Titan-Auth': '' }), env);
  assert.equal(res.status, 401);
});

test('POST /tasks stores a clean task type, and refuses a bad or reserved one without writing', async () => {
  const env = envWith();
  const ok = await worker.fetch(post('/tasks', { brief: 'do a thing', task_type: ' Gemini ' }, authed), env);
  assert.equal(ok.status, 200);
  assert.equal(env.DB.calls.length, 1);
  assert.equal(env.DB.calls[0].args[1], 'gemini');
  const none = await worker.fetch(post('/tasks', { brief: 'do a thing' }, authed), env);
  assert.equal(none.status, 200);
  assert.equal(env.DB.calls[1].args[1], 'auto');
  for (const task_type of ['osint', 'meta-lesson', 'a b', 'x'.repeat(200), 5]) {
    const res = await worker.fetch(post('/tasks', { brief: 'do a thing', task_type }, authed), env);
    assert.equal(res.status, 400, JSON.stringify(task_type));
  }
  assert.equal(env.DB.calls.length, 2, 'refused tasks write nothing');
  assert.equal((await worker.fetch(post('/tasks', '{not json', authed), env)).status, 400);
  assert.equal((await worker.fetch(post('/tasks', { task_type: 'groq' }, authed), env)).status, 400);
});

test('POST /admin/keys seals the key for GitHub and never sends it back', async (t) => {
  const pair = nacl.box.keyPair();
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push({ url: String(url), init });
    if (String(url).endsWith('/actions/secrets/public-key')) return new Response(JSON.stringify({ key: Buffer.from(pair.publicKey).toString('base64'), key_id: 'kid-1' }), { status: 200 });
    return new Response(null, { status: 204 });
  });
  const env = envWith();
  const res = await worker.fetch(post('/admin/keys', { provider: 'GROQ', value: ` ${FAKE_KEY} ` }, authed), env);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: true, provider: 'groq', secretName: 'GROQ_API_KEY' });
  assert.ok(!text.includes(FAKE_KEY));
  const put = sent.find((s) => s.init?.method === 'PUT');
  assert.ok(put.url.endsWith('/actions/secrets/GROQ_API_KEY'));
  const payload = JSON.parse(put.init.body);
  assert.equal(payload.key_id, 'kid-1');
  assert.ok(!put.init.body.includes(FAKE_KEY), 'GitHub gets ciphertext only');
  const opened = sealedbox.open(Uint8Array.from(Buffer.from(payload.encrypted_value, 'base64')), pair.publicKey, pair.secretKey);
  assert.equal(new TextDecoder().decode(opened), FAKE_KEY, 'the sealed value is the trimmed key');
  const meta = env.DB.calls.find((c) => /provider_keys_meta/.test(c.sql));
  assert.ok(meta && !JSON.stringify(meta.args).includes(FAKE_KEY), 'the database records that a key exists, never the key');
});

test('a GitHub failure on the way never puts the key in the response or the logs', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(JSON.stringify(args)));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
  const res = await worker.fetch(post('/admin/keys', { provider: 'groq', value: FAKE_KEY }, authed), envWith());
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes(FAKE_KEY));
  assert.ok(!logged.join('').includes(FAKE_KEY));
});

test('an oversized, spaced, or control-character key is refused before any network call, and the error does not repeat it', async (t) => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched = true;
    return new Response('{}');
  });
  const env = envWith();
  for (const value of ['k'.repeat(MAX_PROVIDER_KEY_LENGTH + 1), 'two words here', `${FAKE_KEY}\n`.repeat(3), `${FAKE_KEY}\u0000`]) {
    const res = await worker.fetch(post('/admin/keys', { provider: 'groq', value }, authed), env);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes(FAKE_KEY));
    assert.ok(text.length < 200);
  }
  assert.equal(fetched, false);
  assert.equal(env.DB.calls.length, 0);
});

test('an unknown provider is refused and the error does not carry the value', async () => {
  const res = await worker.fetch(post('/admin/keys', { provider: 'nope', value: FAKE_KEY }, authed), envWith());
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes(FAKE_KEY));
});
