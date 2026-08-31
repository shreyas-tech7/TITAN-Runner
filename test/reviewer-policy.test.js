import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '../src/reviewer/policy.js';

test('a read-effect action classifies as safe', () => {
  const result = classifyAction({ toolId: 'read_file', args: { path: 'a.txt' }, effect: 'read' });
  assert.equal(result.classification, 'safe');
});

test('a recursive force delete classifies as destructive with a matched rule', () => {
  const result = classifyAction({ toolId: 'shell', args: { cmd: 'rm -rf /tmp/x' } });
  assert.equal(result.classification, 'destructive');
  assert.ok(result.matchedRules.includes('recursive-delete'));
});

test('an action with no metadata at all defaults to caution, never safe', () => {
  const result = classifyAction({ toolId: 'mystery_tool', args: {} });
  assert.equal(result.classification, 'caution');
});

test('force push is caught even inside a JSON-stringified args blob', () => {
  const result = classifyAction({ toolId: 'git', args: { command: 'git push --force origin main' } });
  assert.equal(result.classification, 'destructive');
  assert.ok(result.matchedRules.includes('force-push'));
});
