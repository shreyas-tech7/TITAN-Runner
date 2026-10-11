// K12 crypto, C2 vault, migrations, R4 retention, R6 export and delete. These are the parts that touch the real
// algorithms and the real SQL: libsodium opens every sealed box, SQLite runs the real migrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { createRequire } from 'node:module';
import worker from '../src/index.js';
import { hsalsa20, sealForGithub, sealNonce, sealWithNacl, sealWithWebCrypto } from '../src/lib/sealedbox.js';
import { KEK_VERSION, VaultNotReadyError, decryptValue, encryptValue, vaultReady } from '../src/lib/vault.js';
import { ensureMigrations, resetMigrationState } from '../src/lib/migrate.js';
import { MIGRATIONS } from '../src/migrations.generated.js';
import { pruneOldRows, RETENTION_DAYS } from '../src/retention.js';
import { toBase64 } from '../src/lib/util.js';
import { FakeWorld, authed, get, post } from './helpers/world.mjs';
import { makeD1 } from './helpers/d1.mjs';

// The ESM entry of libsodium-wrappers 0.7.15 points at a file that is not in the package, so load the CommonJS build.
const sodium = createRequire(import.meta.url)('libsodium-wrappers');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('K12: libsodium opens a sealed box made by the WebCrypto path and by the tweetnacl path', async () => {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const message = 'ghp_FAKE_value_for_the_test_0123456789';
  for (const make of [
    async () => new Uint8Array(Buffer.from(await sealForGithub(message, b64(pair.publicKey)), 'base64')),
    async () => sealWithWebCrypto(new TextEncoder().encode(message), pair.publicKey),
    async () => sealWithNacl(new TextEncoder().encode(message), pair.publicKey),
  ]) {
    const sealed = await make();
    const opened = sodium.crypto_box_seal_open(sealed, pair.publicKey, pair.privateKey);
    assert.equal(new TextDecoder().decode(opened), message);
  }
});

test('K12: a sealed box opens only with its own key, differs on every call, and the nonce follows the libsodium rule', async () => {
  await sodium.ready;
  const a = sodium.crypto_box_keypair();
  const b = sodium.crypto_box_keypair();
  const one = await sealForGithub('same', b64(a.publicKey));
  const two = await sealForGithub('same', b64(a.publicKey));
  assert.notEqual(one, two, 'a fresh ephemeral key for each call');
  assert.throws(() => sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(one, 'base64')), b.publicKey, b.privateKey));
  // The nonce is BLAKE2b-24 of the ephemeral key and the recipient key, as in libsodium.
  const sealed = new Uint8Array(Buffer.from(one, 'base64'));
  const eph = sealed.slice(0, 32);
  const expected = sodium.crypto_generichash(24, new Uint8Array([...eph, ...a.publicKey]));
  assert.deepEqual(Array.from(sealNonce(eph, a.publicKey)), Array.from(expected));
  await assert.rejects(() => sealForGithub('x', b64(new Uint8Array(31))), /wrong length/);
});

test('K12: HSalsa20 matches the box key derivation of tweetnacl', () => {
  for (let i = 0; i < 20; i += 1) {
    const a = nacl.box.keyPair();
    const b = nacl.box.keyPair();
    const shared = nacl.scalarMult(a.secretKey, b.publicKey);
    assert.deepEqual(Array.from(hsalsa20(new Uint8Array(16), shared)), Array.from(nacl.box.before(b.publicKey, a.secretKey)));
  }
});

// --- C2 vault ------------------------------------------------------------------------------------------------------

const KEK = 'a1'.repeat(32);

test('C2: the vault round trip works, and each record has its own IV', async () => {
  const env = { CONNECTOR_KEK: KEK };
  const ctx = { connectionId: 'conn-1', connectorId: 'notion' };
  const one = await encryptValue(env, ctx, 'secret-value');
  const two = await encryptValue(env, ctx, 'secret-value');
  assert.notEqual(one.iv, two.iv);
  assert.notEqual(one.ciphertext, two.ciphertext);
  assert.equal(one.kek_version, KEK_VERSION);
  assert.equal(await decryptValue(env, ctx, one), 'secret-value');
  assert.equal(Buffer.from(one.iv, 'base64').length, 12);
});

