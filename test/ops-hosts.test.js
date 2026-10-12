import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PULSE_STALE_MS, RENDER_COLD_MS, RENDER_MIN_INTERVAL_MS, alertPlan, configuredHosts, emptyHistory, failedTwice, githubStatus,
  hostsMirror, parseSpace, probeHost, spaceStatus, updateHistory, uptime,
} from '../src/ops/hosts.js';
import { checkStateFile } from '../scripts/check-state.mjs';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { ensureAlert, resolveAlert } from '../src/ops/alerts.js';

const NOW = new Date('2026-10-12T12:00:00Z');
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const reply = (status, body = '') => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const deps = (over = {}) => ({ now: () => NOW, lookup: publicLookup, clock: () => 0, ...over });
/** A clock that moves by `ms` between the first and the second reading. */
const slowClock = (ms) => { let n = 0; return () => (n++ === 0 ? 0 : ms); };
const host = (kind, url = 'https://example.com') => ({ name: `${kind}_x`, kind, url, minIntervalMs: 0 });

test('RO5 hosts: a host without a URL secret is skipped, and the two GitHub checks always run', () => {
  assert.deepEqual(configuredHosts({}).map((h) => h.name), ['github_actions', 'github_status']);
  const names = configuredHosts({ HOST_URL_HF_SPACE: 'a/b', HOST_URL_RENDER_2: 'https://r2.example.com', HOST_URL_HERMES_1: 'https://h1.example.com', HOST_URL_RENDER_3: '  ', GEV_URL: 'https://gev.example.com' }).map((h) => h.name);
  assert.deepEqual(names, ['github_actions', 'github_status', 'hf_space', 'render_2', 'titan_gev', 'hermes_1']);
});

test('RO5 hosts: a Render host is probed at most every 5.5 hours, and the others on every run', () => {
  const hosts = configuredHosts({ HOST_URL_RENDER_1: 'https://r1.example.com', HOST_URL_HERMES_1: 'https://h1.example.com', HOST_URL_GEV: 'https://gev.example.com' });
  for (const h of hosts) assert.equal(h.minIntervalMs, h.kind === 'render' ? RENDER_MIN_INTERVAL_MS : 0, h.name);
  assert.equal(RENDER_MIN_INTERVAL_MS, 5.5 * 3_600_000);
});

test('RO5 hosts: Space URLs parse, and an unsplittable hf.space host name does not', () => {
  assert.deepEqual(parseSpace('owner/name'), { owner: 'owner', name: 'name' });
  assert.deepEqual(parseSpace('https://huggingface.co/spaces/owner/name/'), { owner: 'owner', name: 'name' });
  assert.equal(parseSpace('https://owner-name.hf.space'), null);
  assert.equal(parseSpace(''), null);
  assert.equal(parseSpace('../../etc'), null);
});

test('RO5 hosts: status mapping for Space stages and the GitHub indicator', () => {
  assert.equal(spaceStatus('RUNNING'), 'up');
  assert.equal(spaceStatus('SLEEPING'), 'asleep');
  assert.equal(spaceStatus('BUILDING'), 'asleep');
  for (const stage of ['RUNTIME_ERROR', 'BUILD_ERROR', 'CONFIG_ERROR', 'STOPPED', 'PAUSED', 'NO_APP_FILE', undefined, '']) assert.equal(spaceStatus(stage), 'down', String(stage));
  assert.equal(githubStatus('none'), 'up');
  assert.equal(githubStatus('minor'), 'up');
  assert.equal(githubStatus('major'), 'down');
  assert.equal(githubStatus('critical'), 'down');
});

test('RO5 pulse: a recent success is up, and a success older than 45 minutes is down', async () => {
  const pulseHost = { name: 'github_actions', kind: 'github-pulse', url: null };
  const fresh = await probeHost(pulseHost, deps({ pulse: async () => ({ lastSuccessAt: at(10) }) }));
  assert.equal(fresh.status, 'up');
  assert.equal(fresh.last_pulse_at, at(10));
  const edge = await probeHost(pulseHost, deps({ pulse: async () => ({ lastSuccessAt: new Date(NOW.getTime() - PULSE_STALE_MS).toISOString() }) }));
  assert.equal(edge.status, 'up', 'exactly 45 minutes is not stale yet');
  const stale = await probeHost(pulseHost, deps({ pulse: async () => ({ lastSuccessAt: at(46) }) }));
  assert.equal(stale.status, 'down');
  assert.match(stale.reason, /46 minutes old/);
  const none = await probeHost(pulseHost, deps({ pulse: async () => ({ lastSuccessAt: null }) }));
  assert.equal(none.status, 'down');
  assert.equal(none.last_pulse_at, null);
});

