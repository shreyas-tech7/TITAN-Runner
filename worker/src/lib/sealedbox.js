/**
 * @file The sealed box that GitHub needs for an Actions secret (Wave 12, K12).
 *
 * GitHub asks for libsodium `crypto_box_seal`: an ephemeral X25519 key pair, a nonce that is the BLAKE2b-24 hash
 * of the two public keys, and XSalsa20-Poly1305 for the message. The result is `ephemeralPublicKey || box`.
 *
 * The slow part is the X25519 math. In pure JavaScript (tweetnacl) it can eat a large share of the 10 ms CPU
 * budget of the Workers free plan. So the primary path uses WebCrypto for X25519, which runs as native code,
 * and uses tweetnacl only for HSalsa20 (ported below) and for XSalsa20-Poly1305 (`secretbox`). If WebCrypto
 * cannot do X25519, the function falls back to the pure tweetnacl path. Both paths make the same bytes in
 * shape, and both open with libsodium. The tests prove that with the real `libsodium-wrappers`.
 */
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import sealedbox from 'tweetnacl-sealedbox-js';
import { fromBase64, toBase64 } from './util.js';

const SIGMA = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]); // "expand 32-byte k"
const ZERO16 = new Uint8Array(16);

function le32(a, i) {
  return (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) | 0;
}

function rotl(v, n) {
  return (v << n) | (v >>> (32 - n));
}

/**
 * HSalsa20 core. It turns an X25519 shared secret into the key for XSalsa20-Poly1305.
 * Ported from the public domain tweetnacl `core_hsalsa20`.
 * @param {Uint8Array} input 16 bytes
 * @param {Uint8Array} key 32 bytes
 * @returns {Uint8Array} 32 bytes
 */
export function hsalsa20(input, key) {
  const x = new Int32Array(16);
  x[0] = le32(SIGMA, 0);
  x[1] = le32(key, 0);
  x[2] = le32(key, 4);
  x[3] = le32(key, 8);
  x[4] = le32(key, 12);
  x[5] = le32(SIGMA, 4);
  x[6] = le32(input, 0);
  x[7] = le32(input, 4);
  x[8] = le32(input, 8);
  x[9] = le32(input, 12);
  x[10] = le32(SIGMA, 8);
  x[11] = le32(key, 16);
  x[12] = le32(key, 20);
  x[13] = le32(key, 24);
  x[14] = le32(key, 28);
  x[15] = le32(SIGMA, 12);

  const qr = (a, b, c, d) => {
    x[b] ^= rotl((x[a] + x[d]) | 0, 7);
    x[c] ^= rotl((x[b] + x[a]) | 0, 9);
    x[d] ^= rotl((x[c] + x[b]) | 0, 13);
    x[a] ^= rotl((x[d] + x[c]) | 0, 18);
  };
  for (let i = 0; i < 20; i += 2) {
    qr(0, 4, 8, 12);
    qr(5, 9, 13, 1);
    qr(10, 14, 2, 6);
    qr(15, 3, 7, 11);
    qr(0, 1, 2, 3);
    qr(5, 6, 7, 4);
    qr(10, 11, 8, 9);
    qr(15, 12, 13, 14);
  }
  const out = new Uint8Array(32);
  const words = [x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]];
  words.forEach((w, i) => {
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  });
  return out;
}

/** The nonce of a sealed box: BLAKE2b with a 24 byte output over the two public keys. */
export function sealNonce(ephemeralPublic, recipientPublic) {
  const both = new Uint8Array(64);
  both.set(ephemeralPublic, 0);
  both.set(recipientPublic, 32);
  return blake2b(both, undefined, 24);
}

/** True when this runtime can do X25519 through WebCrypto. The answer is cached. */
let webCryptoX25519 = null;
async function supportsWebCryptoX25519() {
  if (webCryptoX25519 !== null) return webCryptoX25519;
  try {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    webCryptoX25519 = Boolean(pair?.publicKey);
  } catch {
    webCryptoX25519 = false;
  }
  return webCryptoX25519;
}

/** Seal bytes for a recipient public key, with X25519 done by WebCrypto. */
export async function sealWithWebCrypto(message, recipientPublic) {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const recipientKey = await crypto.subtle.importKey('raw', recipientPublic, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: recipientKey }, pair.privateKey, 256));
  const boxKey = hsalsa20(ZERO16, shared);
  const nonce = sealNonce(ephemeralPublic, recipientPublic);
  const box = nacl.secretbox(message, nonce, boxKey);
  const out = new Uint8Array(32 + box.length);
  out.set(ephemeralPublic, 0);
  out.set(box, 32);
  boxKey.fill(0);
  shared.fill(0);
  return out;
}

/** Seal bytes with pure JavaScript. This is the old path, kept as the fallback. */
export function sealWithNacl(message, recipientPublic) {
  return sealedbox.seal(message, recipientPublic);
}

/**
 * Encrypt a value for GitHub's repository secret API.
 * @param {string} plaintext
 * @param {string} publicKeyBase64 The `key` field of GET /actions/secrets/public-key.
 * @returns {Promise<string>} The `encrypted_value` as base64.
 */
export async function sealForGithub(plaintext, publicKeyBase64) {
  const recipient = fromBase64(publicKeyBase64);
  if (recipient.length !== 32) throw new Error('The GitHub public key has the wrong length.');
  const message = new TextEncoder().encode(plaintext);
  if (await supportsWebCryptoX25519()) {
    try {
      return toBase64(await sealWithWebCrypto(message, recipient));
    } catch {
      // fall through to the pure JavaScript path
    }
  }
  return toBase64(sealWithNacl(message, recipient));
}
