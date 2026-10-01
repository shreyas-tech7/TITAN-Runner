/**
 * @file Short lived access tokens for the God's Eye View tab.
 *
 * The TITAN-GEV gateway (github.com/shreyas-tech7/TITAN-GEV) hosts the globe on a
 * public Hugging Face Space URL and refuses every request that lacks a session.
 * This module mints the one-time credential that starts a session:
 *
 *   gev1.<iat>.<exp>.<jti>.<sig>
 *   sig = base64url(HMAC-SHA256(GEV_SHARED_SECRET, "gev1.<iat>.<exp>.<jti>"))
 *
 * The gateway has its own node:crypto twin of this format, and both sides check
 * the shared test vector in worker/test/gev-vector.json.
 */

export const GEV_TOKEN_PREFIX = 'gev1';
export const GEV_TOKEN_TTL_SECONDS = 300;
export const GEV_MIN_SECRET_LENGTH = 32;

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint one access token. `nowMs` and `jti` exist so tests can pin the output.
 * Returns the token and its expiry in epoch seconds.
 */
export async function mintGevToken(secret, { nowMs = Date.now(), ttlSeconds = GEV_TOKEN_TTL_SECONDS, jti } = {}) {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const id = jti ?? toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${GEV_TOKEN_PREFIX}.${iat}.${exp}.${id}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return { token: `${payload}.${toBase64Url(new Uint8Array(signature))}`, iat, exp };
}
