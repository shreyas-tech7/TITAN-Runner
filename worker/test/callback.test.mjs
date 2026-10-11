// K8, K9, R1: the callback token, the stuck task reaper with retry, and the pulse keeper.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { CALLBACK_SECRET_NAME, GRACE_MS, authenticateInternal, isLegacyMode, issueCallbackToken, tickCallbackToken } from '../src/callback.js';
import { keeperDecision, tickKeeper } from '../src/keeper.js';
import { STUCK_AFTER_MINUTES, reapStuckTasks } from '../src/tasks.js';
import { runTick } from '../src/tick.js';
import { sha256Hex } from '../src/lib/util.js';
import { FakeWorld, authed, captureConsole, get, post } from './helpers/world.mjs';

const minutes = (m) => m * 60_000;
const at = (base, m) => new Date(base.getTime() + minutes(m));
const withCallback = (token) => ({ 'X-Titan-Callback': token });

function setup(t) {
  const world = new FakeWorld().install(t);
  return { world, env: world.env() };
}

test('K8: the first tick makes the token, writes the secret as a sealed box, and marks the hash active only after the write', async (t) => {
  const { world, env } = setup(t);
  const logs = captureConsole(t);
  assert.equal(await isLegacyMode(env), true, 'legacy mode before the first token');
  const result = await tickCallbackToken(env, new Date());
  assert.equal(result.action, 'issue');
  assert.equal(result.ok, true);
  const plain = world.github.open(CALLBACK_SECRET_NAME);
  assert.match(plain, /^[0-9a-f]{64}$/, '32 random bytes as hex');
  const row = await env.DB.prepare("SELECT token_hash, status, activated_at FROM worker_tokens WHERE kind = 'callback'").first();
  assert.equal(row.token_hash, await sha256Hex(plain), 'only the hash is stored');
  assert.equal(row.status, 'active');
  assert.ok(row.activated_at);
  assert.ok(!JSON.stringify(env.DB.dump()).includes(plain), 'D1 never holds the token');
  assert.ok(!logs().includes(plain), 'no log line holds the token');
  // A second tick does nothing.
  assert.equal((await tickCallbackToken(env, new Date())).action, 'ok');
});

test('K8: if the GitHub write fails, the token is revoked and the next try waits one hour', async (t) => {
  const { world, env } = setup(t);
  const base = new Date('2026-10-08T12:00:00Z');
  world.github.fail.put = 500;
  const first = await tickCallbackToken(env, base);
  assert.equal(first.ok, false);
  assert.equal(world.github.secrets.has(CALLBACK_SECRET_NAME), false);
  const row = await env.DB.prepare("SELECT status, revoked_at FROM worker_tokens WHERE kind = 'callback'").first();
  assert.ok(row.revoked_at, 'the pending hash is revoked');
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_tokens WHERE status = 'active'").first()).n, 0);
  assert.equal((await tickCallbackToken(env, at(base, 30))).action, 'wait', 'no retry inside the hour');
  world.github.fail.put = null;
  const retry = await tickCallbackToken(env, at(base, 61));
  assert.equal(retry.action, 'issue');
  assert.equal(retry.ok, true);
  assert.ok(world.github.secrets.has(CALLBACK_SECRET_NAME));
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'callback.broken'").first()).n >= 1);
});

test('scenario 7: legacy mode accepts the admin token, a rotation keeps the old token for 30 minutes, then it gets 401', async (t) => {
  const { world, env } = setup(t);
  const base = new Date('2026-10-08T12:00:00Z');
  const statusRequest = (headers) => post('/internal/status', { id: 'none', status: 'running' }, headers);
  // Legacy mode: the admin token opens /internal.
  assert.equal((await worker.fetch(statusRequest(authed), env)).status, 404, 'the admin token passes the gate (404 is the missing task row)');
  await issueCallbackToken(env, base, { reason: 'missing' });
  const first = world.github.open(CALLBACK_SECRET_NAME);
  assert.equal((await authenticateInternal(statusRequest(withCallback(first)), env, at(base, 1))).kind, 'callback');
  // 29 minutes after the first activation the admin token still works. At 31 minutes it does not.
  assert.equal((await authenticateInternal(statusRequest(authed), env, at(base, 29))).kind, 'admin-legacy');
  assert.equal((await authenticateInternal(statusRequest(authed), env, at(base, 31))).status, 'callback_required');
  // Rotation.
  await issueCallbackToken(env, at(base, 60), { reason: 'forced' });
  const second = world.github.open(CALLBACK_SECRET_NAME);
  assert.notEqual(second, first, 'the workflows get the new token');
  assert.equal((await authenticateInternal(statusRequest(withCallback(second)), env, at(base, 61))).kind, 'callback');
  assert.equal((await authenticateInternal(statusRequest(withCallback(first)), env, at(base, 61))).kind, 'callback', 'the old token works inside the grace period');
  assert.equal((await authenticateInternal(statusRequest(withCallback(first)), env, at(base, 60 + GRACE_MS / 60_000 + 1))).status, 'wrong', 'the old token gets 401 after 30 minutes');
  assert.equal((await authenticateInternal(statusRequest(withCallback(second)), env, at(base, 60 + 31))).kind, 'callback');
});

