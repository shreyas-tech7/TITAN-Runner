import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPii, luhnValid } from '../src/lib/pii.js';
import { scanText, scanDirs } from '../scripts/check-public-pii.mjs';

test('luhnValid accepts a test card number and rejects a random run', () => {
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('4242424242424243'), false);
});

test('findPii finds a phone number, a Telegram id, a chat id, an SSN, and a card number', () => {
  const text = [
    'call 312-555-0142 today',
    'telegram_user_id: 123456789',
    '"chat_id": 987654321',
    'ssn 123-45-6789',
    'card 4242 4242 4242 4242',
  ].join('\n');
  const rules = findPii(text).map((h) => h.rule).sort();
  assert.deepEqual(rules, ['card-number', 'phone-number', 'telegram-chat-id', 'telegram-user-id', 'us-ssn']);
});

test('findPii reports the line number and never the matched text', () => {
  const hits = findPii('ok\nok\ntelegram_id=55555555');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.equal(JSON.stringify(hits).includes('55555555'), false);
});

test('findPii ignores ordinary numbers, dates, and short ids', () => {
  const text = '{"ts":"2026-10-15T23:40:59Z","count":1234567,"run":42,"pr":123}\nversion 1.2.3\n2026-10-15';
  assert.deepEqual(findPii(text), []);
});

test('scanText flags a personal email address and a key, and allows a public bot address', () => {
  const fakeKey = ['gsk', 'a'.repeat(24)].join('_');
  const hits = scanText(`from shreyas@example-person.net and key ${fakeKey}`);
  assert.ok(hits.length >= 2);
  assert.deepEqual(scanText('noreply@github.com 12345+bot@users.noreply.github.com'), []);
});

test('scanDirs scans nested files and counts them, and reports the file without the text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'));
  try {
    mkdirSync(join(dir, 'state', 'digests'), { recursive: true });
    writeFileSync(join(dir, 'state', 'a.json'), '{"ok":true}');
    writeFileSync(join(dir, 'state', 'digests', 'b.md'), 'Call me on 312-555-0142.');
    const { findings, scanned } = scanDirs([join(dir, 'state')]);
    assert.equal(scanned, 2);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'phone-number');
    assert.ok(findings[0].file.endsWith('b.md'));
    assert.equal(JSON.stringify(findings).includes('555-0142'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the live state/ folder of this repository is clean', () => {
  const { findings } = scanDirs([join(process.cwd(), 'state')]);
  assert.deepEqual(findings, []);
});
