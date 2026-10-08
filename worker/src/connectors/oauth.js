/**
 * @file OAuth 2 with PKCE for connectors (Wave 12, C8).
 *
 * begin    makes a random `state` and a PKCE verifier. The verifier sits in the vault for 10 minutes. The answer is the
 *          address that a person opens in the browser.
 * finish   checks `state`, trades the code for tokens with the verifier and the client secret, checks the scopes that Google
 *          granted, and stores the tokens in the vault. The redirect back to the dashboard holds no token.
 * refresh  gets a new access token when the old one has less than 2 minutes left. On `invalid_grant` the connection
 *          becomes `needs_reconnect` and the router gets an event.
 */
import { SafeFetchError, safeFetch } from '../lib/safeFetch.js';
import { addMinutes, nowIso, randomBytes, toBase64Url } from '../lib/util.js';
import { deleteVaultRecord, getVaultPlaintext, putVaultRecord } from '../lib/vault.js';
import { emitEvent } from '../notify.js';
import { manifestById } from './core.js';
import { getConnection, loadSecrets, saveSecrets, updateConnection } from './store.js';

export class OAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OAuthError';
    this.status = status;
    this.code = code;
  }
}

export const REFRESH_MARGIN_MS = 2 * 60_000;
const STATE_MINUTES = 10;

export const redirectUriFor = (origin, connectorId) => `${origin}/oauth/${connectorId}/callback`;

async function sha256Base64Url(text) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

const hostOf = (url) => new URL(url).hostname.toLowerCase();

async function tokenRequest(env, manifest, form) {
  const url = manifest.auth.oauth.tokenUrl;
  let res;
  try {
    res = await safeFetch(
      env,
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form).toString() },
      { allow: [hostOf(url)], timeoutMs: 8000, maxBytes: 100_000 },
    );
  } catch (err) {
    if (err instanceof SafeFetchError) throw new OAuthError(502, 'token_endpoint_unreachable', err.message);
    throw err;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Begin the flow.
 * @returns {Promise<{ authorizeUrl: string, redirectUri: string, expiresAt: string }>}
 */
export async function beginOAuth(env, { connection, manifest, secrets, origin }) {
  const oauth = manifest.auth.oauth;
  if (!oauth) throw new OAuthError(400, 'not_oauth', `${manifest.name} does not use OAuth.`);
  const clientId = connection.config.client_id;
  if (!clientId || !secrets.client_secret) throw new OAuthError(400, 'client_missing', 'The client id and the client secret are needed first.');
  const forbidden = new Set(oauth.forbiddenScopes ?? []);
  const bad = oauth.scopes.find((s) => forbidden.has(s));
  if (bad) throw new OAuthError(500, 'forbidden_scope', `The manifest asks for the scope ${bad}, which it forbids.`);

  const state = toBase64Url(randomBytes(32));
  const verifier = toBase64Url(randomBytes(32));
  const challenge = await sha256Base64Url(verifier);
  const now = new Date();
  const expiresAt = nowIso(addMinutes(now, STATE_MINUTES));
  await env.DB.prepare('INSERT INTO oauth_states (state, connection_id, connector_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(state, connection.id, manifest.id, nowIso(now), expiresAt).run();
  await putVaultRecord(env, { id: `oauth:${state}`, scope: 'oauth', ownerId: connection.id, connectionId: connection.id, connectorId: manifest.id, plaintext: verifier });

  const redirectUri = redirectUriFor(origin, manifest.id);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: oauth.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(oauth.extraAuthParams ?? {}),
  });
  return { authorizeUrl: `${oauth.authUrl}?${params.toString()}`, redirectUri, expiresAt };
}

/**
 * Finish the flow after the provider redirected back.
 * @returns {Promise<{ connectionId: string, connectorId: string }>}
 */
