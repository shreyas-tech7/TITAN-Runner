import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/publish-state.mjs', import.meta.url).pathname;
const FAKE_KEY = ['gsk', 'p'.repeat(30)].join('_');
const CONTROL = { version: 1, killSwitch: false, drain: false, safeMode: false, autonomy: 'propose', updatedAt: '2026-10-11T00:00:00.000Z', updatedBy: 'test', reason: 'test' };

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'titan-publish-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  const git = (cwd, a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  mkdirSync(join(work, 'state'), { recursive: true });
  writeFileSync(join(work, 'state', 'control.json'), `${JSON.stringify(CONTROL)}\n`);
  writeFileSync(join(work, 'code.js'), 'code\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: 'main' } });
  return { work, bare, git, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('publish-state commits only state/, pushes it, and uses the message', () => {
  const r = repo();
  try {
    writeFileSync(join(r.work, 'state', 'control.json'), `${JSON.stringify({ ...CONTROL, reason: 'changed' })}\n`);
    writeFileSync(join(r.work, 'code.js'), 'sneaky change that must not be published\n');
    const res = r.run(['--message', 'chore(ops): test publish']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(r.git(r.work, ['log', '--oneline', '-1', 'origin/main']), /chore\(ops\): test publish/);
    assert.equal(r.git(r.work, ['show', 'origin/main:code.js']), 'code', 'code never reached the remote');
    assert.match(r.git(r.work, ['status', '--porcelain']), /code\.js/, 'the code change stays in the working tree');
  } finally {
    r.cleanup();
  }
});

test('publish-state says there is nothing to publish and exits 0', () => {
  const r = repo();
  try {
    const res = r.run(['--message', 'chore(ops): empty']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /nothing to publish/);
  } finally {
    r.cleanup();
  }
});

test('publish-state refuses a state tree that fails its schema, and a file with no schema, and publishes nothing', () => {
  const r = repo();
  try {
    writeFileSync(join(r.work, 'state', 'control.json'), `${JSON.stringify({ ...CONTROL, surprise: 1 })}\n`);
    const bad = r.run(['--message', 'chore(ops): bad']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unexpected property/);
    writeFileSync(join(r.work, 'state', 'control.json'), `${JSON.stringify(CONTROL)}\n`);
    writeFileSync(join(r.work, 'state', 'private-notes.md'), 'hello\n');
    const unknown = r.run(['--message', 'chore(ops): unknown']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no schema/);
    assert.equal(r.git(r.work, ['rev-parse', 'HEAD']), r.git(r.work, ['rev-parse', 'origin/main']), 'nothing was committed');
  } finally {
    r.cleanup();
  }
});

test('publish-state blocks a secret in the state, even with validation off, and never prints the value', () => {
  const r = repo();
  try {
    writeFileSync(join(r.work, 'state', 'control.json'), `${JSON.stringify({ ...CONTROL, reason: FAKE_KEY })}\n`);
    const res = r.run(['--message', 'chore(ops): secret', '--no-validate']);
    assert.equal(res.status, 1);
    assert.ok(!(res.stdout + res.stderr).includes(FAKE_KEY));
    assert.equal(r.git(r.work, ['rev-parse', 'origin/main']), r.git(r.work, ['rev-list', '-n', '1', 'origin/main']), 'the remote did not move');
  } finally {
    r.cleanup();
  }
});

test('publish-state recovers from a push race: another job pushed first, so it rebases and pushes again', () => {
  const r = repo();
  try {
    const other = join(r.work, '..', 'other');
    execFileSync('git', ['clone', '-q', r.bare, other]);
    writeFileSync(join(other, 'state', 'control.json'), `${JSON.stringify({ ...CONTROL, reason: 'from another job' })}\n`);
    execFileSync('git', ['-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-am', 'other job'], { cwd: other });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });
    writeFileSync(join(r.work, 'state', 'control.json'), `${JSON.stringify({ ...CONTROL, reason: 'mine' })}\n`);
    const res = r.run(['--message', 'chore(ops): race']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(r.git(r.work, ['log', '--oneline', '-3', 'origin/main']), /chore\(ops\): race/);
    assert.match(r.git(r.work, ['log', '--oneline', '-3', 'origin/main']), /other job/, 'the other commit is still there');
  } finally {
    r.cleanup();
  }
});

test('publish-state needs a message', () => {
  const r = repo();
  try {
    assert.equal(r.run([]).status, 1);
  } finally {
    r.cleanup();
  }
});
