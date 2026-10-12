import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  capDeadline, hideClaimCode, maxLifetimeMinutes, sanitizeClaimUrl, sanitizePreviewUrl, sshEnv,
} from '../src/lib/vmSafety.js';

test('RT6: the ssh child gets a bare environment with no key and no token', () => {
  const env = sshEnv({
    PATH: '/usr/bin', LANG: 'C', GROQ_API_KEY: 'a', GEMINI_API_KEY: 'b', TITAN_ADMIN_TOKEN: 'c', TITAN_CALLBACK_TOKEN: 'd',
    GITHUB_TOKEN: 'e', OPS_TOKEN: 'f', HERMES_1_API_KEY: 'g', SSH_AUTH_SOCK: '/tmp/agent',
  }, '/tmp/home');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(env.HOME, '/tmp/home');
});

test('RT6: the lifetime cap has a default, a floor, and a ceiling', () => {
  assert.equal(maxLifetimeMinutes({}), 120);
  assert.equal(maxLifetimeMinutes({ TITAN_VM_MAX_LIFETIME_MINUTES: '45' }), 45);
  assert.equal(maxLifetimeMinutes({ TITAN_VM_MAX_LIFETIME_MINUTES: '1' }), 10);
  assert.equal(maxLifetimeMinutes({ TITAN_VM_MAX_LIFETIME_MINUTES: '99999' }), 1440);
  assert.equal(maxLifetimeMinutes({ TITAN_VM_MAX_LIFETIME_MINUTES: 'abc' }), 120);
});

test('RT6: capDeadline cuts a late deadline and fills a missing or broken one', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  assert.equal(capDeadline('2026-10-12T12:00:00.000Z', now, 120), '2026-10-11T14:00:00.000Z');
  assert.equal(capDeadline('2026-10-11T12:30:00.000Z', now, 120), '2026-10-11T12:30:00.000Z');
  assert.equal(capDeadline(undefined, now, 120), '2026-10-11T14:00:00.000Z');
  assert.equal(capDeadline('not a date', now, 120), '2026-10-11T14:00:00.000Z');
});

const PREVIEW_CASES = [
  ['https://box-1.up.railway.app', 'https://box-1.up.railway.app/'],
  ['https://BOX-1.up.railway.app/path/x?secret=1#f', 'https://box-1.up.railway.app/'],
  ['http://box-1.up.railway.app', null],
  ['https://box-1.up.railway.app.evil.example/', null],
  ['https://evil.example/box.up.railway.app', null],
  ['https://user:pw@box-1.up.railway.app/', null],
  ['https://box-1.up.railway.app:444/', null],
  ['ftp://box-1.up.railway.app/', null],
  ['', null],
  [42, null],
];
for (const [input, expected] of PREVIEW_CASES) {
  test(`RT6: sanitizePreviewUrl(${JSON.stringify(input)})`, () => {
    assert.equal(sanitizePreviewUrl(input), expected);
  });
}

test('RT6: sanitizeClaimUrl keeps only the code and hideClaimCode hides it in text', () => {
  assert.equal(sanitizeClaimUrl('https://railway.com/ssh-signup?code=Ab12_-cd34'), 'https://railway.com/ssh-signup?code=Ab12_-cd34');
  assert.equal(sanitizeClaimUrl('https://railway.com/ssh-signup?code=Ab12cd34&x=1'), null);
  assert.equal(sanitizeClaimUrl('https://railway.com/ssh-signup'), null);
  assert.equal(sanitizeClaimUrl('http://railway.com/ssh-signup?code=Ab12cd34'), null);
  assert.equal(hideClaimCode('go to https://railway.com/ssh-signup?code=Ab12cd34 now'), 'go to https://railway.com/ssh-signup?code=[hidden] now');
});

test('RT6/RT3: the provision script cleans URLs, caps the lifetime, hides the code, and asks the gate before it opens ssh', () => {
  const src = readFileSync(new URL('../scripts/provision-railway-vm.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('env: sshEnv(process.env, dir)'), 'the ssh child runs with a bare environment');
  assert.ok(src.includes('sanitizePreviewUrl(') && src.includes('sanitizeClaimUrl(') && src.includes('capDeadline('));
  assert.ok(src.includes('hideClaimCode('), 'a log line hides the claim code');
  const gate = src.indexOf('await gateVmCommand(');
  const spawn = src.indexOf("spawnSync(\n      'ssh'");
  assert.ok(gate !== -1 && spawn !== -1 && src.indexOf('connectToRailway()', gate) > gate, 'the gate runs before the ssh connection');
  assert.ok(!/reviewAction/.test(src), 'the script calls the gate module, not the reviewer directly');
  // No provider key name is read anywhere in the script.
  assert.ok(!/(GROQ|GEMINI|OPENROUTER|TOGETHER|HF)_API_KEY/.test(src));
});