export async function finishOAuth(env, { state, code, origin }) {
  if (!state || !code) throw new OAuthError(400, 'state_invalid', 'The answer from the provider is incomplete.');
  const row = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state).first();
  // The state is one use. It leaves the table at once, whatever happens next.
  if (row) await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  if (!row || row.expires_at < nowIso()) {
    if (row) await deleteVaultRecord(env, `oauth:${state}`).catch(() => null);
    throw new OAuthError(400, 'state_invalid', 'The sign in took too long or the state value is wrong. Start again.');
  }
  const connection = await getConnection(env, row.connection_id);
  const manifest = manifestById(row.connector_id);
  if (!connection || !manifest?.auth.oauth) throw new OAuthError(404, 'connection_missing', 'The connection no longer exists.');
  const verifier = await getVaultPlaintext(env, { id: `oauth:${state}`, connectionId: connection.id, connectorId: manifest.id });
  await deleteVaultRecord(env, `oauth:${state}`).catch(() => null);
  if (!verifier) throw new OAuthError(400, 'state_invalid', 'The sign in expired. Start again.');
  const secrets = await loadSecrets(env, connection);

  const { status, body } = await tokenRequest(env, manifest, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUriFor(origin, manifest.id),
    client_id: connection.config.client_id,
    client_secret: secrets.client_secret,
    code_verifier: verifier,
  });
  if (status !== 200 || !body?.access_token) {
    throw new OAuthError(400, 'token_exchange_failed', `The provider did not give a token (${body?.error ?? status}).`);
  }
  const granted = String(body.scope ?? manifest.auth.oauth.scopes.join(' ')).split(/\s+/).filter(Boolean);
  const forbidden = (manifest.auth.oauth.forbiddenScopes ?? []).filter((s) => granted.includes(s));
  if (forbidden.length > 0) throw new OAuthError(400, 'scope_too_wide', `The provider granted a scope that TITAN refuses: ${forbidden[0]}. Nothing was stored.`);
  const missing = manifest.auth.oauth.scopes.filter((s) => !granted.includes(s));
  if (missing.length > 0) throw new OAuthError(400, 'scope_missing', `You did not approve the scope ${missing[0]}.`);

  const toStore = { access_token: body.access_token };
  if (body.refresh_token) toStore.refresh_token = body.refresh_token;
  await saveSecrets(env, connection, toStore);
  const secretNames = [...new Set([...connection.secretNames, ...Object.keys(toStore)])];
  const expiresAt = new Date(Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000).toISOString();
  await updateConnection(env, connection.id, { secretNames, status: 'connected', lastError: null, meta: { ...connection.meta, expiresAt, scope: granted.join(' '), authorizedAt: nowIso() } });
  return { connectionId: connection.id, connectorId: manifest.id };
}

/**
 * Return secrets that hold a fresh access token. It refreshes the token when less than 2 minutes remain.
 * @returns {Promise<Record<string,string>>}
 */
export async function ensureAccessToken(env, connection, manifest, secrets, now = Date.now()) {
  if (!secrets.access_token || !secrets.refresh_token) throw new OAuthError(409, 'needs_authorization', 'Approve the access first. Choose Connect on the connector card.');
  const expires = Date.parse(connection.meta?.expiresAt ?? '');
  if (Number.isFinite(expires) && expires - now > REFRESH_MARGIN_MS) return secrets;

  const { status, body } = await tokenRequest(env, manifest, {
    grant_type: 'refresh_token',
    refresh_token: secrets.refresh_token,
    client_id: connection.config.client_id,
    client_secret: secrets.client_secret,
  });
  if (status !== 200 || !body?.access_token) {
    if (body?.error === 'invalid_grant' || status === 400 || status === 401) {
      await updateConnection(env, connection.id, { status: 'needs_reconnect', lastError: 'The provider refused the refresh token. Connect again.' });
      await emitEvent(env, { type: 'connector.needs_reconnect', severity: 'warn', title: `${manifest.name} needs a new sign in`, body: 'The provider refused the refresh token. Open Connectors and choose Connect again.', source: `connector:${manifest.id}`, dedupeKey: `reconnect:${connection.id}` }).catch(() => null);
      throw new OAuthError(401, 'needs_reconnect', `${manifest.name} needs a new sign in.`);
    }
    throw new OAuthError(502, 'refresh_failed', `The provider did not give a new token (${status}).`);
  }
  const next = { access_token: body.access_token };
  if (body.refresh_token) next.refresh_token = body.refresh_token;
  await saveSecrets(env, connection, next);
  const expiresAt = new Date(now + Math.max(60, Number(body.expires_in) || 3600) * 1000).toISOString();
  connection.meta = { ...connection.meta, expiresAt };
  await updateConnection(env, connection.id, { meta: connection.meta, status: 'connected', lastError: null });
  return { ...secrets, ...next };
}
