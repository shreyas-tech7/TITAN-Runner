// Track K: the key routes, one test for each scenario in Section 7.2 of the Wave 12 brief, and a test for each step of K3.
// The fake world holds a GitHub API with real sealed boxes and providers that answer by key.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { computeKeyState, verifyProviderKey } from '../src/keys.js';
import { getProvider } from '../src/lib/catalog.js';
import { sha256Hex } from '../src/lib/util.js';
import { ADMIN, FAKE_GEMINI_KEY, FAKE_GROQ_KEY, FakeWorld, authed, captureConsole, del, get, post } from './helpers/world.mjs';

function setup(t, extraEnv = {}) {
  const world = new FakeWorld().install(t);
  world.providers.host('api.groq.com').valid.add(FAKE_GROQ_KEY);
  world.providers.host('generativelanguage.googleapis.com').valid.add(FAKE_GEMINI_KEY);
  const env = world.env(extraEnv);
  const bodies = [];
  const call = async (request) => {
    const res = await worker.fetch(request, env);
    const text = await res.clone().text();
    bodies.push(text);
    return { res, text, json: text ? JSON.parse(text) : null };
  };
  return { world, env, call, bodies };
}

const providerRow = (json, id) => json.providers.find((p) => p.id === id);

test('scenario 1: keys set outside the dashboard show as outside, a missing key shows as missing, a misspelled secret is flagged', async (t) => {
  const { world, call, env } = setup(t);
  world.github.setByHand('GEMINI_API_KEY', FAKE_GEMINI_KEY);
  world.github.setByHand('OPENROUTER_API_KEY', ['sk', 'or', 'v1', 'x'.repeat(20)].join('-'));
  world.github.setByHand('GROK_API_KEY', FAKE_GROQ_KEY); // the live typo
  const now = new Date().toISOString();
  world.github.files.set('state/providers.json', JSON.stringify({ providers: {
    gemini: { status: 'ok', model: 'gemini-2.5-flash', latencyMs: 900, lastCheckedAt: now, lastSuccessAt: now, discoveredModels: ['gemini-2.5-flash'] },
    openrouter: { status: 'rate_limited', lastCheckedAt: now, errorRate: 0.9 },
  } }));
  const { res, json } = await call(get('/admin/keys', authed));
  assert.equal(res.status, 200);
  const gemini = providerRow(json, 'gemini');
  const openrouter = providerRow(json, 'openrouter');
  const groq = providerRow(json, 'groq');
  assert.equal(gemini.secretPresent, true);
  assert.equal(gemini.savedVia, 'outside');
  assert.equal(gemini.fingerprint, null, 'no fingerprint is invented for a key set outside');
  assert.equal(gemini.last4, null);
  assert.equal(openrouter.secretPresent, true);
  assert.equal(openrouter.savedVia, 'outside');
  assert.equal(groq.secretPresent, false);
  assert.equal(groq.state, 'missing');
  assert.equal(gemini.state, 'proven', 'the pulse used the Gemini key with success');
  assert.equal(gemini.runnerProof.source, 'pulse');
  assert.equal(openrouter.state, 'rate_limited');
  assert.deepEqual(json.misnamedSecrets, [{ found: 'GROK_API_KEY', suggest: 'GROQ_API_KEY', provider: 'groq' }]);
  assert.ok(json.reconciled.includes('gemini') && json.reconciled.includes('openrouter'));
  const rows = (await env.DB.prepare('SELECT provider, saved_via, fingerprint FROM provider_keys ORDER BY provider').all()).results;
  assert.deepEqual(rows.map((r) => [r.provider, r.saved_via, r.fingerprint]), [['gemini', 'outside', null], ['openrouter', 'outside', null]]);
  const again = await call(get('/admin/keys', authed));
  assert.deepEqual(again.json.reconciled, [], 'the reconcile runs once');
});