test('C2: the wrong additional data, a changed ciphertext, a changed version, and another key all fail', async () => {
  const env = { CONNECTOR_KEK: KEK };
  const ctx = { connectionId: 'conn-1', connectorId: 'notion' };
  const rec = await encryptValue(env, ctx, 'secret-value');
  await assert.rejects(() => decryptValue(env, { connectionId: 'conn-2', connectorId: 'notion' }, rec));
  await assert.rejects(() => decryptValue(env, { connectionId: 'conn-1', connectorId: 'todoist' }, rec));
  const flipped = Buffer.from(rec.ciphertext, 'base64');
  flipped[0] ^= 1;
  await assert.rejects(() => decryptValue(env, ctx, { ...rec, ciphertext: flipped.toString('base64') }));
  await assert.rejects(() => decryptValue(env, ctx, { ...rec, kek_version: 2 }), VaultNotReadyError);
  await assert.rejects(() => decryptValue({ CONNECTOR_KEK: 'b2'.repeat(32) }, ctx, rec));
});

test('C2: with no key the vault is not ready and encrypt and decrypt throw vault_not_ready', async () => {
  assert.equal(vaultReady({}), false);
  assert.equal(vaultReady({ CONNECTOR_KEK: 'short' }), false);
  assert.equal(vaultReady({ CONNECTOR_KEK: KEK }), true);
  assert.equal(vaultReady({ CONNECTOR_KEK: toBase64(new Uint8Array(32).fill(7)) }), true, 'a base64 key of 32 bytes also works');
  await assert.rejects(() => encryptValue({}, { connectionId: 'a', connectorId: 'b' }, 'x'), (e) => e.code === 'vault_not_ready');
});

// --- migrations ----------------------------------------------------------------------------------------------------

test('X2: the Worker applies missing migrations, in order, once, with the table that wrangler uses', async () => {
  resetMigrationState();
  const d1 = makeD1({ migrate: false });
  const out = await ensureMigrations({ DB: d1 });
  assert.deepEqual(out.applied, MIGRATIONS.map((m) => m.name));
  const rows = (await d1.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((r) => r.name);
  assert.deepEqual(rows, MIGRATIONS.map((m) => m.name));
  const cols = (await d1.prepare("SELECT name FROM pragma_table_info('subagents')").all()).results.map((r) => r.name);
  for (const c of ['tokens_used', 'dispatched_at', 'retry_count']) assert.ok(cols.includes(c), c);
  resetMigrationState();
  assert.deepEqual((await ensureMigrations({ DB: d1 })).applied, [], 'a second run applies nothing');
});

test('X2: the baseline is safe on the live database, which already has the old schema and the tokens_used column', async () => {
  resetMigrationState();
  const { DatabaseSync } = await import('node:sqlite');
  const live = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  live.exec(schema);
  live.prepare("INSERT INTO subagents (id, task_type, brief, status, source, queued_at) VALUES ('old', 'auto', 'b', 'dispatched', 'dashboard', '2026-09-17T03:04:53.024Z')").run();
  const d1 = makeD1({ migrate: false });
  // Replace the empty database with the live-like one.
  d1.raw.close();
  Object.assign(d1, makeD1({ migrate: false }));
  const liveD1 = { prepare: (sql) => makeStatement(live, sql), batch: async () => [] };
  function makeStatement(db, sql) {
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      async run() { const i = db.prepare(sql).run(...args); return { results: [], meta: { changes: Number(i.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })), meta: {} }; },
      async first() { return db.prepare(sql).all(...args).map((r) => ({ ...r }))[0] ?? null; },
    };
  }
  const out = await ensureMigrations({ DB: liveD1 });
  assert.deepEqual(out.applied, MIGRATIONS.map((m) => m.name));
  const row = live.prepare("SELECT id, status, dispatched_at, retry_count FROM subagents WHERE id = 'old'").get();
  assert.deepEqual({ ...row }, { id: 'old', status: 'dispatched', dispatched_at: null, retry_count: 0 }, 'the live row survives and gains the new columns');
});

test('D8: every migration only adds. No file drops, renames, or deletes anything', () => {
  for (const m of MIGRATIONS) {
    for (const s of m.statements) {
      assert.ok(!/^\s*(DROP|DELETE|TRUNCATE)\b/i.test(s), `${m.name}: ${s.slice(0, 60)}`);
      assert.ok(!/RENAME\b/i.test(s), `${m.name}: ${s.slice(0, 60)}`);
      assert.ok(!/ALTER TABLE \w+ DROP\b/i.test(s));
      assert.ok(/^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN|INSERT OR IGNORE INTO)/i.test(s), `${m.name}: not additive: ${s.slice(0, 60)}`);
    }
  }
});

