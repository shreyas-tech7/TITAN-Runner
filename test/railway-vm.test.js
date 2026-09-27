// Unit coverage for the Railway VM manifest/banner parser in
// scripts/provision-railway-vm.mjs. Pure and network-free: the module's
// SSH flow only runs when invoked directly (see its own `invokedDirectly`
// guard), so importing it here is side-effect-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRailwayManifest, isCapacityMessage } from '../scripts/provision-railway-vm.mjs';

test('parses the human welcome banner Railway prints on connect', () => {
  const banner = [
    'zippy-laughter',
    'Welcome to your Railway VM. You have 60 min to try it out.',
    'Run your app on $PORT, then try it in your browser.',
    '• Claim: https://railway.com/ssh-signup?code=abc123',
    '• Try it: https://zippy-laughter.up.railway.app',
  ].join('\n');
  const m = parseRailwayManifest(banner);
  assert.equal(m.previewUrl, 'https://zippy-laughter.up.railway.app');
  assert.equal(m.claimUrl, 'https://railway.com/ssh-signup?code=abc123');
  assert.equal(m.name, 'zippy-laughter');
});

test('parses a JSON manifest interleaved with banner noise', () => {
  const stream =
    'some banner line\n' +
    '{"preview_url":"https://foo-bar.up.railway.app","claim_url":"https://railway.com/ssh-signup?code=zzz","name":"foo-bar","build_deadline":"2026-09-27T19:00:00Z"}\n' +
    'trailing text';
  const m = parseRailwayManifest(stream);
  assert.equal(m.previewUrl, 'https://foo-bar.up.railway.app');
  assert.equal(m.claimUrl, 'https://railway.com/ssh-signup?code=zzz');
  assert.equal(m.name, 'foo-bar');
  assert.equal(m.buildDeadline, '2026-09-27T19:00:00Z');
});

test('camelCase manifest keys are accepted too', () => {
  const m = parseRailwayManifest('{"previewUrl":"https://cc.up.railway.app","claimUrl":"https://railway.com/ssh-signup?code=c"}');
  assert.equal(m.previewUrl, 'https://cc.up.railway.app');
  assert.equal(m.claimUrl, 'https://railway.com/ssh-signup?code=c');
});

test('returns null on output with no URL at all', () => {
  assert.equal(parseRailwayManifest('just a login MOTD, nothing useful'), null);
  assert.equal(parseRailwayManifest(''), null);
  assert.equal(parseRailwayManifest(null), null);
});

test('detects the retryable capacity message', () => {
  assert.equal(isCapacityMessage('Anonymous trials are temporarily disabled. Try again shortly, or sign up.'), true);
  assert.equal(isCapacityMessage('welcome to your box'), false);
});

test('a preview URL with no claim link still parses (claimUrl null, not a throw)', () => {
  const m = parseRailwayManifest('Try it: https://solo.up.railway.app');
  assert.equal(m.previewUrl, 'https://solo.up.railway.app');
  assert.equal(m.claimUrl, null);
});
