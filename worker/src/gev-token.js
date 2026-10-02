/**
 * @file Signed access tokens for the God's Eye View tab.
 *
 * The TITAN-GEV gateway (github.com/shreyas-tech7/TITAN-GEV) hosts the globe on a
 * public host URL (a free Render web service) and refuses every request that lacks a
 * session. This module mints the one-time credential that starts a session:
 *
 *   gev2.<iat>.<exp>.<jti>.<sig>
 *   sig = base64url(Ed25519 signature over "gev2.<iat>.<exp>.<jti>")
 *
 * Only this Worker holds the private key. It lives in the Worker secret
 * GEV_SIGNING_KEY as a JWK string. The gateway holds the matching public key
 * (GEV_VERIFY_KEY, the JWK `x` value) and can check tokens but never make them.
 * The public key is not secret and GET /gev/jwks serves it.
 *
 * The gateway has its own node:crypto verifier. Both sides check the public
 * fixture in worker/test/gev-vector.json.
 */

export const GEV_TOKEN_PREFIX = 'gev2';
export const GEV_TOKEN_TTL_SECONDS = 300;

const ED25519 = { name: 'Ed25519' };
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Read the signing key from the secret text. Returns the JWK, or null when the
 * text is missing, is not JSON, or is not a complete Ed25519 private key. The
 * caller never learns which, so a log line cannot leak a fragment of the key.
 */
export function parseSigningJwk(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let jwk;
  try {
    jwk = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null;
  if (typeof jwk.d !== 'string' || !B64URL_32.test(jwk.d)) return null;
  if (typeof jwk.x !== 'string' || !B64URL_32.test(jwk.x)) return null;
  return jwk;
}

/** The public half of a signing key. This is the only shape the Worker ever publishes. */
export function publicJwkOf(signingJwk) {
  return { kty: 'OKP', crv: 'Ed25519', x: signingJwk.x };
}

async function importSigningKey(signingJwk) {
  // Rebuild the JWK from the four fields we trust so stray fields (key_ops, ext, alg) never matter.
  const clean = { kty: 'OKP', crv: 'Ed25519', d: signingJwk.d, x: signingJwk.x };
  return crypto.subtle.importKey('jwk', clean, ED25519, false, ['sign']);
}

let checkedKey = { raw: '', ok: false };

/**
 * True when the private key signs something that its published public key
 * verifies. This catches a secret whose `x` does not belong to its `d`, which
 * would mint tokens the gateway rejects. The answer is cached per key text.
 */
export async function signingKeyIsConsistent(raw) {
  if (checkedKey.raw === raw) return checkedKey.ok;
  let ok = false;
  const jwk = parseSigningJwk(raw);
  if (jwk) {
    try {
      const privateKey = await importSigningKey(jwk);
      const publicKey = await crypto.subtle.importKey('jwk', publicJwkOf(jwk), ED25519, false, ['verify']);
      const probe = new TextEncoder().encode('gev-self-check');
      const signature = await crypto.subtle.sign(ED25519, privateKey, probe);
      ok = await crypto.subtle.verify(ED25519, publicKey, signature, probe);
    } catch {
      ok = false;
    }
  }
  checkedKey = { raw, ok };
  return ok;
}

/**
 * Mint one access token. `nowMs` and `jti` exist so tests can pin the output.
 * Returns the token and its expiry in epoch seconds.
 */
export async function mintGevToken(signingJwk, { nowMs = Date.now(), ttlSeconds = GEV_TOKEN_TTL_SECONDS, jti } = {}) {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const id = jti ?? toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${GEV_TOKEN_PREFIX}.${iat}.${exp}.${id}`;
  const key = await importSigningKey(signingJwk);
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, key, new TextEncoder().encode(payload)));
  return { token: `${payload}.${toBase64Url(signature)}`, iat, exp };
}
