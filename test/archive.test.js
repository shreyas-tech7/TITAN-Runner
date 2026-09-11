import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveRun, listArchivedMonths, readArchiveMonth } from '../src/state/archive.js';

function withArchive(fn) {
  const archiveDir = mkdtempSync(join(tmpdir(), 'titan-archive-'));
  try {
    fn(archiveDir);
  } finally {
    rmSync(archiveDir, { recursive: true, force: true });
  }
}

test('archiveRun writes a gzip ndjson file keyed by the record\'s month', () => {
  withArchive((archiveDir) => {
    archiveRun({ runId: 'r1', createdAt: '2026-04-15T00:00:00.000Z', taskTitle: 'x' }, { archiveDir });
    assert.deepEqual(listArchivedMonths({ archiveDir }), ['2026-04']);
    const records = readArchiveMonth('2026-04', { archiveDir });
    assert.equal(records.length, 1);
    assert.equal(records[0].runId, 'r1');
  });
});

test('multiple runs in the same month append to the same file, in order', () => {
  withArchive((archiveDir) => {
    archiveRun({ runId: 'r1', createdAt: '2026-04-01T00:00:00.000Z' }, { archiveDir });
    archiveRun({ runId: 'r2', createdAt: '2026-04-20T00:00:00.000Z' }, { archiveDir });
    const records = readArchiveMonth('2026-04', { archiveDir });
    assert.deepEqual(records.map((r) => r.runId), ['r1', 'r2']);
  });
});

test('runs in different months land in separate archive files', () => {
  withArchive((archiveDir) => {
    archiveRun({ runId: 'r1', createdAt: '2026-04-01T00:00:00.000Z' }, { archiveDir });
    archiveRun({ runId: 'r2', createdAt: '2026-05-01T00:00:00.000Z' }, { archiveDir });
    assert.deepEqual(listArchivedMonths({ archiveDir }), ['2026-04', '2026-05']);
    assert.equal(readArchiveMonth('2026-04', { archiveDir }).length, 1);
    assert.equal(readArchiveMonth('2026-05', { archiveDir }).length, 1);
  });
});

test('reading a month with no archive file returns an empty array, not a throw', () => {
  withArchive((archiveDir) => {
    assert.deepEqual(readArchiveMonth('2099-01', { archiveDir }), []);
  });
});

test('a record with no createdAt/updatedAt falls back to the current month rather than throwing', () => {
  withArchive((archiveDir) => {
    assert.doesNotThrow(() => archiveRun({ runId: 'r1' }, { archiveDir }));
    assert.equal(listArchivedMonths({ archiveDir }).length, 1);
  });
});
