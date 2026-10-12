import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkChangedPaths, checkGitPush, checkRestWrite, checkVmCommand, cleanText, findSecretsInDiff,
} from '../src/reviewer/githubGatePolicy.js';
import { GateBlockedError, createRestWriter, gatedCommit, gatedPush, gateVmCommand } from '../src/reviewer/githubGate.js';

const REPO = 'owner/repo';
const ctx = { repository: REPO, secretNames: ['GROQ_API_KEY', 'GEMINI_API_KEY'] };
/** A key-shaped string that is built from parts, so the source holds no key-shaped literal. */
const FAKE_KEY = ['gsk', 'a'.repeat(30)].join('_');

// ---------------------------------------------------------------------
// REST writes, table tests
// ---------------------------------------------------------------------

const REST_CASES = [
  // [name, request, expected ok, expected kind or reason fragment]
  ['comment on an Issue', { method: 'POST', path: `/repos/${REPO}/issues/12/comments`, body: { body: 'hello' } }, true, 'comment'],
  ['comment with an extra field', { method: 'POST', path: `/repos/${REPO}/issues/12/comments`, body: { body: 'hi', assignees: ['x'] } }, false, 'only a body'],
  ['comment that is not a string', { method: 'POST', path: `/repos/${REPO}/issues/12/comments`, body: { body: 42 } }, false, 'must be a string'],
  ['comment on another repository', { method: 'POST', path: '/repos/other/repo/issues/12/comments', body: { body: 'hi' } }, false, 'only this repository'],
  ['open an Issue with host-alert', { method: 'POST', path: `/repos/${REPO}/issues`, body: { title: 'Down', body: 'x', labels: ['host-alert'] } }, true, 'create_issue'],
  ['open an Issue with a free label', { method: 'POST', path: `/repos/${REPO}/issues`, body: { title: 'Down', body: 'x', labels: ['bug'] } }, false, 'labels must be'],
  ['open an Issue with assignees', { method: 'POST', path: `/repos/${REPO}/issues`, body: { title: 'Down', assignees: ['x'] } }, false, 'unknown field'],
  ['close an Issue', { method: 'PATCH', path: `/repos/${REPO}/issues/3`, body: { state: 'closed', state_reason: 'completed' } }, true, 'update_issue'],
  ['edit an Issue title', { method: 'PATCH', path: `/repos/${REPO}/issues/3`, body: { title: 'new' } }, false, 'only the state'],
  ['add the ignored label', { method: 'POST', path: `/repos/${REPO}/issues/3/labels`, body: { labels: ['titan-ignored'] } }, true, 'add_labels'],
  ['add a label that is not titan-', { method: 'POST', path: `/repos/${REPO}/issues/3/labels`, body: { labels: ['wontfix'] } }, false, 'labels must be'],
  ['remove titan-task', { method: 'DELETE', path: `/repos/${REPO}/issues/3/labels/titan-task` }, true, 'remove_label'],
  ['remove another label', { method: 'DELETE', path: `/repos/${REPO}/issues/3/labels/security` }, false, 'may not be removed'],
  ['draft pull request from self-improve', { method: 'POST', path: `/repos/${REPO}/pulls`, body: { title: 't', head: 'self-improve/x-1', base: 'main', draft: true, body: 'b' } }, true, 'create_pr'],
  ['pull request that is not a draft', { method: 'POST', path: `/repos/${REPO}/pulls`, body: { title: 't', head: 'self-improve/x-1', base: 'main', draft: false } }, false, 'draft'],
  ['pull request from another branch', { method: 'POST', path: `/repos/${REPO}/pulls`, body: { title: 't', head: 'feature', base: 'main', draft: true } }, false, 'self-improve/'],
  ['pull request into another base', { method: 'POST', path: `/repos/${REPO}/pulls`, body: { title: 't', head: 'self-improve/x', base: 'release', draft: true } }, false, 'base branch'],
  ['close a pull request', { method: 'PATCH', path: `/repos/${REPO}/pulls/9`, body: { state: 'closed' } }, true, 'close_pr'],
  ['merge a pull request', { method: 'PUT', path: `/repos/${REPO}/pulls/9/merge`, body: {} }, false, 'no rule allows'],
  ['dispatch the pulse', { method: 'POST', path: `/repos/${REPO}/dispatches`, body: { event_type: 'titan-pulse', client_payload: { source: 'keeper' } } }, true, 'dispatch'],
  ['dispatch an unknown event', { method: 'POST', path: `/repos/${REPO}/dispatches`, body: { event_type: 'deploy-everything' } }, false, 'not on the allowlist'],
  ['put a provider secret', { method: 'PUT', path: `/repos/${REPO}/actions/secrets/GROQ_API_KEY`, body: { encrypted_value: 'abc', key_id: '1' } }, true, 'put_secret'],
  ['put the callback secret', { method: 'PUT', path: `/repos/${REPO}/actions/secrets/TITAN_CALLBACK_TOKEN`, body: { encrypted_value: 'abc', key_id: '1' } }, true, 'put_secret'],
  ['put a secret that is not managed', { method: 'PUT', path: `/repos/${REPO}/actions/secrets/CLOUDFLARE_API_TOKEN`, body: { encrypted_value: 'abc', key_id: '1' } }, false, 'not a secret that Runner manages'],
  ['put a secret in plain text', { method: 'PUT', path: `/repos/${REPO}/actions/secrets/GROQ_API_KEY`, body: { value: 'plain' } }, false, 'encrypted value'],
  ['delete a provider secret', { method: 'DELETE', path: `/repos/${REPO}/actions/secrets/GEMINI_API_KEY` }, true, 'delete_secret'],
  ['delete the repository', { method: 'DELETE', path: `/repos/${REPO}` }, false, 'only this repository'],
  ['delete a branch ref', { method: 'DELETE', path: `/repos/${REPO}/git/refs/heads/main` }, false, 'no rule allows'],
  ['create a ref', { method: 'POST', path: `/repos/${REPO}/git/refs`, body: { ref: 'refs/heads/x', sha: 'abc' } }, false, 'no rule allows'],
  ['a GET is not a write', { method: 'GET', path: `/repos/${REPO}/issues` }, false, 'not a write method'],
];

