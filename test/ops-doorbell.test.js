import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CRONS, JOBS, chicagoParts, planRun, ringDoorbell, ringUrl } from '../src/ops/doorbell.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const BACKEND = 'https://titan-backend.example.com';
const TOKEN = 'doorbell_fixture_token_0123456789';

test('RO6 jobs: the three jobs and the five crons of the contract', () => {
  assert.deepEqual([...JOBS], ['digest', 'weekly-review', 'sweep']);
  assert.deepEqual(Object.values(CRONS).sort(), ['digest', 'digest', 'sweep', 'weekly-review', 'weekly-review']);
});

test('RO6 chicago time: the weekday and the hour follow daylight saving', () => {
  assert.deepEqual(chicagoParts(new Date('2026-07-15T11:30:00Z')), { day: 3, hour: 6 }); // Wednesday, CDT
  assert.deepEqual(chicagoParts(new Date('2026-12-15T12:30:00Z')), { day: 2, hour: 6 }); // Tuesday, CST
  assert.deepEqual(chicagoParts(new Date('2026-07-20T00:00:00Z')), { day: 7, hour: 19 }); // Sunday evening, CDT
  assert.deepEqual(chicagoParts(new Date('2026-12-21T00:00:00Z')), { day: 7, hour: 18 }); // Sunday evening, CST
});

test('RO6 plan: a manual run always goes on, and an unknown job does not', () => {
  for (const job of JOBS) assert.deepEqual(planRun({ job, now: new Date('2026-07-15T03:00:00Z') }), { job, proceed: true, reason: 'a manual run' });
  assert.equal(planRun({ job: 'rm -rf /' }).proceed, false);
  assert.equal(planRun({ job: 'rm -rf /' }).job, null);
  assert.equal(planRun({ job: 'DIGEST' }).proceed, false);
});

test('RO6 plan: the sweep goes on at any time', () => {
  for (const iso of ['2026-07-15T00:00:00Z', '2026-12-15T13:45:00Z', '2026-11-01T06:30:00Z']) assert.equal(planRun({ schedule: '*/15 * * * *', now: new Date(iso) }).proceed, true, iso);
});

test('RO6 plan: the digest rings once a day at 06 in Chicago, in summer and in winter', () => {
  const at = (schedule, iso) => planRun({ schedule, now: new Date(iso) }).proceed;
  // Summer, UTC-5: 11:30 UTC is 06:30. 12:30 UTC is 07:30.
  assert.equal(at('30 11 * * *', '2026-07-15T11:30:00Z'), true);
  assert.equal(at('30 12 * * *', '2026-07-15T12:30:00Z'), false);
  // Winter, UTC-6: 12:30 UTC is 06:30. 11:30 UTC is 05:30.
  assert.equal(at('30 12 * * *', '2026-12-15T12:30:00Z'), true);
  assert.equal(at('30 11 * * *', '2026-12-15T11:30:00Z'), false);
  // GitHub often starts a cron late. A start 25 minutes late is still in hour 06.
  assert.equal(at('30 11 * * *', '2026-07-15T11:55:00Z'), true);
});

test('RO6 plan: exactly one of the two digest crons rings on every day of the year', () => {
  for (let d = 0; d < 366; d += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + d));
    const iso = (h) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, 30)).toISOString();
    const rings = [planRun({ schedule: '30 11 * * *', now: new Date(iso(11)) }), planRun({ schedule: '30 12 * * *', now: new Date(iso(12)) })].filter((p) => p.proceed).length;
    assert.equal(rings, 1, day.toISOString().slice(0, 10));
  }
});

test('RO6 plan: the weekly review rings once a week, on Sunday at 18 in Chicago', () => {
  const at = (schedule, iso) => planRun({ schedule, now: new Date(iso) }).proceed;
  // Summer: Sunday 18:00 CDT is 23:00 UTC on Sunday.
  assert.equal(at('0 23 * * 0', '2026-07-19T23:00:00Z'), true);
  assert.equal(at('0 0 * * 1', '2026-07-20T00:00:00Z'), false);
  // Winter: Sunday 18:00 CST is 00:00 UTC on Monday.
  assert.equal(at('0 0 * * 1', '2026-12-21T00:00:00Z'), true);
  assert.equal(at('0 23 * * 0', '2026-12-20T23:00:00Z'), false);
});

test('RO6 plan: exactly one of the two weekly crons rings in each week of the year', () => {
  let sundays = 0;
  for (let d = 0; d < 366; d += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + d));
    if (day.getUTCDay() !== 0) continue; // the UTC Sunday, for the first cron
    sundays += 1;
    const next = new Date(Date.UTC(2026, 0, 2 + d)); // the UTC Monday, for the second cron
    const first = planRun({ schedule: '0 23 * * 0', now: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 0)) }).proceed;
    const second = planRun({ schedule: '0 0 * * 1', now: new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), 0, 0)) }).proceed;
    assert.equal(Number(first) + Number(second), 1, day.toISOString().slice(0, 10));
  }
  assert.ok(sundays >= 52);
});

test('RO6 plan: a schedule that is not a doorbell cron does not ring', () => {
  for (const schedule of [null, '', '* * * * *', '0 0 * * *', '30 11 * * 1']) assert.equal(planRun({ schedule }).proceed, false, String(schedule));
});

