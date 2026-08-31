import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateTaskGraph, singleTaskFallback, offlineSampleGraph } from '../src/orchestrator/decomposer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('validateTaskGraph accepts a well-formed acyclic graph', () => {
  const tasks = [
    { id: 'a', title: 'A', aspect: 'architecture', description: 'x', dependsOn: [], estimatedComplexity: 'low', deliverable: 'y' },
    { id: 'b', title: 'B', aspect: 'testing', description: 'x', dependsOn: ['a'], estimatedComplexity: 'medium', deliverable: 'y' },
  ];
  const result = validateTaskGraph(tasks, 12);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateTaskGraph rejects a dependency cycle', () => {
  const tasks = [
    { id: 'a', title: 'A', aspect: 'architecture', description: 'x', dependsOn: ['b'], estimatedComplexity: 'low', deliverable: 'y' },
    { id: 'b', title: 'B', aspect: 'testing', description: 'x', dependsOn: ['a'], estimatedComplexity: 'low', deliverable: 'y' },
  ];
  const result = validateTaskGraph(tasks, 12);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('cycle')));
});

test('validateTaskGraph rejects a dangling dependsOn id and an unknown aspect', () => {
  const tasks = [
    { id: 'a', title: 'A', aspect: 'not-real', description: 'x', dependsOn: ['ghost'], estimatedComplexity: 'low', deliverable: 'y' },
  ];
  const result = validateTaskGraph(tasks, 12);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown id')));
  assert.ok(result.errors.some((e) => e.includes('invalid "aspect"')));
});

test('singleTaskFallback wraps the master prompt as one task', () => {
  const graph = singleTaskFallback('do the thing');
  assert.equal(graph.tasks.length, 1);
  assert.equal(graph.tasks[0].description, 'do the thing');
});

test('offlineSampleGraph is itself a valid graph', () => {
  const graph = offlineSampleGraph();
  const result = validateTaskGraph(graph.tasks, 12);
  assert.equal(result.ok, true);
});

test('decompose() in dry-run mode returns the validated offline sample graph with zero network calls', () => {
  // config.js freezes process.env into an immutable singleton at import time
  // (by design — see its own file header), so TITAN_DRY_RUN has to be set
  // before the process starts, not from inside a test body that has already
  // triggered the import above. A child process is the honest way to
  // exercise this exactly the way the real pulse workflow does.
  const script = join(__dirname, 'fixtures', 'run-decompose-dry.mjs');
  const out = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, TITAN_DRY_RUN: '1' },
  });
  const graph = JSON.parse(out);
  assert.ok(graph.tasks.length > 0);
  assert.equal(validateTaskGraph(graph.tasks, 12).ok, true);
});
