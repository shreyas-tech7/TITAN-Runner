import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopDetector, fingerprint } from '../src/reliability/loopDetector.js';

test('fingerprint is stable across key order and carries no content', () => {
  const a = fingerprint({ tool: 'read', args: { path: 'x', n: 1 } });
  const b = fingerprint({ args: { n: 1, path: 'x' }, tool: 'read' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, fingerprint({ tool: 'read', args: { path: 'y', n: 1 } }));
});

test('the same observation repeated maxRepeats times is a loop; different observations are not', () => {
  const d = new LoopDetector({ maxRepeats: 3 });
  assert.equal(d.observe({ call: 'a' }).looping, false);
  assert.equal(d.observe({ call: 'b' }).looping, false);
  assert.equal(d.observe({ call: 'a' }).looping, false);
  const third = d.observe({ call: 'a' });
  assert.equal(third.looping, true);
  assert.equal(third.repeats, 3);
});

test('no-progress observations stall the loop after the limit even when every one is different', () => {
  const d = new LoopDetector({ maxRepeats: 10, noProgressLimit: 3 });
  assert.equal(d.observe({ n: 1 }, { progress: false }).stalled, false);
  assert.equal(d.observe({ n: 2 }, { progress: false }).stalled, false);
  assert.equal(d.observe({ n: 3 }, { progress: false }).stalled, true);
  const e = new LoopDetector({ noProgressLimit: 3 });
  e.observe({ n: 1 }, { progress: false });
  e.observe({ n: 2 }, { progress: true });
  assert.equal(e.observe({ n: 3 }, { progress: false }).stalled, false, 'progress resets the count');
});