test('D8: the generated migrations file matches the SQL files', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('node', ['scripts/gen-worker-migrations.mjs', '--check'], { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' });
  assert.match(out, /in sync/);
});

// --- R4, R6 --------------------------------------------------------------------------------------------------------

test('R4: the retention rules remove old rows and keep the rest', async () => {
  const env = { DB: makeD1() };
  const now = new Date('2026-10-08T12:00:00Z');
  const ago = (days) => new Date(now.getTime() - days * 86400_000).toISOString();
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).run();
  await q('INSERT INTO key_events (at, action) VALUES (?, ?), (?, ?)', ago(400), 'old', ago(10), 'new');
  await q('INSERT INTO events (at, type, title) VALUES (?, ?, ?), (?, ?, ?)', ago(40), 'task.done', 'old', ago(1), 'task.done', 'new');
  await q('INSERT INTO auth_failures (key, route_group, window_start, failures, updated_at) VALUES (?, ?, ?, 1, ?), (?, ?, ?, 1, ?)', 'a', 'admin', ago(3), ago(3), 'b', 'admin', ago(0), ago(0));
  await q("INSERT INTO subagents (id, task_type, brief, status, source, queued_at, finished_at) VALUES ('d-old','auto','b','done','dashboard',?,?), ('d-new','auto','b','done','dashboard',?,?), ('f-mid','auto','b','failed','dashboard',?,?), ('f-old','auto','b','failed','dashboard',?,?)", ago(100), ago(100), ago(50), ago(50), ago(100), ago(100), ago(200), ago(200));
  const out = await pruneOldRows(env, now);
  assert.equal(out.key_events, 1);
  assert.equal(out.events, 1);
  assert.equal(out.auth_failures, 1);
  assert.equal(out.subagents_done, 1);
  assert.equal(out.subagents_failed, 1);
  assert.equal(out.connector_calls, 0, 'the table of release 2 exists and holds no old rows');
  assert.equal(out.chat_messages, 'no table', 'a table from a later release may not exist yet');
  const left = (await env.DB.prepare('SELECT id FROM subagents ORDER BY id').all()).results.map((r) => r.id);
  assert.deepEqual(left, ['d-new', 'f-mid']);
  assert.deepEqual([RETENTION_DAYS.connector_calls, RETENTION_DAYS.auth_failures, RETENTION_DAYS.key_events, RETENTION_DAYS.subagents_done, RETENTION_DAYS.subagents_failed], [30, 1, 365, 90, 180]);
});

test('R6: the export holds every table except vault data and token hashes, and strips hash columns', async (t) => {
  const world = new FakeWorld().install(t);
  const env = world.env({ CONNECTOR_KEK: KEK });
  await env.DB.prepare("INSERT INTO worker_tokens (kind, token_hash, status, created_at) VALUES ('callback', 'deadbeef', 'active', 'now')").run();
  await env.DB.prepare("INSERT INTO vault_records (id, scope, owner_id, iv, ciphertext, created_at) VALUES ('v1', 'provider_key', 'groq', 'iv', 'ct', 'now')").run();
  await env.DB.prepare("INSERT INTO provider_keys (provider, fingerprint, last4, saved_via) VALUES ('groq', 'abc123abc123', 'wxyz', 'dashboard')").run();
  const res = await worker.fetch(get('/admin/export', authed), env);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.ok(body.skippedTables.includes('vault_records') && body.skippedTables.includes('worker_tokens'));
  assert.ok(!('vault_records' in body.tables) && !('worker_tokens' in body.tables));
  assert.ok(body.tables.provider_keys.length === 1 && body.tables.provider_keys[0].fingerprint === 'abc123abc123');
  assert.ok(!text.includes('deadbeef') && !text.includes('"ct"'));
  assert.equal((await worker.fetch(get('/admin/export'), env)).status, 401);
});

test('R6: delete-area needs the typed confirm and deletes only that area', async (t) => {
  const world = new FakeWorld().install(t);
  const env = world.env();
  await env.DB.prepare("INSERT INTO key_events (at, action) VALUES ('2026-10-01', 'save')").run();
  await env.DB.prepare("INSERT INTO events (at, type, title) VALUES ('2026-10-01', 'task.done', 't')").run();
  await env.DB.prepare("INSERT INTO provider_keys (provider, saved_via) VALUES ('groq', 'dashboard')").run();
  assert.equal((await worker.fetch(post('/admin/delete-area', { area: 'audit' }, authed), env)).status, 400);
  assert.equal((await worker.fetch(post('/admin/delete-area', { area: 'audit', confirm: 'yes' }, authed), env)).status, 400);
  assert.equal((await worker.fetch(post('/admin/delete-area', { area: 'nope', confirm: 'delete nope' }, authed), env)).status, 400);
  const ok = await worker.fetch(post('/admin/delete-area', { area: 'audit', confirm: 'delete audit' }, authed), env);
  assert.equal(ok.status, 200);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM key_events').first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_keys').first()).n, 1, 'key metadata is not part of an audit delete');
});
