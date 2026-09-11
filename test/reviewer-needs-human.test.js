/**
 * @file docs/DECISIONS.md D-4: the Reviewer Gate's Layer 2 model verdict now
 * accepts `needs-human` alongside `allow`/`block`. No dedicated reviewer.js
 * test file existed before this change (only policy.js's Layer 1 classifier
 * was tested, in reviewer-policy.test.js) — this covers the new third
 * verdict specifically, via `reviewAction`'s injectable `chatFn`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewAction } from '../src/reviewer/reviewer.js';

function fakeChat(verdict, extra = {}) {
  return async () => ({ text: JSON.stringify({ verdict, reason: 'needs a human to confirm scope', ...extra }) });
}

// Every reviewAction() call below persists a verdict row — reviewStoreDir
// points that at a scratch directory instead of the real state/reviews/,
// which appendReview() has no other way to avoid touching (see the fix to
// src/reviewer/reviewer.js#persist() alongside this test).
const scratchDir = mkdtempSync(join(tmpdir(), 'titan-reviews-'));
process.on('exit', () => rmSync(scratchDir, { recursive: true, force: true }));

test('a needs-human model verdict on a caution-tier action passes through as needs-human, not allow or block', async () => {
  const result = await reviewAction(
    { toolId: 'orchestrate-task', args: { title: 'x' }, effect: 'external' },
    { enabled: true, chatFn: fakeChat('needs-human'), reviewStoreDir: scratchDir },
  );
  assert.equal(result.verdict, 'needs-human');
  assert.equal(result.layer, 2);
  assert.match(result.reason, /needs a human/);
});

test('a needs-human model verdict on a destructive-tier action is also honored (not forced to block)', async () => {
  const result = await reviewAction(
    { toolId: 'shell', args: { cmd: 'rm -rf /tmp/x' }, effect: 'external' },
    { enabled: true, chatFn: fakeChat('needs-human'), reviewStoreDir: scratchDir },
  );
  assert.equal(result.classification, 'destructive');
  assert.equal(result.verdict, 'needs-human');
});

test('an unparsable model response on a destructive action still fails closed to block (unchanged)', async () => {
  const result = await reviewAction(
    { toolId: 'shell', args: { cmd: 'rm -rf /tmp/x' }, effect: 'external' },
    { enabled: true, chatFn: async () => ({ text: 'not json at all' }), reviewStoreDir: scratchDir },
  );
  assert.equal(result.verdict, 'block');
  assert.equal(result.failMode, 'closed');
});

test('a safe-tier action never calls the model at all and always allows', async () => {
  let called = false;
  const result = await reviewAction(
    { toolId: 'read_file', args: {}, effect: 'read' },
    { enabled: true, chatFn: async () => { called = true; return { text: '{"verdict":"block"}' }; }, reviewStoreDir: scratchDir },
  );
  assert.equal(result.verdict, 'allow');
  assert.equal(called, false);
});
