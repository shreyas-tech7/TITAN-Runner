import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockOffsetMs } from '../src/lib/clock.js';

test('the clock offset is ignored unless the fakes are wired, so a production pulse cannot be moved off the wall clock', () => {
  assert.equal(clockOffsetMs({ TITAN_CLOCK_OFFSET_MS: '900000' }), 0);
  assert.equal(clockOffsetMs({ TITAN_CLOCK_OFFSET_MS: '900000', TITAN_FAKE_PROVIDER: 'happy' }), 900_000);
  assert.equal(clockOffsetMs({ TITAN_CLOCK_OFFSET_MS: '900000', TITAN_FAKE_GITHUB: 'memory' }), 900_000);
  assert.equal(clockOffsetMs({ TITAN_CLOCK_OFFSET_MS: 'junk', TITAN_FAKE_PROVIDER: 'happy' }), 0);
  assert.equal(clockOffsetMs({ TITAN_FAKE_PROVIDER: 'happy' }), 0);
});