for (const [name, request, ok, expect] of REST_CASES) {
  test(`REST gate: ${name}`, () => {
    const v = checkRestWrite(request, ctx);
    assert.equal(v.ok, ok, `${name}: ${v.reason}`);
    if (ok) assert.equal(v.kind, expect);
    else assert.ok(String(v.reason).includes(expect), `${name}: reason "${v.reason}" should mention "${expect}"`);
  });
}

test('REST gate: secret-shaped text and email addresses are removed from a comment, and the write goes on', () => {
  const v = checkRestWrite({ method: 'POST', path: `/repos/${REPO}/issues/1/comments`, body: { body: `key ${FAKE_KEY} mail someone@example.com ok` } }, ctx);
  assert.equal(v.ok, true);
  assert.ok(!v.body.body.includes(FAKE_KEY));
  assert.ok(!v.body.body.includes('someone@example.com'));
  assert.equal(v.redactions, 2);
  assert.ok(v.body.body.includes('ok'));
});

test('REST gate: a commit hash is not mistaken for a secret', () => {
  const sha = 'a'.repeat(40);
  const v = checkRestWrite({ method: 'POST', path: `/repos/${REPO}/issues/1/comments`, body: { body: `see ${sha}` } }, ctx);
  assert.equal(v.body.body, `see ${sha}`);
});

test('REST gate: a comment over the size limit is blocked', () => {
  const v = checkRestWrite({ method: 'POST', path: `/repos/${REPO}/issues/1/comments`, body: { body: 'x'.repeat(60_001) } }, ctx);
  assert.equal(v.ok, false);
});

test('REST gate: a dispatch payload is cleaned too', () => {
  const v = checkRestWrite({ method: 'POST', path: `/repos/${REPO}/dispatches`, body: { event_type: 'spawn-subagent', client_payload: { id: '1', brief: `use ${FAKE_KEY}` } } }, ctx);
  assert.equal(v.ok, true);
  assert.ok(!JSON.stringify(v.body).includes(FAKE_KEY));
});

// ---------------------------------------------------------------------
// git
// ---------------------------------------------------------------------

