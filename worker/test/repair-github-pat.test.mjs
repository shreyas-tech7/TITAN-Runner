// The repair workflow must validate a candidate GITHUB_PAT before it changes the Worker secret.
// These tests use the fake GitHub world and a fake Wrangler. They never reach the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repairGithubPat } from '../scripts/repair-github-pat.mjs';
import { captureConsole, FakeWorld } from './helpers/world.mjs';

const CANDIDATE = ['github', '_pat_', 'REPAIR_TEST_CANDIDATE_NOT_A_REAL_SECRET'].join('');
const ADMIN = ['admin', 'repair', 'test', 'token'].join('-');
const CF_TOKEN = ['cf', 'repair', 'test', 'token'].join('-');
const CF_ACCOUNT = 'repair-test-account';

function baseEnv(overrides = {}) {
  return {
    REPAIR_MODE: 'check',
    GITHUB_REPOSITORY: 'shreyas-tech7/TITAN-Runner',
    TITAN_WORKER_URL: 'https://titan-runner-brain.titan-runner.workers.dev',
    TITAN_ADMIN_TOKEN: ADMIN,
    GITHUB_PAT: CANDIDATE,
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT,
    ...overrides,
  };
}

function workerFetch(state) {
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    state.workerCalls.push(`${init.method ?? 'GET'} ${path}`);
    assert.equal(init.headers['X-Titan-Auth'], ADMIN);
    if (path === '/admin/diagnose') {
      return new Response(JSON.stringify({ ok: state.liveOk }), { status: 200 });
    }
    if (path === '/admin/diagnose/secret-roundtrip') {
      return new Response(JSON.stringify({ ok: state.liveProbeOk, steps: [{ step: 'write secret', ok: state.liveProbeOk }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  };
}

function setup(t, { liveOk = false, liveProbeOk = true } = {}) {
  const world = new FakeWorld().install(t);
  const state = { liveOk, liveProbeOk, workerCalls: [], wranglerCalls: [], logs: [] };
  const wranglerImpl = async (args, input) => {
    state.wranglerCalls.push({ args, input });
    if (args[0] === 'secret' && args[1] === 'list') return JSON.stringify([{ name: 'TITAN_ADMIN_TOKEN', type: 'secret_text' }]);
    if (args[0] === 'secret' && args[1] === 'put') {
      state.liveOk = true;
      return '';
    }
    throw new Error('unexpected wrangler call');
  };
  const opts = {
    env: baseEnv(),
    fetchImpl: workerFetch(state),
    wranglerImpl,
    sleep: async () => {},
    log: (line) => state.logs.push(line),
  };
  return { world, state, opts };
}

test('check mode validates the candidate with GitHub and changes no Cloudflare secret', async (t) => {
  const { world, state, opts } = setup(t);
  const result = await repairGithubPat(opts);
  assert.deepEqual(result, { ok: true, currentOk: false, candidateValid: true, repaired: false });
  assert.equal(state.wranglerCalls.length, 0);
  assert.deepEqual(state.workerCalls, ['GET /admin/diagnose']);
  assert.deepEqual(world.trail(), [
    'api.github.com GET /repos/shreyas-tech7/TITAN-Runner/actions/secrets/public-key',
    'api.github.com GET /repos/shreyas-tech7/TITAN-Runner/actions/secrets',
    'api.github.com GET /repos/shreyas-tech7/TITAN-Runner/issues',
    'api.github.com GET /repos/shreyas-tech7/TITAN-Runner/actions/workflows/worker-deploy.yml/runs',
    'api.github.com GET /repos/shreyas-tech7/TITAN-Runner/actions/variables/TITAN_WORKER_URL',
  ]);
  assert.equal(world.github.secrets.has('TITAN_DIAG_PROBE'), false, 'check mode writes no probe');
});

test('an absent repository secret fails without a Cloudflare change', async (t) => {
  const { state, opts } = setup(t);
  opts.env = baseEnv({ GITHUB_PAT: undefined });
  const result = await repairGithubPat(opts);
  assert.equal(result.ok, false);
  assert.equal(result.candidateValid, false);
  assert.equal(state.wranglerCalls.length, 0);
  assert.match(state.logs.join('\n'), /repository Actions secret GITHUB_PAT is absent/);
});

test('a whitespace-bearing candidate fails before GitHub or Cloudflare receives it', async (t) => {
  const { world, state, opts } = setup(t);
  opts.env = baseEnv({ GITHUB_PAT: `${CANDIDATE}\n` });
  await assert.rejects(() => repairGithubPat(opts), /must not contain whitespace/);
  assert.equal(state.wranglerCalls.length, 0);
  assert.equal(world.trail().length, 0);
});

test('GitHub 401 for the candidate stops the repair before Wrangler and never logs the candidate', async (t) => {
  const { world, state, opts } = setup(t);
  const logs = captureConsole(t);
  world.github.fail.publicKey = 401;
  await assert.rejects(() => repairGithubPat(opts), /GitHub rejected the candidate GITHUB_PAT/);
  assert.equal(state.wranglerCalls.length, 0);
  assert.ok(!logs().includes(CANDIDATE));
  assert.ok(!state.logs.join('\n').includes(CANDIDATE));
});

test('repair mode validates, probes, updates only GITHUB_PAT, and verifies the live Worker', async (t) => {
  const { world, state, opts } = setup(t);
  world.github.setByHand('GEMINI_API_KEY', 'fake-gemini-key-for-repair-test');
  opts.env = baseEnv({ REPAIR_MODE: 'repair' });
  const result = await repairGithubPat(opts);
  assert.deepEqual(result, { ok: true, currentOk: false, candidateValid: true, repaired: true });
  assert.deepEqual(state.wranglerCalls.map((c) => c.args), [
    ['secret', 'list', '--format', 'json'],
    ['secret', 'put', 'GITHUB_PAT'],
  ]);
  assert.equal(state.wranglerCalls[1].input, CANDIDATE, 'the candidate goes to Wrangler over stdin, not an argument');
  assert.ok(!state.wranglerCalls[1].args.includes(CANDIDATE));
  assert.deepEqual(state.workerCalls, ['GET /admin/diagnose', 'GET /admin/diagnose', 'POST /admin/diagnose/secret-roundtrip']);
  assert.equal(world.github.secrets.has('TITAN_DIAG_PROBE'), false, 'the candidate probe is deleted');
  assert.deepEqual(world.github.deleted, ['TITAN_DIAG_PROBE']);
  assert.equal(world.github.open('GEMINI_API_KEY'), 'fake-gemini-key-for-repair-test', 'a provider key is untouched');
  // The candidate may appear only as Wrangler stdin. It must never appear in a log line or an argv array.
  const publicTrail = JSON.stringify([state.logs, state.wranglerCalls.map((c) => c.args), world.trail()]);
  for (const secret of [CANDIDATE, ADMIN, CF_TOKEN, CF_ACCOUNT]) assert.ok(!publicTrail.includes(secret), 'no secret in the log or argv');
});

test('a candidate that cannot write secrets stops before the Worker secret put', async (t) => {
  const { world, state, opts } = setup(t);
  world.github.fail.put = 403;
  opts.env = baseEnv({ REPAIR_MODE: 'repair' });
  await assert.rejects(() => repairGithubPat(opts), /cannot complete the secret write probe/);
  assert.deepEqual(state.wranglerCalls.map((c) => c.args), [['secret', 'list', '--format', 'json']]);
  assert.equal(world.github.secrets.has('TITAN_DIAG_PROBE'), false);
});

test('a live Worker that still rejects the token after the put fails the run', async (t) => {
  const { state, opts } = setup(t);
  opts.env = baseEnv({ REPAIR_MODE: 'repair' });
  const original = opts.fetchImpl;
  opts.fetchImpl = async (url, init) => {
    const res = await original(url, init);
    if (new URL(url).pathname === '/admin/diagnose') return new Response(JSON.stringify({ ok: false }), { status: 200 });
    return res;
  };
  await assert.rejects(() => repairGithubPat(opts), /still rejects GITHUB_PAT after the update/);
  assert.equal(state.wranglerCalls.length, 2);
});

test('the workflow is manual, least-privilege, serialized with deploy, and holds no provider key', () => {
  const text = readFileSync(new URL('../../.github/workflows/worker-pat-repair.yml', import.meta.url), 'utf8');
  assert.match(text, /^on:\n  workflow_dispatch:/m);
  assert.ok(!/pull_request|push:|schedule:/.test(text));
  assert.match(text, /^permissions:\n  contents: read$/m);
  assert.match(text, /group: worker-deploy/);
  const secrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'GITHUB_PAT', 'TITAN_ADMIN_TOKEN']);
  assert.ok(!/secrets\.[A-Z0-9_]*API_KEY/.test(text), 'the repair workflow never receives a provider key');
});
