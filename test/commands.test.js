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

test('arguments are capped in count and length so a comment cannot smuggle a payload through', () => {
  const r = parseTitanCommand(`/titan approve ${'a'.repeat(500)} b c d e f g`);
  assert.equal(r.args.length, 4);
  assert.equal(r.args[0].length, 64);
  assert.ok(r.raw.length <= 200);
});