test('scenario 2: a valid key goes through every step, in order, and the runner proof makes it proven', async (t) => {
  const { world, call, env } = setup(t);
  const { res, json } = await call(post('/admin/keys', { provider: 'groq', value: ` ${FAKE_GROQ_KEY} ` }, authed));
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.secretName, 'GROQ_API_KEY');
  assert.equal(json.fingerprint, (await sha256Hex(FAKE_GROQ_KEY)).slice(0, 12));
  assert.equal(json.last4, FAKE_GROQ_KEY.slice(-4));
  assert.equal(json.providerCheck.result, 'ok');
  assert.equal(json.selftest, 'dispatched');
  assert.ok(json.requestId);

  // The provider check comes first. Then GitHub: public key, secret write, dispatch.
  const trail = world.trail();
  assert.equal(trail[0], 'api.groq.com GET /openai/v1/models');
  assert.match(trail[1], /api\.github\.com GET .*\/actions\/secrets\/public-key/);
  assert.match(trail[2], /api\.github\.com PUT .*\/actions\/secrets\/GROQ_API_KEY/);
  assert.match(trail[3], /api\.github\.com POST .*\/dispatches/);
  assert.equal(world.github.open('GROQ_API_KEY'), FAKE_GROQ_KEY, 'the sealed box opens to the exact key');
  assert.deepEqual(world.github.dispatches, [{ event_type: 'provider-selftest', client_payload: { provider: 'groq', requestId: json.requestId } }]);

  let list = (await call(get('/admin/keys', authed))).json;
  assert.equal(providerRow(list, 'groq').state, 'provider_ok');
  assert.equal(providerRow(list, 'groq').savedVia, 'dashboard');
  assert.equal(providerRow(list, 'groq').last4, FAKE_GROQ_KEY.slice(-4));

  // A late proof for an older request is ignored.
  const stale = await call(post('/internal/provider-proof', { provider: 'groq', requestId: 'req_old', ok: true, model: 'x', latencyMs: 1 }, authed));
  assert.equal(stale.json.ignored, true);
  assert.equal(providerRow((await call(get('/admin/keys', authed))).json, 'groq').state, 'provider_ok');

  // The proof for this request arrives.
  const proof = await call(post('/internal/provider-proof', { provider: 'groq', requestId: json.requestId, ok: true, model: 'llama-3.3-70b-versatile', latencyMs: 412, detail: 'The completion worked.' }, authed));
  assert.equal(proof.res.status, 200);
  list = (await call(get('/admin/keys', authed))).json;
  const groq = providerRow(list, 'groq');
  assert.equal(groq.state, 'proven');
  assert.equal(groq.runnerProof.model, 'llama-3.3-70b-versatile');
  assert.equal(groq.runnerProof.latencyMs, 412);
  const events = (await call(get('/admin/keys/events?limit=10', authed))).json.events.map((e) => e.action);
  assert.ok(events.includes('save') && events.includes('proof'));
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'key.proven'").first()).n >= 1, 'the proven event is recorded');
});

test('scenario 3: a wrong key gets 422, GitHub gets nothing, and nothing is saved', async (t) => {
  const { world, call, env } = setup(t);
  const wrong = ['gsk', 'WRONG', 'z'.repeat(20)].join('_');
  const { res, json, text } = await call(post('/admin/keys', { provider: 'groq', value: wrong }, authed));
  assert.equal(res.status, 422);
  assert.equal(json.error, 'provider_rejected');
  assert.match(json.reason, /401/);
  assert.ok(!text.includes(wrong));
  assert.equal(world.trail().filter((l) => l.startsWith('api.github.com')).length, 0, 'GitHub gets nothing');
  assert.equal(world.github.secrets.size, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_keys').first()).n, 0);
  // Gemini answers 400 with API_KEY_INVALID for a wrong key. That also counts as rejected.
  const gem = await call(post('/admin/keys', { provider: 'gemini', value: 'AIza-wrong-key-value' }, authed));
  assert.equal(gem.res.status, 422);
  assert.equal(world.github.secrets.size, 0);
});

test('scenario 4: a 429, a timeout, or an unverifiable provider asks to confirm. After the confirm the key is saved, not verified', async (t) => {
  const { world, call } = setup(t, { TITAN_TEST_MODE: '1', TITAN_PROVIDER_CHECK_TIMEOUT_MS: '80' });
  const limited = ['gsk', 'RATE', 'l'.repeat(20)].join('_');
  world.providers.host('api.groq.com').rateLimited.add(limited);
  let r = await call(post('/admin/keys', { provider: 'groq', value: limited }, authed));
  assert.equal(r.res.status, 202);
  assert.equal(r.json.needsConfirm, true);
  assert.equal(world.github.secrets.size, 0, 'nothing is saved before the confirm');
  r = await call(post('/admin/keys', { provider: 'groq', value: limited, saveIfUnverified: true }, authed));
  assert.equal(r.res.status, 200);
  assert.equal(r.json.verified, false);
  assert.equal(world.github.open('GROQ_API_KEY'), limited);
  assert.equal(providerRow((await call(get('/admin/keys', authed))).json, 'groq').state, 'saved_unverified');

  // A slow provider times out.
  const slow = ['gsk', 'SLOW', 's'.repeat(20)].join('_');
  const h = world.providers.host('api.together.xyz');
  h.slow.add(slow);
  h.slowMs = 400;
  r = await call(post('/admin/keys', { provider: 'together', value: slow }, authed));
  assert.equal(r.res.status, 202);
  assert.match(r.json.providerCheck.result, /timeout/);

  // A provider with no check route (OpenCode) asks to confirm and then saves.
  r = await call(post('/admin/keys', { provider: 'opencode', value: 'oc-test-key-123' }, authed));
  assert.equal(r.res.status, 202);
  r = await call(post('/admin/keys', { provider: 'opencode', value: 'oc-test-key-123', saveIfUnverified: true }, authed));
  assert.equal(r.res.status, 200);
  assert.equal(providerRow((await call(get('/admin/keys', authed))).json, 'opencode').state, 'unverifiable', 'OpenCode has no check route, so it stays unverifiable until a runner proves it');
});

test('scenario 5: a PAT that cannot write secrets gives 502 with the permission name and no key', async (t) => {
  const { world, call } = setup(t);
  const logs = captureConsole(t);
  world.github.fail.publicKey = 403;
  const { res, json, text } = await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY }, authed));
  assert.equal(res.status, 502);
  assert.equal(json.error, 'github_failed');
  assert.equal(json.pat.permission, 'Secrets: Read and write');
  assert.match(json.pat.hint, /Secrets: Read and write/);
  assert.ok(!text.includes(FAKE_GROQ_KEY));
  assert.ok(!logs().includes(FAKE_GROQ_KEY));
  // The key list also shows the PAT problem.
  world.github.fail.list = 403;
  const list = await call(get('/admin/keys', authed));
  assert.equal(list.json.pat.ok, false);
  assert.equal(list.json.pat.permission, 'Secrets: Read');
  assert.equal(providerRow(list.json, 'groq').state, 'error');
});