test('RO5 pulse: when GitHub does not answer there is no entry, so a GitHub outage is not blamed on the pulse', async () => {
  const pulseHost = { name: 'github_actions', kind: 'github-pulse', url: null };
  assert.equal(await probeHost(pulseHost, deps({ pulse: async () => null })), null);
  assert.equal(await probeHost(pulseHost, deps({ pulse: async () => { throw new Error('boom'); } })), null);
  assert.equal(await probeHost(pulseHost, deps({})), null);
});

test('RO5 GitHub status: the indicator decides, and an unreadable answer gives no entry', async () => {
  const h = { name: 'github_status', kind: 'github-status', url: null };
  assert.equal((await probeHost(h, deps({ fetchImpl: reply(200, { status: { indicator: 'none' } }) }))).status, 'up');
  assert.equal((await probeHost(h, deps({ fetchImpl: reply(200, { status: { indicator: 'major' } }) }))).status, 'down');
  assert.equal(await probeHost(h, deps({ fetchImpl: reply(503) })), null);
  assert.equal(await probeHost(h, deps({ fetchImpl: async () => { throw new Error('offline'); } })), null);
});

test('RO5 Space: the Hub API says running, sleeping, or broken, and the probe never calls the Space itself', async () => {
  const calls = [];
  const fetchImpl = (stage) => async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ runtime: { stage } }), { status: 200 }); };
  const h = host('hf-space', 'owner/name');
  assert.equal((await probeHost(h, deps({ fetchImpl: fetchImpl('RUNNING') }))).status, 'up');
  assert.equal((await probeHost(h, deps({ fetchImpl: fetchImpl('SLEEPING') }))).status, 'asleep');
  assert.equal((await probeHost(h, deps({ fetchImpl: fetchImpl('RUNTIME_ERROR') }))).status, 'down');
  for (const c of calls) assert.match(c.url, /^https:\/\/huggingface\.co\/api\/spaces\/owner\/name$/);
  assert.equal((await probeHost(h, deps({ fetchImpl: reply(404) }))).status, 'down');
  assert.equal(await probeHost(h, deps({ fetchImpl: async () => { throw new Error('offline'); } })), null, 'the Hub was not reachable: no evidence about the Space');
  const bad = await probeHost(host('hf-space', 'https://owner-name.hf.space'), deps({ fetchImpl: reply(200) }));
  assert.equal(bad.status, 'down');
  assert.match(bad.reason, /not owner\/name/);
});

