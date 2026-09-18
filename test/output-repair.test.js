import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubtaskOutput, repairHintFor } from '../src/reliability/outputRepair.js';

test('a blank answer is EMPTY_OUTPUT; a terse one is still an answer', () => {
  assert.equal(validateSubtaskOutput('').code, 'EMPTY_OUTPUT');
  assert.equal(validateSubtaskOutput('   \n').code, 'EMPTY_OUTPUT');
  assert.equal(validateSubtaskOutput(null).code, 'EMPTY_OUTPUT');
  assert.equal(validateSubtaskOutput('OK').ok, true);
  assert.equal(validateSubtaskOutput('a done').ok, true);
});

test('a refusal is recognised from its opening, not from the word "sorry" anywhere in a real answer', () => {
  assert.equal(validateSubtaskOutput("I'm sorry, but I can't help with that request.").code, 'REFUSAL');
  assert.equal(validateSubtaskOutput('As an AI language model I cannot complete this.').code, 'REFUSAL');
  assert.equal(validateSubtaskOutput('I am unable to provide that.').code, 'REFUSAL');
  assert.equal(validateSubtaskOutput('Here is the module. Note: the error message says "sorry, try again" on purpose.').ok, true);
});

test('an answer that tried to be a files envelope but cannot be parsed is MALFORMED_OUTPUT; a good envelope and plain prose pass', () => {
  const broken = '```json\n{"files": [ {"path": "src/broken.js", "content": "export const x = 1;\n```';
  assert.equal(validateSubtaskOutput(broken).code, 'MALFORMED_OUTPUT');
  const good = '```json\n{"files":[{"path":"src/a.js","content":"export const a = 1;\\n"}],"notes":"done"}\n```';
  assert.equal(validateSubtaskOutput(good).ok, true);
  assert.equal(validateSubtaskOutput('Plain analysis with no files, which is fine for a review step.').ok, true);
});

test('every repair code has a non-empty hint that names what to fix, and unknown codes get nothing', () => {
  for (const code of ['MALFORMED_OUTPUT', 'EMPTY_OUTPUT', 'REFUSAL']) {
    const hint = repairHintFor(code);
    assert.ok(hint.startsWith('REPAIR:'), code);
    assert.ok(hint.length > 30, code);
  }
  assert.equal(repairHintFor('SOMETHING_ELSE'), '');
  assert.match(repairHintFor('MALFORMED_OUTPUT'), /json/i);
});
