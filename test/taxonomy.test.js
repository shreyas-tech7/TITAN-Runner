import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECT_CATEGORIES, isAspectCategory,
  TASK_STATES, isTaskState,
  AGENT_POOLS, isAgentPool,
  TERMINAL_RUN_STATES, isRunState,
} from '../src/orchestrator/taxonomy.js';

test('isAspectCategory accepts every real category and rejects junk', () => {
  for (const c of ASPECT_CATEGORIES) assert.equal(isAspectCategory(c), true);
  assert.equal(isAspectCategory('not-a-real-category'), false);
  assert.equal(isAspectCategory(42), false);
});

test('isTaskState / isAgentPool / isRunState reject non-members', () => {
  for (const s of TASK_STATES) assert.equal(isTaskState(s), true);
  assert.equal(isTaskState('sleeping'), false);
  for (const p of AGENT_POOLS) assert.equal(isAgentPool(p), true);
  assert.equal(isAgentPool('made-up-pool'), false);
  assert.equal(isRunState('complete'), true);
  assert.equal(isRunState('nope'), false);
});

test('TERMINAL_RUN_STATES is exactly the terminal subset', () => {
  assert.deepEqual([...TERMINAL_RUN_STATES].sort(), ['cancelled', 'complete', 'failed'].sort());
});