const PUSH_CASES = [
  ['push HEAD to the run branch', ['--quiet', 'origin', 'HEAD:main'], 'main', true],
  ['push to a self-improve branch', ['--quiet', 'origin', 'HEAD:self-improve/t-1'], 'main', true],
  ['push to another branch', ['--quiet', 'origin', 'HEAD:release'], 'main', false],
  ['force push', ['--force', 'origin', 'HEAD:main'], 'main', false],
  ['short force flag', ['-f', 'origin', 'HEAD:main'], 'main', false],
  ['force with lease', ['--force-with-lease', 'origin', 'HEAD:main'], 'main', false],
  ['delete a branch', ['origin', ':main'], 'main', false],
  ['plus refspec', ['origin', '+HEAD:main'], 'main', false],
  ['push to another remote', ['evil', 'HEAD:main'], 'main', false],
  ['push all branches', ['--all', 'origin'], 'main', false],
  ['push tags', ['--tags', 'origin'], 'main', false],
  ['two refspecs', ['origin', 'HEAD:main', 'HEAD:other'], 'main', false],
  ['push to the feature branch of the run', ['origin', 'HEAD:feature/x'], 'feature/x', true],
];
for (const [name, args, currentRef, ok] of PUSH_CASES) {
  test(`git gate: ${name}`, () => {
    assert.equal(checkGitPush(args, { currentRef }).ok, ok, JSON.stringify(args));
  });
}

test('git gate: changed paths must sit under the allowed roots', () => {
  assert.equal(checkChangedPaths(['state/tasks.json', 'state/ops/health.json'], { roots: ['state'] }).ok, true);
  assert.equal(checkChangedPaths(['state/tasks.json', 'src/pulse.js'], { roots: ['state'] }).ok, false);
  assert.equal(checkChangedPaths(['state/../src/x.js'], { roots: ['state'] }).ok, false);
  assert.equal(checkChangedPaths(['.github/workflows/x.yml'], { roots: ['state'] }).ok, false);
  assert.equal(checkChangedPaths(['statefile.json'], { roots: ['state'] }).ok, false);
});

test('git gate: findSecretsInDiff reads added lines only and returns patterns, not values', () => {
  const diff = `+++ b/state/x.json\n+{"k":"${FAKE_KEY}"}\n-{"old":"${FAKE_KEY}"}\n+clean line\n`;
  const hits = findSecretsInDiff(diff);
  assert.equal(hits.length, 1);
  assert.ok(!hits[0].includes(FAKE_KEY));
  assert.deepEqual(findSecretsInDiff('-removed only\n context\n'), []);
});

