import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redact } from '../src/lib/redact.js';
import { scrubForState } from '../src/lib/secretScrub.js';

test('redactString masks known key shapes and email addresses', () => {
  assert.equal(redactString('key is gsk_' + 'a'.repeat(24)), 'key is [REDACTED]');
  assert.equal(redactString('contact shreyas@example.com now'), 'contact [REDACTED] now');
  assert.equal(redactString('nothing sensitive here'), 'nothing sensitive here');
});

test('redact() blanks a field by name regardless of its content (the logging-safe behavior)', () => {
  const out = redact({ prompt: 'do the thing', ok: true });
  assert.equal(out.prompt, '[REDACTED]');
  assert.equal(out.ok, true);
});

test('scrubForState preserves content but still masks embedded secrets (state must keep the deliverable)', () => {
  const out = scrubForState({ prompt: 'write a haiku, my key is gsk_' + 'b'.repeat(24), ok: true });
  assert.ok(out.prompt.startsWith('write a haiku'));
  assert.ok(!out.prompt.includes('gsk_'));
  assert.equal(out.ok, true);
});

test('scrubForState handles cycles without stack overflow', () => {
  const obj = { name: 'x' };
  obj.self = obj;
  const out = scrubForState(obj);
  assert.equal(out.self, '[Circular]');
});
