import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../src/lib/median.js';

test('median of an empty array is null, not NaN or a thrown error', () => {
  assert.equal(median([]), null);
});

test('median of an odd-length array is the middle value after sorting', () => {
  assert.equal(median([5, 1, 3]), 3);
});

test('median of an even-length array is the rounded average of the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 3); // (2+3)/2 = 2.5 -> rounds to 3
  assert.equal(median([10, 20]), 15);
});

test('median does not mutate the input array', () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test('a single-element array returns that element', () => {
  assert.equal(median([42]), 42);
});
