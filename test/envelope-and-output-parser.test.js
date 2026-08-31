import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, normalizePath } from '../src/orchestrator/envelopeParser.js';
import { parseTaskOutput } from '../src/orchestrator/outputParser.js';

test('parseEnvelope tier 1: a clean fenced JSON envelope parses directly', () => {
  const text = '```json\n{"files":[{"path":"a.js","content":"x"}],"notes":"n"}\n```';
  const result = parseEnvelope(text);
  assert.equal(result.tier, 1);
  assert.deepEqual(result.files, [{ path: 'a.js', content: 'x' }]);
});

test('parseEnvelope tier 2: prose-wrapped JSON with a trailing comma still parses', () => {
  const text = 'Sure, here you go:\n{"files":[{"path":"b.js","content":"y",}],}\nHope that helps!';
  const result = parseEnvelope(text);
  assert.equal(result.tier, 2);
  assert.equal(result.files[0].path, 'b.js');
});

test('parseEnvelope tier 2 legacy fallback: the old "// file:" convention still works', () => {
  const text = '```\n// file: c.js\nconsole.log(1);\n```';
  const result = parseEnvelope(text);
  assert.equal(result.tier, 2);
  assert.equal(result.files[0].path, 'c.js');
});

test('parseEnvelope returns tier null for genuinely freeform prose', () => {
  const result = parseEnvelope('Here is my analysis of the situation: it looks fine.');
  assert.equal(result.tier, null);
  assert.deepEqual(result.files, []);
});

test('normalizePath strips traversal segments and leading slashes', () => {
  assert.equal(normalizePath('../../etc/passwd'), 'etc/passwd');
  assert.equal(normalizePath('/abs/./path'), 'abs/path');
  assert.equal(normalizePath('a\\b\\c'), 'a/b/c');
});

test('parseTaskOutput: malformed flag is true only for an attempted-but-broken envelope', async () => {
  const broken = await parseTaskOutput('```json\n{"files": [ { "path": "x.js", "content": "unterminated\n```');
  assert.equal(broken.tier, null);
  assert.equal(broken.malformed, true);

  const freeform = await parseTaskOutput('This task produced no files, just an explanation.');
  assert.equal(freeform.tier, null);
  assert.equal(freeform.malformed, false);
});

test('parseTaskOutput tier 3: an injected repair callback can rescue malformed output', async () => {
  const malformed = '```json\n{"files": [ broken';
  const result = await parseTaskOutput(malformed, {
    repair: async () => '```json\n{"files":[{"path":"fixed.js","content":"ok"}]}\n```',
  });
  assert.equal(result.tier, 3);
  assert.equal(result.files[0].path, 'fixed.js');
});
