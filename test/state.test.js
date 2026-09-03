import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJson, writeJsonAtomic, loadPulseHistory, appendPulseHistory, MAX_PULSE_HISTORY } from '../src/state/io.js';
import { pruneRuns } from '../src/state/prune.js';

test('writeJsonAtomic + readJson round-trip, and a missing file returns the fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-state-'));
  try {
    const path = join(dir, 'thing.json');
    assert.deepEqual(readJson(path, { fallback: true }), { fallback: true });
    writeJsonAtomic(path, { hello: 'world' });
    assert.deepEqual(readJson(path, null), { hello: 'world' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendPulseHistory accumulates entries and loadPulseHistory reads them back in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-pulse-history-'));
  const path = join(dir, 'pulse-history.json');
  try {
    assert.deepEqual(loadPulseHistory(path), []);
    appendPulseHistory({ at: '2026-01-01T00:00:00.000Z', durationMs: 1000, status: 'ok', tasksClaimed: 1, tasksCompleted: 1, tasksFailed: 0 }, path);
    appendPulseHistory({ at: '2026-01-01T00:15:00.000Z', durationMs: 1200, status: 'error', tasksClaimed: 0, tasksCompleted: 0, tasksFailed: 0 }, path);
    const history = loadPulseHistory(path);
    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'ok');
    assert.equal(history[1].status, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendPulseHistory caps at MAX_PULSE_HISTORY, dropping the oldest entries first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-pulse-history-'));
  const path = join(dir, 'pulse-history.json');
  try {
    for (let i = 0; i < MAX_PULSE_HISTORY + 10; i += 1) {
      appendPulseHistory({ at: `pulse-${i}`, durationMs: i, status: 'ok', tasksClaimed: 0, tasksCompleted: 0, tasksFailed: 0 }, path);
    }
    const history = loadPulseHistory(path);
    assert.equal(history.length, MAX_PULSE_HISTORY);
    assert.equal(history[0].at, 'pulse-10'); // the first 10 were dropped
    assert.equal(history[history.length - 1].at, `pulse-${MAX_PULSE_HISTORY + 9}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneRuns rolls the oldest runs into a dated digest and deletes them once over the cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-prune-'));
  const runsDir = join(dir, 'runs');
  const digestsDir = join(dir, 'digests');
  mkdirSync(runsDir, { recursive: true });
  try {
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(
        join(runsDir, `run-${i}.json`),
        JSON.stringify({ runId: `run-${i}`, taskTitle: `Task ${i}`, state: 'complete', tasks: [] }),
      );
    }
    const result = pruneRuns({ maxFiles: 3, runsDir, digestsDir });
    assert.equal(result.prunedCount, 2);
    assert.equal(existsSync(join(runsDir, 'run-0.json')), false);
    assert.equal(existsSync(join(runsDir, 'run-4.json')), true);
    assert.ok(existsSync(digestsDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