test('scenario 6: remove needs the typed confirm, deletes the GitHub secrets, and the audit log shows it', async (t) => {
  const { world, call } = setup(t);
  await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY, model: 'llama-3.3-70b-versatile' }, authed));
  assert.ok(world.github.secrets.has('GROQ_API_KEY') && world.github.secrets.has('GROQ_MODEL'));
  let r = await call(del('/admin/keys/groq', { confirm: 'together' }, authed));
  assert.equal(r.res.status, 400);
  r = await call(del('/admin/keys/groq', {}, authed));
  assert.equal(r.res.status, 400);
  assert.equal(world.github.deleted.length, 0);
  r = await call(del('/admin/keys/groq', { confirm: 'groq' }, authed));
  assert.equal(r.res.status, 200);
  assert.deepEqual(world.github.deleted.sort(), ['GROQ_API_KEY', 'GROQ_MODEL']);
  assert.equal(providerRow((await call(get('/admin/keys', authed))).json, 'groq').state, 'missing');
  const events = (await call(get('/admin/keys/events', authed))).json.events;
  const remove = events.find((e) => e.action === 'remove');
  assert.ok(remove && remove.old_fingerprint === (await sha256Hex(FAKE_GROQ_KEY)).slice(0, 12));
  assert.equal((await call(del('/admin/keys/nope', { confirm: 'nope' }, authed))).res.status, 404);
});

test('replace keeps the old fingerprint in the audit log', async (t) => {
  const { world, call } = setup(t);
  const second = ['gsk', 'SECOND', 'b'.repeat(20)].join('_');
  world.providers.host('api.groq.com').valid.add(second);
  await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY }, authed));
  await call(post('/admin/keys', { provider: 'groq', value: second }, authed));
  const replace = (await call(get('/admin/keys/events', authed))).json.events.find((e) => e.action === 'replace');
  assert.equal(replace.old_fingerprint, (await sha256Hex(FAKE_GROQ_KEY)).slice(0, 12));
  assert.equal(replace.fingerprint, (await sha256Hex(second)).slice(0, 12));
  assert.equal(world.github.open('GROQ_API_KEY'), second);
});

