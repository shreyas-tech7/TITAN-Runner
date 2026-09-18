import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpointer } from '../src/engine/checkpointer.js';

/** A bare "origin" plus a working clone with a committed state/ dir — the same shape the Actions checkout has. */
function repoWithRemote() {
  const root = mkdtempSync(join(tmpdir(), 'titan-ckpt-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  mkdirSync(join(work, 'state'), { recursive: true });
  writeFileSync(join(work, 'state', 'tasks.json'), '{"version":2,"tasks":[]}\n');
  writeFileSync(join(work, 'src.js'), 'code\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  return { root, bare, work, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('git mode commits only state/ (never code), pushes, rate-limits, and forces at the end', async () => {
  const r = repoWithRemote();
  try {
    let t = 1_000_000;
    const events = [];
    const cp = new Checkpointer({ mode: 'git', stateDir: join(r.work, 'state'), repoRoot: r.work, ref: 'main', minIntervalMs: 10_000, now: () => t, events: { append: (type, f) => events.push({ type, ...f }) } });
    writeFileSync(join(r.work, 'state', 'tasks.json'), '{"version":2,"tasks":[{"id":"a"}]}\n');
    writeFileSync(join(r.work, 'src.js'), 'changed code must NOT be committed\n');
    const first = await cp.checkpoint('claim:a');
    assert.deepEqual([first.committed, first.pushed], [true, true]);
    assert.match(r.git(r.work, ['status', '--porcelain']), /src\.js/, 'code change left uncommitted in the working tree');
    assert.equal(r.git(r.work, ['show', 'origin/main:src.js']), 'code', 'code change never reached the remote');
    const remoteLog = r.git(r.work, ['log', '--oneline', 'origin/main']);
    assert.match(remoteLog, /checkpoint claim:a/);

    writeFileSync(join(r.work, 'state', 'tasks.json'), '{"version":2,"tasks":[{"id":"a"},{"id":"b"}]}\n');
    const second = await cp.checkpoint('step');
    assert.equal(second.skipped, 'rate limited');
    const third = await cp.checkpoint('pulse-end', { force: true });
    assert.equal(third.committed, true);
    const noop = await cp.checkpoint('again', { force: true });
    assert.equal(noop.skipped, 'nothing changed');
    assert.equal(cp.summary().commits, 2);
    assert.ok(events.some((e) => e.type === 'checkpoint.written'));
  } finally {
    r.cleanup();
  }
});

test('a conflicting remote commit is resolved by re-applying this pulse\'s state on top of the remote, then pushing', async () => {
  const r = repoWithRemote();
  try {
    // Someone else (a selftest job) pushes a conflicting change to the same state file.
    const other = join(r.root, 'other');
    execFileSync('git', ['clone', '-q', r.bare, other]);
    writeFileSync(join(other, 'state', 'tasks.json'), '{"version":2,"tasks":[{"id":"from-other"}]}\n');
    writeFileSync(join(other, 'state', 'providers.json'), '{"providers":{}}\n');
    r.git(other, ['add', '-A']);
    r.git(other, ['commit', '-q', '-m', 'other job']);
    r.git(other, ['push', '-q', 'origin', 'main']);

    const cp = new Checkpointer({ mode: 'git', stateDir: join(r.work, 'state'), repoRoot: r.work, ref: 'main', minIntervalMs: 0 });
    writeFileSync(join(r.work, 'state', 'tasks.json'), '{"version":2,"tasks":[{"id":"ours"}]}\n');
    const result = await cp.checkpoint('conflict', { force: true });
    assert.equal(result.pushed, true);
    execFileSync('git', ['pull', '-q', 'origin', 'main'], { cwd: other });
    assert.equal(readFileSync(join(other, 'state', 'tasks.json'), 'utf8'), '{"version":2,"tasks":[{"id":"ours"}]}\n', 'our state won for the file we wrote');
    assert.equal(readFileSync(join(other, 'state', 'providers.json'), 'utf8'), '{"providers":{}}\n', "the other job's file we never touched survived");
  } finally {
    r.cleanup();
  }
});

test('mode none never shells out, and git mode refuses a state dir outside the repo', async () => {
  const r = repoWithRemote();
  try {
    let calls = 0;
    const none = new Checkpointer({ mode: 'none', stateDir: join(r.work, 'state'), repoRoot: r.work, git: () => { calls += 1; return ''; } });
    assert.equal((await none.checkpoint('x', { force: true })).skipped, 'mode none');
    assert.equal(calls, 0);
    const outside = new Checkpointer({ mode: 'git', stateDir: mkdtempSync(join(tmpdir(), 'elsewhere-')), repoRoot: r.work });
    assert.equal(outside.mode, 'none');
  } finally {
    r.cleanup();
  }
});
