// S6: every secret pattern of the connectors has a test. A sample must be scrubbed and must be caught by the diff scan.
// The samples are built from parts, so that no key shaped text sits in this file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SECRET_PATTERNS, redactString } from '../src/lib/redact.js';

const DIFF_PATTERNS = SECRET_PATTERNS.slice(0, -2);
const rep = (c, n) => c.repeat(n);

const POSITIVE = {
  'Telegram bot token': [rep('1', 9), ':', rep('A', 35)].join(''),
  'Notion old secret': ['secret', '_', rep('a', 43)].join(''),
  'Notion ntn token': ['ntn', '_', rep('b', 36)].join(''),
  'Linear API key': ['lin', '_api_', rep('c', 40)].join(''),
  'Linear OAuth token': ['lin', '_oauth_', rep('d', 40)].join(''),
  'Slack webhook URL': ['https://hooks', '.slack.com/services/', 'T0AAAAAA', '/B0BBBBBB/', rep('e', 24)].join(''),
  'Discord webhook URL': ['https://discord', '.com/api/webhooks/', rep('1', 18), '/', rep('f', 40)].join(''),
  'ntfy topic URL': ['https://ntfy', '.sh/', 'topic-', rep('g', 12)].join(''),
  'Google OAuth client secret': ['GOC', 'SPX-', rep('h', 28)].join(''),
  'TITAN MCP token': ['titan_mcp', '_', rep('i', 43)].join(''),
  'Render API key': ['rnd', '_', rep('j', 24)].join(''),
};

for (const [name, sample] of Object.entries(POSITIVE)) {
  test(`S6: ${name} is scrubbed from a string and caught by the diff scan`, () => {
    const line = `see ${sample} here`;
    assert.ok(!redactString(line).includes(sample), 'redactString removes it');
    assert.ok(DIFF_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace('g', '')).test(line)), 'a non generic pattern catches it');
  });
}

test('S6: plain words, ids, and short look-alikes are not scrubbed', () => {
  const clean = [
    'secret_manager is a module name',
    'ntn_short',
    'lin_api_short',
    'The topic is at https://ntfy.sh/ and the docs say more.',
    'discord webhooks use a URL',
    'Telegram uses 123456:short',
    'titan_mcp_ is a prefix',
    'render_status',
    '2026-10-08T12:00:00Z',
    'Use the path /v1/items',
    'a1b2-c3d4',
  ];
  for (const text of clean) assert.equal(redactString(text), text, text);
});