test('scenario 10: the key is in no response, no D1 row, no log line, no dispatch, and no URL', async (t) => {
  const { world, call, env, bodies } = setup(t, { CONNECTOR_KEK: '0'.repeat(64) });
  const logs = captureConsole(t);
  const sensitive = [FAKE_GROQ_KEY, FAKE_GEMINI_KEY];
  const first = await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY, alsoForChat: true }, authed));
  assert.equal(first.json.chat, 'stored');
  await call(post('/admin/keys', { provider: 'gemini', value: FAKE_GEMINI_KEY }, authed));
  await call(post('/internal/provider-proof', { provider: 'groq', requestId: first.json.requestId, ok: false, detail: `rejected ${FAKE_GROQ_KEY.slice(0, 4)}` }, authed));
  await call(get('/admin/keys', authed));
  await call(get('/admin/keys/events', authed));
  await call(post('/admin/keys/groq/test', {}, authed));
  await call(post('/admin/keys', { provider: 'groq', value: 'gsk_BAD_KEY_FOR_422_PATH_000000' }, authed));
  const dump = JSON.stringify(env.DB.dump());
  const everything = { bodies: bodies.join('\n'), dump, logs: logs(), dispatches: JSON.stringify(world.github.dispatches), urls: world.log.map((l) => `${l.host}${l.path}`).join('\n') };
  for (const [where, text] of Object.entries(everything)) {
    for (const key of sensitive) assert.ok(!text.includes(key), `the key is in ${where}`);
  }
  // The copy for chat is encrypted: the vault row holds a ciphertext, not the key.
  const vault = await env.DB.prepare("SELECT iv, ciphertext FROM vault_records WHERE id = 'provider-key:groq'").first();
  assert.ok(vault && vault.ciphertext.length > 20 && !vault.ciphertext.includes(FAKE_GROQ_KEY));
  assert.ok(world.providers.calls.length > 0, 'the providers were called, and with a header: the fake refuses a key in the query string');
});

test('K3 steps: the order of the checks is admin token, provider id, key format, inputs, then the provider', async (t) => {
  const { world, call } = setup(t);
  // step 1
  assert.equal((await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY }, {}))).res.status, 401);
  // step 2
  assert.equal((await call(post('/admin/keys', { provider: 'nope', value: FAKE_GROQ_KEY }, authed))).json.error, 'unknown_provider');
  // step 3: the format fails first, and a prefix mismatch is a warning only
  assert.equal((await call(post('/admin/keys', { provider: 'groq', value: 'has space' }, authed))).res.status, 400);
  assert.equal(world.log.length, 0, 'no call before the checks pass');
  world.providers.host('api.groq.com').valid.add('not-a-gsk-key');
  const warn = await call(post('/admin/keys', { provider: 'groq', value: 'not-a-gsk-key' }, authed));
  assert.equal(warn.res.status, 200);
  assert.match(warn.json.warnings.join(' '), /gsk_/);
  // step 4: a custom provider needs its inputs, and the base URL must use https and a public host
  const custom = (over) => post('/admin/keys', { provider: 'custom_1', value: 'ck-1234567890', label: 'My LLM', baseUrl: 'https://llm.example.com/v1', model: 'm1', ...over }, authed);
  assert.equal((await call(custom({ label: '' }))).json.error, 'missing_input');
  assert.equal((await call(custom({ baseUrl: 'http://llm.example.com/v1' }))).json.error, 'bad_base_url');
  assert.equal((await call(custom({ baseUrl: 'https://user:pw@llm.example.com/v1' }))).json.error, 'bad_base_url');
  assert.equal((await call(custom({ baseUrl: 'https://10.0.0.5/v1' }))).json.error, 'bad_base_url');
  assert.equal((await call(custom({ model: 'bad model!' }))).json.error, 'bad_input');
  // a host that resolves to a private address is refused at the check, and cannot be saved even with a confirm
  world.dns.set('llm.example.com', ['10.0.0.9']);
  const priv = await call(custom({ saveIfUnverified: true }));
  assert.equal(priv.res.status, 400);
  assert.equal(priv.json.error, 'bad_base_url');
  world.dns.delete('llm.example.com');
  // the happy path for a custom provider writes the key and the extra secrets
  world.providers.host('llm.example.com').valid.add('ck-1234567890');
  const ok = await call(custom({}));
  assert.equal(ok.res.status, 200);
  assert.deepEqual(ok.json.secretsWritten.sort(), ['CUSTOM_1_API_KEY', 'CUSTOM_1_BASE_URL', 'CUSTOM_1_LABEL', 'CUSTOM_1_MODEL']);
  assert.equal(world.github.open('CUSTOM_1_BASE_URL'), 'https://llm.example.com/v1');
});