function repoWithRemote() {
  const root = mkdtempSync(join(tmpdir(), 'titan-gate-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  mkdirSync(join(work, 'state'), { recursive: true });
  writeFileSync(join(work, 'state', 'a.json'), '{}\n');
  writeFileSync(join(work, 'code.js'), 'code\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  return { work, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('gatedCommit refuses a staged file outside the roots, and a staged secret', () => {
  const r = repoWithRemote();
  try {
    writeFileSync(join(r.work, 'code.js'), 'changed\n');
    r.git(r.work, ['add', 'code.js']);
    assert.throws(() => gatedCommit({ message: 'x', roots: ['state'], cwd: r.work }), GateBlockedError);
    r.git(r.work, ['reset', '-q']);
    writeFileSync(join(r.work, 'state', 'a.json'), `{"k":"${FAKE_KEY}"}\n`);
    r.git(r.work, ['add', 'state/a.json']);
    assert.throws(() => gatedCommit({ message: 'x', roots: ['state'], cwd: r.work }), /looks like a secret/);
    writeFileSync(join(r.work, 'state', 'a.json'), '{"ok":true}\n');
    r.git(r.work, ['add', 'state/a.json']);
    gatedCommit({ message: 'state ok', roots: ['state'], cwd: r.work });
    assert.match(r.git(r.work, ['log', '--oneline', '-1']), /state ok/);
  } finally {
    r.cleanup();
  }
});

test('gatedPush sends a clean state commit, and blocks a commit that touches code or adds a secret', () => {
  const r = repoWithRemote();
  try {
    writeFileSync(join(r.work, 'state', 'a.json'), '{"n":1}\n');
    r.git(r.work, ['add', '-A']);
    r.git(r.work, ['commit', '-q', '-m', 'state only']);
    gatedPush({ ref: 'main', roots: ['state'], currentRef: 'main', cwd: r.work });
    assert.equal(r.git(r.work, ['rev-parse', 'HEAD']), r.git(r.work, ['rev-parse', 'origin/main']));

    writeFileSync(join(r.work, 'code.js'), 'sneaky\n');
    r.git(r.work, ['add', '-A']);
    r.git(r.work, ['commit', '-q', '-m', 'code']);
    assert.throws(() => gatedPush({ ref: 'main', roots: ['state'], currentRef: 'main', cwd: r.work }), /outside the allowed roots/);

    r.git(r.work, ['reset', '-q', '--hard', 'origin/main']);
    writeFileSync(join(r.work, 'state', 'a.json'), `{"k":"${FAKE_KEY}"}\n`);
    r.git(r.work, ['add', '-A']);
    r.git(r.work, ['commit', '-q', '-m', 'secret']);
    assert.throws(() => gatedPush({ ref: 'main', roots: ['state'], currentRef: 'main', cwd: r.work }), /looks like a secret/);

    assert.throws(() => gatedPush({ ref: 'release', roots: ['state'], currentRef: 'main', cwd: r.work }), /not allowed/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------
// REST writer, with a fake fetch
// ---------------------------------------------------------------------

test('createRestWriter never calls fetch for a blocked write, and sends the cleaned body for an allowed one', async () => {
  const sent = [];
  const events = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body });
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  };
  const write = createRestWriter({ token: 't', repository: REPO, fetchImpl, secretNames: ['GROQ_API_KEY'], events: { append: (type, f) => events.push({ type, ...f }) } });
  await assert.rejects(() => write('DELETE', `/repos/${REPO}`), GateBlockedError);
  await assert.rejects(() => write('POST', `/repos/${REPO}/dispatches`, { event_type: 'rm-rf' }), /allowlist/);
  assert.equal(sent.length, 0, 'nothing left the machine');
  assert.ok(events.some((e) => e.type === 'gate.blocked'));
  const out = await write('POST', `/repos/${REPO}/issues/5/comments`, { body: `leak ${FAKE_KEY}` });
  assert.deepEqual(out, { id: 1 });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].body.includes(FAKE_KEY), 'the secret never left the machine');
  assert.ok(events.some((e) => e.type === 'gate.redacted'));
});

// ---------------------------------------------------------------------
// VM commands
// ---------------------------------------------------------------------

test('VM gate: only the railway host, no destructive command, and no secret-shaped text', () => {
  const hosts = ['railway.new'];
  assert.equal(checkVmCommand({ host: 'railway.new', command: 'true' }, { allowedHosts: hosts }).ok, true);
  assert.equal(checkVmCommand({ host: 'evil.example', command: 'true' }, { allowedHosts: hosts }).ok, false);
  assert.equal(checkVmCommand({ host: 'railway.new', command: 'rm -rf /' }, { allowedHosts: hosts }).ok, false);
  assert.equal(checkVmCommand({ host: 'railway.new', command: 'true', brief: `use ${FAKE_KEY}` }, { allowedHosts: hosts }).ok, false);
  assert.equal(checkVmCommand({ host: 'railway.new', command: 'x'.repeat(501) }, { allowedHosts: hosts }).ok, false);
});

test('gateVmCommand blocks at layer 1 without asking a model, and allows a safe command when the reviewer is off', async () => {
  const blocked = await gateVmCommand({ host: 'railway.new', command: 'git push --force origin main' });
  assert.equal(blocked.ok, false);
  const ok = await gateVmCommand({ host: 'railway.new', command: 'true' }, { reviewerOpts: { enabled: false } });
  assert.deepEqual(ok, { ok: true, reason: null });
});

test('cleanText counts what it removes', () => {
  const r = cleanText(`a ${FAKE_KEY} b x@y.example c`);
  assert.equal(r.redactions, 2);
  assert.ok(!r.text.includes('@'));
});
