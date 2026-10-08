// S6: the secret scan knows the credentials of the connectors. Every sample is built from parts, so the source holds no
// literal that looks like a real credential. Each pattern has a positive case and a negative case that must stay clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PATTERNS, redactString } from '../src/lib/redact.js';
import { scrubForState } from '../src/lib/secretScrub.js';

const MASK = '[REDACTED]';
const rep = (ch, n) => ch.repeat(n);

const POSITIVE = {
  'Telegram bot token': ['123456789', ':', 'AA', rep('b', 33)].join(''),
  'Notion secret (old form)': ['secret', '_', rep('N', 43)].join(''),
  'Notion token (new form)': ['ntn', '_', rep('n', 36)].join(''),
  'Linear API key': ['lin', '_api_', rep('L', 40)].join(''),
  'Linear OAuth token': ['lin', '_oauth_', rep('o', 40)].join(''),
  'Slack webhook URL': ['https://hooks', '.slack.com/services/', 'T0AAAA', '/', 'B0BBBB', '/', rep('x', 24)].join(''),
  'Discord webhook URL': ['https://discord', '.com/api/webhooks/', '123456789012345678', '/', rep('d', 40)].join(''),
  'Discord webhook URL (discordapp host)': ['https://discordapp', '.com/api/webhooks/', '123456789012345678', '/', rep('e', 40)].join(''),
  'ntfy topic URL': ['https://ntfy', '.sh/', 'my-secret-topic-123'].join(''),
  'Google OAuth client secret': ['GOCSPX', '-', rep('g', 28)].join(''),
};

for (const [name, sample] of Object.entries(POSITIVE)) {
  test(`S6: ${name} is masked`, () => {
    const out = redactString(`before ${sample} after`);
    assert.ok(!out.includes(sample), `${name} was not masked: ${out}`);
    assert.match(out, /^before .*\[REDACTED\].* after$/);
    assert.ok(!scrubForState({ note: `x ${sample} y` }).note.includes(sample));
  });
}

test('S6: ordinary text, times, versions, and documentation placeholders stay clean', () => {
  const clean = [
    'The meeting is at 10:30:45 today.',
    'Open ntfy.sh in a browser.',
    'Use https://ntfy.sh/<your-topic> as the address.',
    'See https://hooks.slack.com/ for the docs.',
    'See https://discord.com/developers/docs for the docs.',
    'The variable secret_key_name holds a name.',
    'ratio 12345678:9',
    'lin_api is a prefix.',
    'Version 1.2.3 of the tool.',
    'GOCSPX is the prefix of a secret.',
  ];
  for (const text of clean) assert.equal(redactString(text), text, text);
});

test('S6: the new patterns sit before the two generic catch-alls, so the diff scan still uses them', () => {
  const index = (needle) => SECRET_PATTERNS.findIndex((p) => p.source.includes(needle));
  for (const needle of ['GOCSPX', 'ntfy', 'hooks\\.slack', 'lin_', 'ntn_', 'secret_']) {
    assert.ok(index(needle) >= 0 && index(needle) < SECRET_PATTERNS.length - 2, needle);
  }
});

test('S6: no pattern can backtrack badly on hostile input', () => {
  const hostile = ['1'.repeat(5000), ':'.repeat(5000), 'secret_'.repeat(1000), 'https://hooks.slack.com/services/T' + 'A'.repeat(5000), 'a'.repeat(5000) + '@'];
  const started = performance.now();
  for (const text of hostile) redactString(text);
  assert.ok(performance.now() - started < 500, 'the patterns must run in linear time');
});