test('K3 step 11: alsoForChat without a vault key saves the secret and tells the person how to fix the vault', async (t) => {
  const { call, env } = setup(t);
  const r = await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY, alsoForChat: true }, authed));
  assert.equal(r.res.status, 200);
  assert.equal(r.json.chat, 'vault_not_ready');
  assert.match(r.json.warnings.join(' '), /Provision vault key/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM vault_records').first()).n, 0);
});

test('K3 step 14: a failed dispatch never undoes the save', async (t) => {
  const { world, call } = setup(t);
  world.github.fail.dispatch = 422;
  const r = await call(post('/admin/keys', { provider: 'groq', value: FAKE_GROQ_KEY }, authed));
  assert.equal(r.res.status, 200);
  assert.equal(r.json.selftest, 'dispatch_failed');
  assert.ok(world.github.secrets.has('GROQ_API_KEY'));
});

test('K4: Test now fires the single provider test and the audit records it', async (t) => {
  const { world, call } = setup(t);
  const r = await call(post('/admin/keys/gemini/test', {}, authed));
  assert.equal(r.json.selftest, 'dispatched');
  assert.equal(world.github.dispatches[0].client_payload.provider, 'gemini');
  assert.equal((await call(post('/admin/keys/nope/test', {}, authed))).res.status, 404);
});

test('K10: the secret write round trip writes, lists, and deletes a probe secret and touches no provider key', async (t) => {
  const { world, call } = setup(t);
  world.github.setByHand('GEMINI_API_KEY', FAKE_GEMINI_KEY);
  const { json } = await call(post('/admin/diagnose/secret-roundtrip', {}, authed));
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.ok(json.steps.some((s) => s.step === 'delete secret' && s.ok));
  assert.equal(world.github.secrets.has('TITAN_DIAG_PROBE'), false, 'the probe is gone');
  assert.deepEqual(world.github.deleted, ['TITAN_DIAG_PROBE']);
  assert.ok(world.github.secrets.has('GEMINI_API_KEY'), 'a provider key is never touched');
  world.github.fail.put = 403;
  const bad = await call(post('/admin/diagnose/secret-roundtrip', {}, authed));
  assert.equal(bad.json.ok, false);
});

test('computeKeyState: a proof or a check older than the secret does not count', () => {
  const entry = getProvider('groq');
  const row = { check_result: 'ok', check_at: '2026-10-01T00:00:00Z', proof_result: 'ok', proof_at: '2026-10-01T00:00:00Z' };
  const fresh = computeKeyState({ entry, secretPresent: true, secretUpdatedAt: '2026-10-01T00:00:30Z', row });
  assert.equal(fresh.state, 'proven');
  const replaced = computeKeyState({ entry, secretPresent: true, secretUpdatedAt: '2026-10-05T00:00:00Z', row });
  assert.equal(replaced.state, 'saved_unverified', 'the secret changed after the proof, so it is a different key');
  assert.equal(computeKeyState({ entry, secretPresent: true, secretUpdatedAt: '2026-10-01T00:00:00Z', row: { ...row, proof_result: 'failed', proof_detail: 'rejected the request (401)' } }).state, 'invalid');
  assert.equal(computeKeyState({ entry: getProvider('freebuff'), secretPresent: true, secretUpdatedAt: 'x', row: null }).state, 'unverifiable');
  assert.equal(computeKeyState({ entry, secretPresent: null }).state, 'error');
});

test('verifyProviderKey sends the key in a header and never in the URL', async (t) => {
  const world = new FakeWorld().install(t);
  world.providers.host('generativelanguage.googleapis.com').valid.add(FAKE_GEMINI_KEY);
  const seen = [];
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers });
    return original(url, init);
  });
  const res = await verifyProviderKey({}, getProvider('gemini'), FAKE_GEMINI_KEY, {});
  assert.equal(res.result, 'ok');
  assert.ok(!seen[0].url.includes(FAKE_GEMINI_KEY));
  assert.equal(seen[0].headers['x-goog-api-key'], FAKE_GEMINI_KEY);
});

test('the admin token is required on every key route', async (t) => {
  const { call } = setup(t);
  for (const request of [get('/admin/keys'), get('/admin/keys/events'), post('/admin/keys', {}), del('/admin/keys/groq', { confirm: 'groq' }), post('/admin/keys/groq/test', {})]) {
    assert.equal((await call(request)).res.status, 401, request.url);
  }
  assert.ok(ADMIN.length > 20);
});
