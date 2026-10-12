import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJson, writeJsonAtomic, loadPulseHistory, appendPulseHistory, MAX_PULSE_HISTORY } from '../src/state/io.js';
import { pruneRuns } from '../src/state/prune.js';
import { readArchive } from '../src/state/archive.js';

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

test('pruneRuns rolls the oldest runs into a monthly compressed archive and deletes them once over the cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-prune-'));
  const runsDir = join(dir, 'runs');
  const archiveDir = join(dir, 'archive');
  mkdirSync(runsDir, { recursive: true });
  try {
    for (let i = 0; i < 14; i += 1) {
      writeFileSync(
        join(runsDir, `run-${i}.json`),
        JSON.stringify({ runId: `run-${i}`, taskTitle: `Task ${i}`, state: 'complete', createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), tasks: [] }),
      );
    }
    const now = new Date('2026-10-02T00:00:00Z');
    const result = pruneRuns({ maxFiles: 12, keepDays: 14, runsDir, archiveDir, now });
    assert.equal(result.prunedCount, 2, 'the two oldest are beyond the cap of 12');
    assert.equal(existsSync(join(runsDir, 'run-0.json')), false);
    assert.equal(existsSync(join(runsDir, 'run-13.json')), true);
    const records = readArchive(join(archiveDir, 'runs-2026-10.jsonl.gz'));
    assert.deepEqual(records.map((r) => r.runId), ['run-0', 'run-1'], 'the whole record is in the archive');
    // A second run changes nothing and adds nothing.
    const again = pruneRuns({ maxFiles: 12, keepDays: 14, runsDir, archiveDir, now });
    assert.equal(again.prunedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneRuns also archives a run that is older than keepDays, whatever the count, and keeps the newest 10', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-prune-'));
  const runsDir = join(dir, 'runs');
  const archiveDir = join(dir, 'archive');
  mkdirSync(runsDir, { recursive: true });
  try {
    const mk = (id, iso) => writeFileSync(join(runsDir, `${id}.json`), JSON.stringify({ runId: id, createdAt: iso, tasks: [] }));
    mk('may-1', '2026-05-01T00:00:00.000Z');
    mk('sep-1', '2026-09-01T00:00:00.000Z');
    mk('oct-1', '2026-10-09T00:00:00.000Z');
    const now = new Date('2026-10-11T00:00:00Z');
    // Only 3 files exist, so the newest 10 rule keeps all of them.
    assert.equal(pruneRuns({ maxFiles: 60, keepDays: 14, runsDir, archiveDir, now }).prunedCount, 0);
    for (let i = 0; i < 10; i += 1) mk(`new-${i}`, `2026-10-10T00:${String(i).padStart(2, '0')}:00.000Z`);
    const res = pruneRuns({ maxFiles: 60, keepDays: 14, runsDir, archiveDir, now });
    assert.deepEqual(res.prunedIds.sort(), ['may-1', 'sep-1']);
    assert.deepEqual(readArchive(join(archiveDir, 'runs-2026-05.jsonl.gz')).map((r) => r.runId), ['may-1']);
    assert.deepEqual(readArchive(join(archiveDir, 'runs-2026-09.jsonl.gz')).map((r) => r.runId), ['sep-1']);
    assert.equal(existsSync(join(runsDir, 'oct-1.json')), true, 'a run from 2 days ago stays');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