test('K8: the rotate route never returns the token, and the scheduled rotation runs after 30 days', async (t) => {
  const { world, env } = setup(t);
  await tickCallbackToken(env, new Date('2026-10-01T00:00:00Z'));
  const before = world.github.open(CALLBACK_SECRET_NAME);
  const res = await worker.fetch(post('/admin/callback-token/rotate', {}, authed), env);
  assert.equal(res.status, 200);
  const text = await res.text();
  const after = world.github.open(CALLBACK_SECRET_NAME);
  assert.notEqual(before, after);
  assert.ok(!text.includes(after) && !text.includes(before));
  assert.ok(JSON.parse(text).previousValidUntil);
  const current = await env.DB.prepare("SELECT created_at FROM worker_tokens WHERE status = 'active'").first();
  assert.equal((await tickCallbackToken(env, new Date(Date.parse(current.created_at) + 29 * 24 * 3600_000))).action, 'ok');
  const scheduled = await tickCallbackToken(env, new Date(Date.parse(current.created_at) + 31 * 24 * 3600_000));
  assert.equal(scheduled.action, 'rotate');
  assert.notEqual(world.github.open(CALLBACK_SECRET_NAME), after);
});

test('K8: the callback token opens /internal only, and the admin token no longer opens it after legacy mode', async (t) => {
  const { world, env } = setup(t);
  await issueCallbackToken(env, new Date(Date.now() - minutes(120)), { reason: 'missing' });
  const cb = world.github.open(CALLBACK_SECRET_NAME);
  // The callback token does not open an admin route.
  assert.equal((await worker.fetch(get('/status', withCallback(cb)), env)).status, 401);
  assert.equal((await worker.fetch(post('/admin/keys', {}, withCallback(cb)), env)).status, 401);
  // It opens an internal route.
  assert.equal((await worker.fetch(post('/internal/pulse-heartbeat', {}, withCallback(cb)), env)).status, 200);
  // The admin token is refused on /internal once legacy mode is over, with a hint.
  const refused = await worker.fetch(post('/internal/pulse-heartbeat', {}, authed), env);
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).error, 'callback_token_required');
  // A wrong callback token is a plain 401.
  assert.equal((await worker.fetch(post('/internal/pulse-heartbeat', {}, withCallback('0'.repeat(64))), env)).status, 401);
});

test('K8: the round trip test records the time and the kind of token', async (t) => {
  const { world, env } = setup(t);
  await issueCallbackToken(env, new Date(Date.now() - minutes(120)), { reason: 'missing' });
  const cb = world.github.open(CALLBACK_SECRET_NAME);
  const start = await (await worker.fetch(post('/admin/callback-ping', {}, authed), env)).json();
  assert.ok(start.id);
  assert.deepEqual(world.github.dispatches.at(-1), { event_type: 'callback-ping', client_payload: { id: start.id } });
  const ping = await worker.fetch(post('/internal/ping', { id: start.id }, withCallback(cb)), env);
  assert.equal(ping.status, 200);
  const state = await (await worker.fetch(get('/admin/callback', authed), env)).json();
  assert.equal(state.lastPing.id, start.id);
  assert.equal(state.lastPing.authKind, 'callback');
  assert.equal(typeof state.lastPing.seconds, 'number');
  assert.equal(state.legacyMode, false);
  assert.equal((await worker.fetch(post('/internal/ping', { id: 'ping_unknown' }, withCallback(cb)), env)).status, 404);
  // A manual run of the workflow makes its own id, and the Worker takes it.
  assert.equal((await worker.fetch(post('/internal/ping', { id: 'manual_12345' }, withCallback(cb)), env)).status, 200);
});

