import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * End-to-end smoke test: a full `node src/pulse.js` run, in dry-run mode
 * (zero network, zero GitHub credentials), against a scratch copy of the
 * repo so it never touches this checkout's own committed state/. Exercises
 * exactly the path GitHub Actions runs on cron: manual-task intake ->
 * reviewer gate -> decompose -> schedule -> synthesize -> write state.
 */
test('a full dry-run pulse claims a manual task and completes it end to end', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'titan-pulse-e2e-'));
  try {
    cpSync(join(REPO_ROOT, 'src'), join(scratch, 'src'), { recursive: true });
    cpSync(join(REPO_ROOT, 'state'), join(scratch, 'state'), { recursive: true });

    const out = execFileSync(process.execPath, ['src/pulse.js'], {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        ...process.env,
        TITAN_DRY_RUN: '1',
        TITAN_MANUAL_TASK: 'Write a small function that reverses a string, with a unit test.',
        GITHUB_TOKEN: '',
      },
    });

    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.equal(summary.pulse, 'complete');
    assert.equal(summary.error, null);
    assert.equal(summary.tasksClaimed, 1);
    assert.equal(summary.tasksCompleted, 1);

    const tasksState = JSON.parse(readFileSync(join(scratch, 'state', 'tasks.json'), 'utf8'));
    assert.equal(tasksState.tasks.length, 1);
    assert.equal(tasksState.tasks[0].status, 'complete');
    assert.ok(tasksState.tasks[0].runId);

    const runPath = join(scratch, 'state', 'runs', `${tasksState.tasks[0].runId}.json`);
    assert.equal(existsSync(runPath), true);

    const heartbeat = JSON.parse(readFileSync(join(scratch, 'state', 'heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.lastPulseStatus, 'ok');
    assert.equal(heartbeat.lastPulseTasksCompleted, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a pulse with nothing pending and no manual task is a clean no-op', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'titan-pulse-noop-'));
  try {
    cpSync(join(REPO_ROOT, 'src'), join(scratch, 'src'), { recursive: true });
    cpSync(join(REPO_ROOT, 'state'), join(scratch, 'state'), { recursive: true });

    const out = execFileSync(process.execPath, ['src/pulse.js'], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, TITAN_DRY_RUN: '1', TITAN_MANUAL_TASK: '', GITHUB_TOKEN: '' },
    });
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.equal(summary.pulse, 'complete');
    assert.equal(summary.tasksClaimed, 0);
    assert.equal(summary.error, null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
