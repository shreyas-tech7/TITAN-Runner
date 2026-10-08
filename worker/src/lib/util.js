/**
 * @file Small shared helpers for the Worker: encoding, hashing, random values, and JSON responses.
 * Nothing here touches the network or D1.
 */

const encoder = new TextEncoder();

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  return fromBase64(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

/** @param {string|Uint8Array} data @returns {Promise<string>} Lowercase hex of the SHA-256 digest. */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomHex(n) {
  return toHex(randomBytes(n));
}

/** A short id that appears in logs, responses, and the UI. It holds no secret. */
export function newRequestId() {
  return `req_${randomHex(6)}`;
}

/** Constant-time string compare. A `===` compare of a bearer value would leak timing. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * A JSON response. CORS headers are added once, at the edge of the app, not here.
 * @param {unknown} data
 * @param {number} [status]
 * @param {Record<string,string>} [headers]
 */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A JSON error body with a stable `error` code and a short message. */
export function jsonError(status, error, message, extra = {}) {
  return json({ error, ...(message ? { message } : {}), ...extra }, status);
}

/**
 * Read a JSON object body with a size limit.
 * @param {Request} request
 * @param {number} [maxBytes]
 * @returns {Promise<{ ok: true, value: any } | { ok: false, response: Response }>}
 */
export async function readJson(request, maxBytes = 65_536) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: jsonError(400, 'invalid_body', 'The body could not be read.') };
  }
  if (text.length > maxBytes) return { ok: false, response: jsonError(413, 'body_too_large', `The body is larger than ${maxBytes} bytes.`) };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: jsonError(400, 'invalid_json', 'The body must be a JSON object.') };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, response: jsonError(400, 'invalid_json', 'The body is not valid JSON.') };
  }
}

/** The first `n` hex characters of the SHA-256 of a value. A fingerprint reveals nothing about the value. */
export async function fingerprintOf(value, n = 12) {
  return (await sha256Hex(value)).slice(0, n);
}

export function last4Of(value) {
  const s = String(value);
  return s.length >= 4 ? s.slice(-4) : '';
}

/** Clamp a value taken from a query string. */
export function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