// ---------------------------------------------------------------------------------------------------------------------

async function insertTask(env, over) {
  const row = { id: crypto.randomUUID(), task_type: 'auto', brief: 'b', status: 'dispatched', source: 'dashboard', queued_at: '2026-09-17T03:04:53.024Z', dispatched_at: null, started_at: null, ...over };
  await env.DB.prepare('INSERT INTO subagents (id, task_type, brief, status, source, queued_at, dispatched_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.task_type, row.brief, row.status, row.source, row.queued_at, row.dispatched_at, row.started_at)
    .run();
  return row.id;
}

test('scenario 8 / K9: a task stuck for more than 25 minutes becomes failed with a reason, and retry sets it back to queued', async (t) => {
  const { world, env } = setup(t);
  const now = new Date(); // the retry route uses the real clock
  const old = await insertTask(env, { status: 'dispatched', dispatched_at: at(now, -(STUCK_AFTER_MINUTES + 1)).toISOString() });
  const young = await insertTask(env, { status: 'dispatched', dispatched_at: at(now, -(STUCK_AFTER_MINUTES - 1)).toISOString() });
  const live = await insertTask(env, { status: 'dispatched' }); // the live row from 2026-09-17 has no dispatched_at
  const stuckRunning = await insertTask(env, { status: 'running', dispatched_at: at(now, -90).toISOString(), started_at: at(now, -40).toISOString() });
  const done = await insertTask(env, { status: 'done' });
  const out = await reapStuckTasks(env, now);
  assert.deepEqual(out.failed.map((f) => f.id).sort(), [old, live, stuckRunning].sort());
  const state = async (id) => env.DB.prepare('SELECT status, result_summary, finished_at FROM subagents WHERE id = ?').bind(id).first();
  assert.equal((await state(young)).status, 'dispatched');
  assert.equal((await state(done)).status, 'done');
  const reason = await state(old);
  assert.equal(reason.status, 'failed');
  assert.match(reason.result_summary, /did not report back in 25 minutes/);
  assert.match(reason.result_summary, /Probable causes/);
  assert.match(reason.result_summary, /Repair runner callbacks/);
  assert.match((await state(stuckRunning)).result_summary, /did not finish in 25 minutes/);
  assert.equal((await state(live)).status, 'failed', 'the old row becomes failed');

  // Retry.
  const retry = await worker.fetch(post(`/tasks/${old}/retry`, {}, authed), env);
  assert.equal(retry.status, 200);
  const after = await env.DB.prepare('SELECT status, result_summary, finished_at, dispatched_at, retry_count FROM subagents WHERE id = ?').bind(old).first();
  assert.deepEqual([after.status, after.result_summary, after.finished_at, after.dispatched_at, after.retry_count], ['queued', null, null, null, 1]);
  assert.equal((await worker.fetch(post(`/tasks/${young}/retry`, {}, authed), env)).status, 409, 'a task that is not failed cannot be retried');
  assert.equal((await worker.fetch(post('/tasks/nope/retry', {}, authed), env)).status, 404);
  assert.equal((await worker.fetch(post(`/tasks/${old}/retry`, {}, {}), env)).status, 401);
  assert.ok(world);
});

test('K9: the tick dispatches a queued task and stamps dispatched_at', async (t) => {
  const { world, env } = setup(t);
  const id = await insertTask(env, { status: 'queued' });
  const report = await runTick(env, new Date());
  assert.equal(report.dispatch.dispatched, 1);
  const row = await env.DB.prepare('SELECT status, dispatched_at FROM subagents WHERE id = ?').bind(id).first();
  assert.equal(row.status, 'dispatched');
  assert.ok(row.dispatched_at);
  assert.ok(world.github.dispatches.some((d) => d.event_type === 'spawn-subagent' && d.client_payload.id === id));
});

// ---------------------------------------------------------------------------------------------------------------------

test('scenario 8 (R1): the keeper rule fires only when the heartbeat is older than 15 minutes and the last dispatch older than 14', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const iso = (m) => at(now, m).toISOString();
  assert.equal(keeperDecision({ now, lastHeartbeatAt: iso(-5), lastDispatchAt: null }).fire, false, 'fresh heartbeat');
  assert.equal(keeperDecision({ now, lastHeartbeatAt: iso(-15), lastDispatchAt: null }).fire, false, 'exactly 15 minutes is not older');
  assert.equal(keeperDecision({ now, lastHeartbeatAt: iso(-16), lastDispatchAt: null }).fire, true);
  assert.equal(keeperDecision({ now, lastHeartbeatAt: iso(-60), lastDispatchAt: iso(-10) }).fire, false, 'a dispatch went out 10 minutes ago');
  assert.equal(keeperDecision({ now, lastHeartbeatAt: iso(-60), lastDispatchAt: iso(-15) }).fire, true);
  assert.equal(keeperDecision({ now, lastHeartbeatAt: null, lastDispatchAt: null }).fire, true, 'no heartbeat at all');
  assert.equal(keeperDecision({ now, lastHeartbeatAt: iso(-60), lastDispatchAt: null, lastAttemptAt: iso(-2) }).fire, false, 'cooldown after a failed dispatch');
});

