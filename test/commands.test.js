import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitanCommand, COMMANDS } from '../src/control/commands.js';

test('parses every documented verb from the first non-blank line', () => {
  assert.deepEqual(parseTitanCommand('/titan retry'), { verb: 'retry', args: [], raw: '/titan retry' });
  assert.deepEqual(parseTitanCommand('\n\n  /titan cancel  \nthanks'), { verb: 'cancel', args: [], raw: '/titan cancel' });
  assert.deepEqual(parseTitanCommand('/titan priority high').args, ['high']);
  assert.deepEqual(parseTitanCommand('/TITAN Approve step-3').verb, 'approve');
  for (const verb of Object.keys(COMMANDS)) {
    const args = COMMANDS[verb].args > 0 ? ' x' : '';
    assert.equal(parseTitanCommand(`/titan ${verb}${args}`)?.verb, verb, verb);
  }
});

test('the dashboard retry marker is an alias for /titan retry', () => {
  assert.equal(parseTitanCommand('**Retry requested** from the TITAN-Runner dashboard. This issue was reopened for the next pulse to pick up again.')?.verb, 'retry');
});

test('prose mentioning a verb, fenced commands, unknown verbs, missing args, and non-strings are not commands', () => {
  assert.equal(parseTitanCommand('please retry this'), null);
  assert.equal(parseTitanCommand('I ran /titan retry yesterday'), null);
  assert.equal(parseTitanCommand('```\n/titan retry\n```'), null);
  assert.equal(parseTitanCommand('/titan selfdestruct'), null);
  assert.equal(parseTitanCommand('/titan priority'), null);
  assert.equal(parseTitanCommand('/titan approve'), null);
  assert.equal(parseTitanCommand(null), null);
  assert.equal(parseTitanCommand(42), null);
  assert.equal(parseTitanCommand(''), null);
});

test('arguments are exact in count and bounded plain tokens, so a comment cannot smuggle a payload through', () => {
  assert.equal(parseTitanCommand(`/titan approve ${'a'.repeat(500)} b c d e f g`), null, 'over-long and extra tokens');
  assert.equal(parseTitanCommand('/titan approve key; rm -rf /'), null, 'shell text');
  assert.equal(parseTitanCommand('/titan cancel now please'), null, 'a verb that takes no argument, given some');
  const r = parseTitanCommand(`/titan approve tool:workspace_write:${'a'.repeat(8)}`);
  assert.deepEqual(r.args, [`tool:workspace_write:${'a'.repeat(8)}`]);
  assert.ok(parseTitanCommand(`/titan approve ${'k'.repeat(64)}`), 'a 64-char key is the maximum');
  assert.equal(parseTitanCommand(`/titan approve ${'k'.repeat(65)}`), null);
  assert.ok(r.raw.length <= 200);
});
