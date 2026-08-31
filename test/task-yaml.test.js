import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskYaml } from '../src/lib/taskYaml.js';

/** Mirrors dashboard/lib/taskYaml.ts's buildIssueBody() output shape exactly —
 * the two files must stay in lockstep; this is the contract test for that. */
function issueBodyFixture({ title, description, priority = 'normal', routingHint = 'any' }) {
  const blockDescription = description
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : ''))
    .join('\n');
  return [
    description,
    '',
    `**Priority:** ${priority} · **Routing hint:** ${routingHint}`,
    '',
    '<!-- titan-task-v1',
    `title: "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    `priority: ${priority}`,
    `routingHint: ${routingHint}`,
    'filedVia: dashboard',
    'description: |',
    blockDescription,
    '-->',
    '',
    '---',
    "_Filed via the TITAN-Runner dashboard's task-filing modal._",
  ].join('\n');
}

test('parses a single-line task filed through the dashboard', () => {
  const body = issueBodyFixture({ title: 'Fix the flaky test', description: 'It fails under load.', priority: 'high', routingHint: 'fast' });
  const parsed = parseTaskYaml(body);
  assert.deepEqual(parsed, {
    title: 'Fix the flaky test',
    description: 'It fails under load.',
    priority: 'high',
    routingHint: 'fast',
    filedVia: 'dashboard',
  });
});

test('parses a multi-line description block scalar, preserving internal blank lines', () => {
  const description = 'Line one.\n\nLine three, after a blank line.';
  const body = issueBodyFixture({ title: 'Multi-line task', description });
  const parsed = parseTaskYaml(body);
  assert.equal(parsed.description, description);
});

test('unescapes a quoted double-quote and backslash in the title', () => {
  const body = issueBodyFixture({ title: 'Say "hello" \\ done', description: 'desc' });
  const parsed = parseTaskYaml(body);
  assert.equal(parsed.title, 'Say "hello" \\ done');
});

test('an invalid priority/routingHint value falls back to the documented default rather than throwing', () => {
  const body = [
    '<!-- titan-task-v1',
    'title: "x"',
    'priority: urgent-ish',
    'routingHint: yolo',
    'description: |',
    '  desc',
    '-->',
  ].join('\n');
  const parsed = parseTaskYaml(body);
  assert.equal(parsed.priority, 'normal');
  assert.equal(parsed.routingHint, 'any');
});

test('a legacy issue with no titan-task-v1 fence returns null (caller falls back to whole-body prompt)', () => {
  assert.equal(parseTaskYaml('Just some plain prose from the old issue template.'), null);
  assert.equal(parseTaskYaml(''), null);
  assert.equal(parseTaskYaml(null), null);
  assert.equal(parseTaskYaml(undefined), null);
});

test('a fence with an empty title or empty description is rejected (falls back), not accepted with blanks', () => {
  const missingTitle = ['<!-- titan-task-v1', 'title: ""', 'description: |', '  something', '-->'].join('\n');
  assert.equal(parseTaskYaml(missingTitle), null);

  const missingDescription = ['<!-- titan-task-v1', 'title: "x"', 'description: |', '-->'].join('\n');
  assert.equal(parseTaskYaml(missingDescription), null);
});

test('content outside the fence is never treated as task data, even if it looks like a key: value line', () => {
  const body = [
    'priority: this-is-just-prose-not-yaml',
    '',
    '<!-- titan-task-v1',
    'title: "Real task"',
    'priority: low',
    'description: |',
    '  real description',
    '-->',
    '',
    'routingHint: also-prose',
  ].join('\n');
  const parsed = parseTaskYaml(body);
  assert.equal(parsed.title, 'Real task');
  assert.equal(parsed.priority, 'low');
});