test('scenario 8 (R1): the tick fires a titan-pulse dispatch when the heartbeat is old and stays quiet when it is fresh', async (t) => {
  const { world, env } = setup(t);
  const now = new Date('2026-10-08T12:00:00Z');
  world.github.files.set('state/heartbeat.json', JSON.stringify({ lastPulseAt: at(now, -300).toISOString() }));
  const fired = await tickKeeper(env, now);
  assert.equal(fired.action, 'fired');
  assert.deepEqual(world.github.dispatches.at(-1), { event_type: 'titan-pulse', client_payload: { source: 'keeper' } });
  assert.equal((await tickKeeper(env, at(now, 1))).action, 'quiet', 'the last dispatch is less than 14 minutes old');
  assert.equal((await tickKeeper(env, at(now, 15))).action, 'fired', 'the heartbeat is still old after 14 minutes');
  assert.equal(world.github.dispatches.filter((d) => d.event_type === 'titan-pulse').length, 2);

  // A heartbeat arrives through the callback route.
  const hb = await worker.fetch(post('/internal/pulse-heartbeat', { pulseId: 'run-1', status: 'ok' }, authed), env);
  assert.equal(hb.status, 200);
  const before = world.github.dispatches.length;
  assert.equal((await tickKeeper(env, at(new Date(), 40 * 0 + 5))).action, 'quiet');
  assert.equal(world.github.dispatches.length, before, 'a fresh heartbeat means no dispatch');
});

test('R1: a broken heartbeat call does not make the keeper dispatch while the committed state shows fresh pulses', async (t) => {
  const { world, env } = setup(t);
  const now = new Date('2026-10-08T12:00:00Z');
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('pulse.lastHeartbeatAt', ?)").bind(at(now, -90).toISOString()).run();
  world.github.files.set('state/heartbeat.json', JSON.stringify({ lastPulseAt: at(now, -4).toISOString() }));
  const out = await tickKeeper(env, now);
  assert.equal(out.action, 'quiet');
  assert.equal(world.github.dispatches.length, 0);
});

test('R1: a failed dispatch is recorded, waits five minutes, and raises an event', async (t) => {
  const { world, env } = setup(t);
  const now = new Date('2026-10-08T12:00:00Z');
  world.github.fail.dispatch = 500;
  assert.equal((await tickKeeper(env, now)).action, 'failed');
  assert.equal((await tickKeeper(env, at(now, 2))).action, 'quiet');
  world.github.fail.dispatch = null;
  assert.equal((await tickKeeper(env, at(now, 6))).action, 'fired');
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'pulse.late'").first()).n >= 1);
});

test('the pulse state route and the badge show only up or late and the age', async (t) => {
  const { env } = setup(t);
  await worker.fetch(post('/internal/pulse-heartbeat', { pulseId: 'run-9', status: 'ok' }, authed), env);
  const state = await (await worker.fetch(get('/admin/pulse', authed), env)).json();
  assert.equal(state.keeperHealthy, true);
  assert.ok(state.heartbeatAgeMinutes <= 1);
  const badge = await (await worker.fetch(get('/badge/pulse'), env)).json();
  assert.deepEqual(Object.keys(badge).sort(), ['cacheSeconds', 'color', 'label', 'message', 'schemaVersion']);
  assert.match(badge.message, /^up \d+m$/);
});
