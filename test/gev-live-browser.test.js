import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_TOKEN_KEY, redact, seedAdminToken } from '../scripts/gev-live-browser.mjs';

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

function withWindow(origin, run) {
  const stored = {};
  globalThis.window = { location: { origin }, localStorage: { setItem: (k, v) => { stored[k] = v; } } };
  try {
    run();
  } finally {
    delete globalThis.window;
  }
  return stored;
}

test('the login seed writes the admin token on the dashboard origin only', () => {
  const dashboard = 'https://shreyas-tech7.github.io';
  const args = [ADMIN_TOKEN_KEY, 'admin-token-value-123456', dashboard];
  assert.deepEqual(withWindow(dashboard, () => seedAdminToken(args)), { [ADMIN_TOKEN_KEY]: 'admin-token-value-123456' });
  // The globe host and any other origin must never receive the admin token.
  for (const origin of ['https://titan-gev.onrender.com', 'https://evil.example', 'null']) {
    assert.deepEqual(withWindow(origin, () => seedAdminToken(args)), {}, origin);
  }
});

test('the login seed survives blocked storage', () => {
  globalThis.window = { location: { origin: 'https://a.example' }, localStorage: { setItem() { throw new Error('blocked'); } } };
  try {
    assert.doesNotThrow(() => seedAdminToken([ADMIN_TOKEN_KEY, 'x', 'https://a.example']));
  } finally {
    delete globalThis.window;
  }
});
