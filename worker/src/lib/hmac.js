/**
 * @file HMAC-SHA256 through WebCrypto, and a constant time compare of two hex strings (Wave 12, C6 and T4).
 */
import { toHex } from './util.js';

const encoder = new TextEncoder();

/** @param {string} secret @param {string} data @returns {Promise<string>} Lowercase hex. */
export async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))));
}

/** Compare two strings in time that depends on the length only. */
export function equalConstantTime(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
