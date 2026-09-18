import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'titan.js');

function titan(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}
/** `--json` output is the last line of stdout (log lines may precede it). */
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').pop());

test('titan simulate runs the happy path against the fakes with no network, then explain and replay describe the task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-cli-'));
  try {
    const sim = titan(['simulate', '--pulses', '2', '--state', dir, '--json']);
    assert.equal(sim.code, 0, sim.stderr);
    const out = lastJson(sim.stdout);
    assert.equal(out.tasks.length, 1);
    assert.equal(out.tasks[0].status, 'complete');
    assert.ok(out.pulses[0].modelCalls > 0);
    assert.ok(existsSync(join(dir, 'views', 'queue.json')), 'views written');

    const explain = titan(['explain', out.tasks[0].id, '--state', dir]);
    assert.equal(explain.code, 0, explain.stderr);
    assert.match(explain.stdout, /complete/);
    assert.match(explain.stdout, /recent events:/);
    const replay = titan(['replay', out.tasks[0].id, '--state', dir]);
    assert.equal(replay.code, 0);
    assert.match(replay.stdout, /task\.transition/);
    assert.match(replay.stdout, /verify\.finished/);
    assert.equal(titan(['explain', 'issue-404', '--state', dir]).code, 1);

    const queue = lastJson(titan(['queue', '--state', dir]).stdout);
    assert.equal(queue.byStatus.complete, 1);
    const analytics = lastJson(titan(['analytics', '--state', dir]).stdout);
    assert.equal(analytics.tasks.succeeded, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('titan control applies an audited action and titan doctor reports the checkout and state honestly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-cli-'));
  try {
    titan(['simulate', '--state', dir, '--json']);
    const ctl = titan(['control', 'autonomy', 'propose', '--reason', 'testing', '--state', dir], { TITAN_CONTROL_ACTOR: 'tester' });
    assert.equal(ctl.code, 0, ctl.stderr);
    assert.match(ctl.stdout, /autonomy is now propose/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')).autonomy, 'propose');
    const bad = titan(['control', 'autonomy', 'sideways', '--state', dir]);
    assert.equal(bad.code, 1);
    const doctor = titan(['doctor', '--state', dir, '--json']);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    const report = lastJson(doctor.stdout);
    assert.ok(report.ok);
    assert.ok(report.checks.some((c) => c.name.startsWith('schemas/') && c.ok));
    assert.ok(report.checks.some((c) => /autonomy propose/.test(c.detail)));
    assert.equal(titan(['nonsense']).code, 2);
    assert.match(titan(['help']).stdout, /titan simulate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
