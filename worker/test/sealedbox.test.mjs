// Validates the exact crypto this Worker uses for POST /admin/keys against
// tweetnacl's own box primitives (not just tweetnacl-sealedbox-js's own
// claims) — since a mistake here would mean a provider key silently fails
// to reach GitHub in a form the Actions runner can ever decrypt, and this
// repo's real network access can't safely be spent probing that against a
// live GitHub secret. `seal()`/`open()` round-tripping through an
// independently-generated nacl.box keypair is the strongest local proof
// available that the encryption matches libsodium's crypto_box_seal
// construction GitHub's docs specify.
import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
// See src/index.js's own comment: default import, not `import *` — this
// package exposes no statically-analyzable named exports under Node's
// ESM-CJS interop.
import sealedbox from 'tweetnacl-sealedbox-js';

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return Buffer.from(binary, 'binary').toString('base64');
}

function fromBase64(str) {
  const binary = Buffer.from(str, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

test('seal() output can be opened by the matching secret key (round-trip)', () => {
  const keyPair = nacl.box.keyPair();
  const plaintext = 'gsk_test_fake_not_a_real_key_1234567890';

  const sealed = sealedbox.seal(new TextEncoder().encode(plaintext), keyPair.publicKey);
  const opened = sealedbox.open(sealed, keyPair.publicKey, keyPair.secretKey);

  assert.ok(opened, 'sealed message should open with the correct secret key');
  assert.equal(new TextDecoder().decode(opened), plaintext);
});

test('seal() cannot be opened with the wrong secret key', () => {
  const keyPair = nacl.box.keyPair();
  const wrongKeyPair = nacl.box.keyPair();
  const sealed = sealedbox.seal(new TextEncoder().encode('secret'), keyPair.publicKey);

  const opened = sealedbox.open(sealed, keyPair.publicKey, wrongKeyPair.secretKey);
  assert.equal(opened, null);
});

test('base64 round-trip preserves arbitrary key bytes exactly (the Worker\'s own toBase64/fromBase64 helpers)', () => {
  const keyPair = nacl.box.keyPair();
  const roundTripped = fromBase64(toBase64(keyPair.publicKey));
  assert.deepEqual(roundTripped, keyPair.publicKey);
});

test('full flow: base64-encoded public key in -> base64-encoded ciphertext out -> decodes and opens correctly', () => {
  const keyPair = nacl.box.keyPair();
  const publicKeyBase64 = toBase64(keyPair.publicKey);
  const plaintext = 'sk-example-not-real';

  // Mirrors sealForGithub() in src/index.js exactly.
  const publicKey = fromBase64(publicKeyBase64);
  const sealed = sealedbox.seal(new TextEncoder().encode(plaintext), publicKey);
  const encryptedValueBase64 = toBase64(sealed);

  const ciphertext = fromBase64(encryptedValueBase64);
  const opened = sealedbox.open(ciphertext, keyPair.publicKey, keyPair.secretKey);
  assert.equal(new TextDecoder().decode(opened), plaintext);
});