test('RO6 url: the ring URL joins the backend URL and the job, and a bad backend URL gives null', () => {
  assert.equal(ringUrl(BACKEND, 'digest'), 'https://titan-backend.example.com/api/scheduled/digest');
  assert.equal(ringUrl(`${BACKEND}/`, 'sweep'), 'https://titan-backend.example.com/api/scheduled/sweep');
  assert.equal(ringUrl(`${BACKEND}/titan/`, 'weekly-review'), 'https://titan-backend.example.com/titan/api/scheduled/weekly-review');
  for (const bad of ['http://titan.example.com', 'ftp://x.example.com', 'https://user:pass@titan.example.com', 'https://titan.example.com/?a=1', 'https://titan.example.com/#x', 'not a url', '', undefined]) assert.equal(ringUrl(bad, 'sweep'), null, String(bad));
  assert.equal(ringUrl(BACKEND, 'other'), null);
  assert.equal(ringUrl(BACKEND, '../x'), null);
});

test('RO6 ring: it is a POST with a bearer token, no body, and no redirect', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response('{"digest":"private note text"}', { status: 200 }); };
  const out = await ringDoorbell('digest', { backendUrl: BACKEND, token: TOKEN, fetchImpl, lookup: publicLookup });
  assert.deepEqual(out, { status: 'rung', status_code: 200, reason: 'answered 200' });
  assert.equal(seen.url, 'https://titan-backend.example.com/api/scheduled/digest');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.init.body, undefined);
  assert.equal(seen.init.redirect, 'manual');
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test('RO6 ring: the answer body is never read and never returned', async () => {
  const res = new Response('the digest holds a private note', { status: 200 });
  for (const m of ['text', 'json', 'arrayBuffer', 'blob']) res[m] = () => { throw new Error(`the body was read with ${m}`); };
  const out = await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: async () => res, lookup: publicLookup });
  assert.equal(out.status, 'rung');
  assert.ok(!JSON.stringify(out).includes('private note'));
});

test('RO6 ring: an error code is kept as the status code, and a redirect is not followed', async () => {
  const calls = [];
  const reply = (status) => async (url) => { calls.push(url); return new Response('', { status }); };
  assert.deepEqual(await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: reply(401), lookup: publicLookup }), { status: 'failed', status_code: 401, reason: 'answered 401' });
  assert.equal((await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: reply(503), lookup: publicLookup })).status_code, 503);
  const redirect = await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: reply(302), lookup: publicLookup });
  assert.equal(redirect.status, 'failed');
  assert.equal(redirect.status_code, 302);
  assert.equal(calls.length, 3, 'one call for each ring, no second call to a redirect target');
});

test('RO6 ring: a network error or a timeout gives a null status code', async () => {
  const refused = await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${BACKEND} with ${TOKEN}`); }, lookup: publicLookup });
  assert.deepEqual(refused, { status: 'failed', status_code: null, reason: 'no connection' });
  const slow = await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, lookup: publicLookup });
  assert.deepEqual(slow, { status: 'failed', status_code: null, reason: 'no answer in time' });
});

test('RO6 ring: when a secret is not set, the ring is skipped and nothing is sent', async () => {
  const fetchImpl = async () => { throw new Error('must not call'); };
  for (const deps of [{}, { backendUrl: BACKEND }, { token: TOKEN }, { backendUrl: '', token: TOKEN }, { backendUrl: BACKEND, token: '' }]) {
    const out = await ringDoorbell('digest', { ...deps, fetchImpl, lookup: publicLookup });
    assert.equal(out.status, 'skipped');
    assert.equal(out.status_code, null);
  }
});

test('RO6 ring: an unusable or private backend URL is refused before any call', async () => {
  const fetchImpl = async () => { throw new Error('must not call'); };
  for (const backendUrl of ['http://titan.example.com', 'https://u:p@titan.example.com', 'nonsense']) {
    assert.equal((await ringDoorbell('sweep', { backendUrl, token: TOKEN, fetchImpl, lookup: publicLookup })).status, 'failed', backendUrl);
  }
  const priv = await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl, lookup: async () => [{ address: '169.254.169.254', family: 4 }] });
  assert.equal(priv.status, 'failed');
  assert.match(priv.reason, /egress guard/);
});

test('RO6 ring: no result holds the backend URL or the token', async () => {
  const outs = [
    await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: async () => new Response('', { status: 500 }), lookup: publicLookup }),
    await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: async () => { throw new Error(`${BACKEND} ${TOKEN}`); }, lookup: publicLookup }),
    await ringDoorbell('sweep', { backendUrl: BACKEND, token: TOKEN, fetchImpl: async () => { throw new Error('x'); }, lookup: async () => [{ address: '10.1.1.1', family: 4 }] }),
    await ringDoorbell('sweep', { backendUrl: 'https://user:pw@titan-backend.example.com', token: TOKEN }),
  ];
  for (const o of outs) {
    const text = JSON.stringify(o);
    assert.ok(!text.includes('titan-backend') && !text.includes(TOKEN) && !/https?:/.test(text), text);
  }
});

test('RO6 CLI: with no secrets it skips quietly with exit code 0 and prints no secret', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/ops-doorbell.mjs', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const skipped = run(['--job', 'sweep']);
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /skipped the sweep ring/);
  const half = run(['--job', 'digest'], { TITAN_BACKEND_URL: BACKEND });
  assert.equal(half.status, 0);
  assert.match(half.stdout, /skipped/);
  assert.ok(!half.stdout.includes('titan-backend') && !half.stderr.includes('titan-backend'));
});

test('RO6 CLI: a bad job name stops with code 1, and a schedule off the hour stops quietly', () => {
  const run = (args) => spawnSync(process.execPath, ['scripts/ops-doorbell.mjs', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, TITAN_BACKEND_URL: BACKEND, DOORBELL_TOKEN: TOKEN } });
  const bad = run(['--job', '$(whoami)']);
  assert.equal(bad.status, 1);
  assert.ok(!bad.stdout.includes(TOKEN));
  const unknown = run(['--schedule', '5 5 5 5 5']);
  assert.equal(unknown.status, 0);
  assert.match(unknown.stdout, /no ring/);
});
