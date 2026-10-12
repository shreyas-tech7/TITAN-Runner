// RT3: every write that the Worker sends to GitHub passes the Reviewer Gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { githubClient } from '../src/lib/github.js';
import { gateConnectorWrite, gateOwnRepoWrite, isGithubWrite, WorkerGateError } from '../src/lib/githubGate.js';
import { FakeWorld } from './helpers/world.mjs';

/** A key-shaped string built from parts, so the source holds no key-shaped literal. */
const FAKE_KEY = ['gsk', 'q'.repeat(30)].join('_');
const env = { GITHUB_OWNER: 'shreyas-tech7', GITHUB_REPO: 'TITAN-Runner' };
const base = '/repos/shreyas-tech7/TITAN-Runner';

test('gateOwnRepoWrite allows the shapes that the Worker uses and blocks the rest', () => {
  const ok = [
    ['POST', `${base}/dispatches`, { event_type: 'titan-pulse', client_payload: {} }],
    ['POST', `${base}/dispatches`, { event_type: 'spawn-subagent', client_payload: { id: 'x' } }],
    ['PUT', `${base}/actions/secrets/GROQ_API_KEY`, { encrypted_value: 'a', key_id: '1' }],
    ['PUT', `${base}/actions/secrets/TITAN_CALLBACK_TOKEN`, { encrypted_value: 'a', key_id: '1' }],
    ['DELETE', `${base}/actions/secrets/GEMINI_API_KEY`, undefined],
    ['POST', `${base}/issues/3/comments`, { body: 'hello' }],
  ];
  for (const [method, path, body] of ok) assert.doesNotThrow(() => gateOwnRepoWrite(env, { method, path, body }), `${method} ${path}`);
  const bad = [
    ['POST', `${base}/dispatches`, { event_type: 'anything' }],
    ['PUT', `${base}/actions/secrets/CLOUDFLARE_API_TOKEN`, { encrypted_value: 'a', key_id: '1' }],
    ['DELETE', `${base}`, undefined],
    ['POST', '/repos/someone/else/issues/1/comments', { body: 'x' }],
    ['PUT', `${base}/contents/README.md`, { message: 'x', content: 'eA==' }],
    ['POST', `${base}/git/refs`, { ref: 'refs/heads/x', sha: 'a' }],
  ];
  for (const [method, path, body] of bad) assert.throws(() => gateOwnRepoWrite(env, { method, path, body }), WorkerGateError, `${method} ${path}`);
});

test('the Worker GitHub client blocks a bad dispatch before it reaches GitHub, and cleans a comment', async (t) => {
  const world = new FakeWorld().install(t);
  const e = world.env();
  const gh = githubClient(e);
  await assert.rejects(() => gh.dispatch('rm-everything', {}), (err) => err.code === 'gate_blocked' && err.status === 403);
  assert.equal(world.github.dispatches.length, 0, 'nothing reached GitHub');
  await gh.dispatch('titan-pulse', { source: 'test' });
  assert.equal(world.github.dispatches.length, 1);
  world.github.issues.push({ number: 7 });
  await gh.commentOnIssue(7, `done, key ${FAKE_KEY}`);
  const sent = JSON.stringify(world.github.comments);
  assert.ok(!sent.includes(FAKE_KEY), 'the secret did not reach GitHub');
  assert.ok(sent.includes('done'));
});

test('connector writes to GitHub: an Issue and a comment pass, anything else is blocked, secrets are removed', () => {
  assert.equal(isGithubWrite('POST', 'https://api.github.com/repos/a/b/issues'), true);
  assert.equal(isGithubWrite('GET', 'https://api.github.com/repos/a/b/issues'), false);
  assert.equal(isGithubWrite('POST', 'https://hooks.slack.com/services/x'), false);
  const issue = gateConnectorWrite({ method: 'POST', url: 'https://api.github.com/repos/a/b/issues', body: JSON.stringify({ title: 'T', body: `k ${FAKE_KEY}`, labels: ['x'] }) });
  assert.ok(!issue.body.includes(FAKE_KEY));
  const comment = gateConnectorWrite({ method: 'POST', url: 'https://api.github.com/repos/a/b/issues/4/comments', body: JSON.stringify({ body: 'hi' }) });
  assert.equal(JSON.parse(comment.body).body, 'hi');
  for (const req of [
    { method: 'DELETE', url: 'https://api.github.com/repos/a/b' },
    { method: 'PUT', url: 'https://api.github.com/repos/a/b/contents/x.md', body: '{}' },
    { method: 'POST', url: 'https://api.github.com/repos/a/b/issues', body: JSON.stringify({ title: 'T', assignees: ['x'] }) },
    { method: 'POST', url: 'https://api.github.com/repos/a/b/issues', body: 'not json' },
    { method: 'POST', url: 'https://api.github.com/repos/a/b/dispatches', body: '{}' },
  ]) assert.throws(() => gateConnectorWrite(req), WorkerGateError, `${req.method} ${req.url}`);
});

test('static: every GitHub write path in the Worker goes through githubGate.js', () => {
  const github = readFileSync(new URL('../src/lib/github.js', import.meta.url), 'utf8');
  const call = github.slice(github.indexOf('async function call('));
  assert.ok(call.indexOf("method !== 'GET'") !== -1 && call.indexOf('gateOwnRepoWrite(') < call.indexOf('safeFetch('), 'the gate runs before the fetch in call()');
  const broker = readFileSync(new URL('../src/connectors/broker.js', import.meta.url), 'utf8');
  const send = broker.slice(broker.indexOf('export async function sendRequest'));
  assert.ok(send.indexOf('isGithubWrite(') !== -1 && send.indexOf('gateConnectorWrite(') < send.indexOf('safeFetch('), 'the broker gates GitHub writes before the fetch');
});
