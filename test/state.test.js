import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJson, writeJsonAtomic } from '../src/state/io.js';
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
