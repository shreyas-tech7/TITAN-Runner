import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_TOKEN_KEY, redact } from '../scripts/gev-live-browser.mjs';

test('redact removes access links, session cookies, and the admin token', () => {
  const admin = 'admin-token-value-123456';
  const text = [
    'goto https://host.example/?gev_token=gev2.1.2.abcdefgh.sigsigsig&x=1',
    'cookie __Host-gev_session=gevs1.sid.1.2.sig; Path=/',
    `header X-Titan-Auth ${admin}`,
    'bare gev2.1790000000.1790000300.AAAAAAAAAAAAAAAA.c2lnbmF0dXJl',
  ].join('\n');
  const out = redact(text, [admin]);
  for (const leak of ['abcdefgh', 'sigsigsig', 'gevs1.sid', admin, 'c2lnbmF0dXJl']) {
    assert.equal(out.includes(leak), false, leak);
  }
  assert.match(out, /gev_token=\*\*\*/);
});

test('redact ignores short or empty secrets so it cannot mangle ordinary text', () => {
  assert.equal(redact('hello world', ['', 'abc', undefined]), 'hello world');
});

test('the browser test logs in with the same localStorage key the dashboard reads', () => {
  assert.equal(ADMIN_TOKEN_KEY, 'titan-runner:admin-token:v1');
});
