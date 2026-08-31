import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesize, topoOrder } from '../src/orchestrator/synthesizer.js';

test('topoOrder respects dependsOn ordering', () => {
  const tasks = [
    { id: 'c', dependsOn: ['b'] },
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
  ];
  const ordered = topoOrder(tasks).map((t) => t.id);
  assert.deepEqual(ordered, ['a', 'b', 'c']);
});

test('synthesize merges file blocks from multiple completed tasks and flags a real path conflict', async () => {
  const graph = {
    sharedContext: 'shared',
    tasks: [
      { id: 't1', title: 'One', dependsOn: [] },
      { id: 't2', title: 'Two', dependsOn: [] },
    ],
  };
  const tasksById = new Map([
    ['t1', { state: 'complete', output: '```json\n{"files":[{"path":"shared.js","content":"from-t1"}]}\n```', assignment: { modelId: 'm1' } }],
    ['t2', { state: 'complete', output: '```json\n{"files":[{"path":"shared.js","content":"from-t2"},{"path":"only-t2.js","content":"x"}]}\n```', assignment: { modelId: 'm2' } }],
  ]);

  const result = await synthesize(graph, tasksById);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, 'shared.js');
  assert.ok(result.files.some((f) => f.path === 'only-t2.js'));
  assert.ok(result.markdownSummary.includes('Orchestration Summary'));
});

test('synthesize reports a non-complete task without throwing', async () => {
  const graph = { sharedContext: '', tasks: [{ id: 't1', title: 'One', dependsOn: [] }] };
  const tasksById = new Map([['t1', { state: 'failed', output: null }]]);
  const result = await synthesize(graph, tasksById);
  assert.equal(result.files.length, 0);
  assert.ok(result.markdownSummary.includes('failed'));
});