test('RO5 Space: the Hugging Face token goes only to the Hub, as a header', async () => {
  let seen;
  await probeHost(host('hf-space', 'owner/name'), deps({ hfToken: 'hf_fixture_token_value', fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{}', { status: 200 }); } }));
  assert.equal(seen.init.headers.authorization, 'Bearer hf_fixture_token_value');
  assert.ok(!seen.url.includes('hf_fixture'));
});

test('RO5 Render: a fast answer is up, a cold start is asleep, an error or a timeout is down', async () => {
  const h = host('render');
  assert.equal((await probeHost(h, deps({ fetchImpl: reply(200, 'ok'), clock: slowClock(800) }))).status, 'up');
  assert.equal((await probeHost(h, deps({ fetchImpl: reply(404), clock: slowClock(800) }))).status, 'up', 'a 404 from a running service is still an answer');
  const cold = await probeHost(h, deps({ fetchImpl: reply(200, 'ok'), clock: slowClock(RENDER_COLD_MS + 4000) }));
  assert.equal(cold.status, 'asleep');
  assert.match(cold.reason, /cold start/);
  assert.equal((await probeHost(h, deps({ fetchImpl: reply(502), clock: slowClock(800) }))).status, 'down');
  const timeout = await probeHost(h, deps({ fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, clock: slowClock(75_000) }));
  assert.equal(timeout.status, 'down');
  assert.match(timeout.reason, /75 seconds/);
  const refused = await probeHost(h, deps({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, clock: slowClock(5) }));
  assert.equal(refused.status, 'down');
});

test('RO5 Render: the request waits 75 seconds and does not follow a redirect', async () => {
  let init;
  await probeHost(host('render'), deps({ fetchImpl: async (url, i) => { init = i; return new Response('ok'); }, clock: slowClock(5) }));
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
});

test('RO5 Hermes: it asks for the model list with no key, and 401 means up', async () => {
  let seen;
  const probe = (status) => probeHost(host('hermes', 'https://hermes.example.com/'), deps({ clock: slowClock(40), fetchImpl: async (url, init) => { seen = { url, init }; return new Response('', { status }); } }));
  assert.equal((await probe(401)).status, 'up');
  assert.equal(seen.url, 'https://hermes.example.com/v1/models');
  assert.equal(seen.init.headers, undefined, 'no key is sent');
  assert.equal((await probe(200)).status, 'up');
  assert.equal((await probe(403)).status, 'up');
  assert.equal((await probe(404)).status, 'down');
  assert.equal((await probe(500)).status, 'down');
});

test('RO5 egress: a URL that resolves to a private address is refused, and the reason holds no URL', async () => {
  const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
  const r = await probeHost(host('hermes', 'https://internal.example.com'), deps({ lookup: privateLookup, fetchImpl: async () => { throw new Error('must not call'); } }));
  assert.equal(r.status, 'down');
  assert.match(r.reason, /refused/);
  assert.ok(!/https?:\/\//.test(r.reason));
  const http = await probeHost(host('render', 'http://plain.example.com'), deps({ fetchImpl: async () => { throw new Error('must not call'); } }));
  assert.equal(http.status, 'down');
  const junk = await probeHost(host('render', 'not a url'), deps({ fetchImpl: async () => { throw new Error('must not call'); } }));
  assert.equal(junk.status, 'down');
});

test('RO5 result: no probe result holds the URL of a host', async () => {
  const secretUrl = 'https://very-private-name.onrender.com/health';
  const results = [
    await probeHost(host('render', secretUrl), deps({ fetchImpl: reply(200), clock: slowClock(10) })),
    await probeHost(host('render', secretUrl), deps({ fetchImpl: reply(500), clock: slowClock(10) })),
    await probeHost(host('render', secretUrl), deps({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] })),
    await probeHost(host('hermes', secretUrl), deps({ fetchImpl: async () => { throw new Error(`failed to reach ${secretUrl}`); }, clock: slowClock(10) })),
  ];
  for (const r of results) assert.ok(!JSON.stringify(r).includes('very-private-name'), JSON.stringify(r));
});

test('RO5 history: results add up, and entries older than 30 days drop out', () => {
  let h = emptyHistory();
  h = updateHistory(h, [{ host: 'render_1', status: 'up', last_check: at(60 * 24 * 31) }], new Date(NOW.getTime() - 60 * 60_000 * 24 * 30));
  h = updateHistory(h, [{ host: 'render_1', status: 'down', last_check: at(10) }, { host: 'hermes_1', status: 'asleep', last_check: at(10) }], NOW);
  assert.deepEqual(h.hosts.render_1, [[at(10), 'd']], 'the 31 day old entry is gone');
  assert.deepEqual(h.hosts.hermes_1, [[at(10), 'a']]);
  assert.equal(h.version, 1);
});

test('RO5 history: the input is not changed', () => {
  const before = emptyHistory();
  updateHistory(before, [{ host: 'x', status: 'up', last_check: at(1) }], NOW);
  assert.deepEqual(before, emptyHistory());
});

test('RO5 uptime: up and asleep count as available, down does not, and a window with no check is null', () => {
  const h = { version: 1, hosts: { a: [[at(60 * 24 * 20), 'd'], [at(60 * 24 * 3), 'u'], [at(60 * 5), 'a'], [at(60), 'd'], [at(10), 'u']] } };
  assert.equal(uptime(h, 'a', 86_400_000, NOW), 66.7, '24h: asleep, down, up');
  assert.equal(uptime(h, 'a', 7 * 86_400_000, NOW), 75, '7d: 3 of 4 are not down');
  assert.equal(uptime(h, 'a', 30 * 86_400_000, NOW), 60, '30d: 3 of 5 are not down');
  assert.equal(uptime(h, 'missing', 86_400_000, NOW), null);
  assert.equal(uptime({ version: 1, hosts: { a: [[at(60 * 48), 'u']] } }, 'a', 86_400_000, NOW), null);
});

test('RO5 failedTwice: the last two checks must both be down', () => {
  const h = (...codes) => ({ version: 1, hosts: { x: codes.map((c, i) => [at(100 - i), c]) } });
  assert.equal(failedTwice(h('u', 'd', 'd'), 'x'), true);
  assert.equal(failedTwice(h('d', 'u', 'd'), 'x'), false);
  assert.equal(failedTwice(h('d'), 'x'), false);
  assert.equal(failedTwice(h('d', 'a', 'd'), 'x'), false);
  assert.equal(failedTwice(h('d', 'd'), 'missing'), false);
});

test('RO5 mirror: it holds host names only, sorted, with the three uptime numbers, and passes the state check', () => {
  let h = emptyHistory();
  h = updateHistory(h, [
    { host: 'render_1', status: 'asleep', last_check: at(30) },
    { host: 'github_actions', status: 'up', last_check: at(5) },
  ], NOW);
  const mirror = hostsMirror(h, { github_actions: { last_pulse_at: at(7) } }, NOW);
  assert.equal(mirror.contract, '1');
  assert.deepEqual(Object.keys(mirror.hosts), ['github_actions', 'render_1']);
  assert.deepEqual(mirror.hosts.github_actions, { status: 'up', last_check: at(5), uptime_24h: 100, uptime_7d: 100, uptime_30d: 100, last_pulse_at: at(7) });
  assert.equal(mirror.hosts.render_1.status, 'asleep');
  assert.ok(!('last_pulse_at' in mirror.hosts.render_1));
  assert.deepEqual(checkStateFile('ops/hosts.json', Buffer.from(JSON.stringify(mirror))), []);
  assert.deepEqual(checkStateFile('ops/hosts-history.json', Buffer.from(JSON.stringify(h))), []);
});

test('RO5 mirror: a state file with an extra field fails the strict check', () => {
  const mirror = hostsMirror(updateHistory(emptyHistory(), [{ host: 'render_1', status: 'up', last_check: at(5) }], NOW), {}, NOW);
  mirror.hosts.render_1.url = 'https://x.example.com';
  assert.notDeepEqual(checkStateFile('ops/hosts.json', Buffer.from(JSON.stringify(mirror))), []);
});

test('RO5 alerts: two failed checks in a row open an alert, and one failed check does not', () => {
  const once = updateHistory(updateHistory(emptyHistory(), [{ host: 'hermes_1', status: 'up', last_check: at(200) }], NOW), [{ host: 'hermes_1', status: 'down', last_check: at(10), reason: 'x' }], NOW);
  assert.deepEqual(alertPlan(once, [{ host: 'hermes_1', status: 'down', last_check: at(10) }]), []);
  const twice = updateHistory(once, [{ host: 'hermes_1', status: 'down', last_check: at(1), reason: 'x' }], NOW);
  const plan = alertPlan(twice, [{ host: 'hermes_1', status: 'down', last_check: at(1) }]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'open');
  assert.equal(plan[0].title, 'Host down: hermes_1');
  assert.match(plan[0].body, /failed its last 2 checks/);
});

test('RO5 alerts: a stale pulse opens an alert at once', () => {
  const h = updateHistory(emptyHistory(), [{ host: 'github_actions', status: 'down', last_check: at(1) }], NOW);
  const plan = alertPlan(h, [{ host: 'github_actions', status: 'down', last_check: at(1), last_pulse_at: at(80) }]);
  assert.equal(plan[0].action, 'open');
  assert.match(plan[0].body, /no successful run in the last 45 minutes/);
});

test('RO5 alerts: recovery closes the alert, and asleep counts as recovered', () => {
  const h = updateHistory(emptyHistory(), [{ host: 'render_1', status: 'asleep', last_check: at(1) }], NOW);
  const plan = alertPlan(h, [{ host: 'render_1', status: 'asleep', last_check: at(1) }, { host: 'hermes_1', status: 'up', last_check: at(1) }]);
  assert.deepEqual(plan.map((p) => [p.action, p.host]), [['close', 'render_1'], ['close', 'hermes_1']]);
});

test('RO5 alerts: no alert text holds a URL', () => {
  const h = updateHistory(updateHistory(emptyHistory(), [{ host: 'render_1', status: 'down', last_check: at(200) }], NOW), [{ host: 'render_1', status: 'down', last_check: at(1) }], NOW);
  const plan = alertPlan(h, [{ host: 'render_1', status: 'down', last_check: at(1), reason: 'no connection to https://secret.example.com' }]);
  for (const p of plan) assert.ok(!/https?:\/\//.test(`${p.title}${p.body}`));
});

test('RO5 alert flow: a host that fails twice opens one host-alert Issue, a repeat opens no second one, and recovery closes it', async () => {
  const gh = new FakeGitHub({ fixture: { issues: [] } });
  let h = emptyHistory();
  const run = async (status, minutesAgo) => {
    const r = { host: 'hermes_1', status, last_check: at(minutesAgo), reason: 'x' };
    h = updateHistory(h, [r], NOW);
    const out = [];
    for (const a of alertPlan(h, [r])) {
      out.push(a.action === 'open'
        ? await ensureAlert(gh, { label: 'host-alert', title: a.title, body: a.body })
        : await resolveAlert(gh, { label: 'host-alert', title: a.title, comment: a.body }));
    }
    return out;
  };
  assert.deepEqual(await run('down', 300), []);
  const opened = await run('down', 200);
  assert.equal(opened[0].action, 'opened');
  const again = await run('down', 100);
  assert.equal(again[0].action, 'exists', 'the open Issue is reused');
  const open = await gh.listIssuesByLabel('host-alert', 'open');
  assert.equal(open.length, 1);
  assert.equal(open[0].title, 'Host down: hermes_1');
  const closed = await run('up', 10);
  assert.equal(closed[0].action, 'closed');
  assert.equal((await gh.listIssuesByLabel('host-alert', 'open')).length, 0);
});
