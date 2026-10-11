/**
 * @file OAuth 2.1 with PKCE for the TITAN MCP server (Wave 12, M5).
 *
 * Implements RFC 9728 (Protected Resource Metadata), RFC 8414 (Authorization Server Metadata),
 * RFC 7591 (Dynamic Client Registration with redirect URI allowlist), and OAuth 2.1 authorization_code
 * and refresh_token grants with S256 PKCE. Only SHA-256 hashes of codes, access tokens, and refresh tokens
 * are stored in D1.
 */
import { MCP_SCOPES, TOKEN_PREFIX } from './mcpServer.js';
import { equalConstantTime } from './lib/hmac.js';
import { json, jsonError, nowIso, randomBytes, readJson, sha256Hex, toBase64Url } from './lib/util.js';

export const CLAUDE_CALLBACK_URLS = Object.freeze([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

const ACCESS_TOKEN_TTL_SECONDS = 3600;
const CODE_TTL_MS = 10 * 60_000;
const encoder = new TextEncoder();

function originOf(c) {
  return String(c.env.WORKER_URL || new URL(c.request.url).origin).replace(/\/+$/, '');
}

function dashOf(c) {
  return String(c.env.DASHBOARD_URL || 'https://shreyas-tech7.github.io/TITAN-Runner').replace(/\/+$/, '');
}

/** Allow only Claude's MCP callback URLs and localhost/127.0.0.1 for the MCP Inspector. */
export function isAllowedMcpRedirectUri(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  if (CLAUDE_CALLBACK_URLS.includes(raw.trim())) return true;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
    return !u.username && !u.password;
  }
  return false;
}

async function pkceS256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

function parseScopes(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.map(String).filter((s) => MCP_SCOPES.includes(s)))];
  if (typeof raw === 'string' && raw.trim()) {
    return [...new Set(raw.trim().split(/[\s,]+/).filter((s) => MCP_SCOPES.includes(s)))];
  }
  return ['status:read', 'connectors:read'];
}

/** GET /.well-known/oauth-protected-resource */
export function handleProtectedResourceMeta(c) {
  const origin = originOf(c);
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
  });
}

/** GET /.well-known/oauth-authorization-server */
export function handleAuthServerMeta(c) {
  const origin = originOf(c);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/mcp/authorize`,
    token_endpoint: `${origin}/oauth/mcp/token`,
    registration_endpoint: `${origin}/oauth/mcp/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...MCP_SCOPES],
  });
}

/** POST /oauth/mcp/register (public dynamic client registration with redirect URI allowlist) */
export async function handleMcpRegister(c) {
  const parsed = await readJson(c.request, 8192);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};
  const clientName = String(body.client_name ?? 'MCP Client').trim().slice(0, 60) || 'MCP Client';
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedMcpRedirectUri)) {
    return jsonError(400, 'invalid_redirect_uri', 'Every redirect_uri must be the Claude callback URL or http://localhost for the MCP Inspector.', {
      allowed: [...CLAUDE_CALLBACK_URLS, 'http://localhost:<port>/callback', 'http://127.0.0.1:<port>/callback'],
    });
  }
  const clientId = `mcp_client_${toBase64Url(randomBytes(12))}`;
  const now = nowIso();
  await c.env.DB.prepare('INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, grant_types, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(clientId, clientName, JSON.stringify(uris), JSON.stringify(['authorization_code', 'refresh_token']), now)
    .run();
  return json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

/** GET /oauth/mcp/authorize: validates query parameters and sends the person to the dashboard consent screen. */
export async function handleMcpAuthorizeGet(c) {
  const q = new URL(c.request.url).searchParams;
  const clientId = q.get('client_id') ?? '';
  const redirectUri = q.get('redirect_uri') ?? '';
  const codeChallenge = q.get('code_challenge') ?? '';
  const method = q.get('code_challenge_method') ?? 'S256';
  const state = q.get('state') ?? '';
  const scopes = parseScopes(q.get('scope') ?? '');

  if (!clientId || !isAllowedMcpRedirectUri(redirectUri)) {
    return jsonError(400, 'invalid_request', 'A registered client_id and an allowlisted redirect_uri are required.');
  }
  if (!codeChallenge || method !== 'S256') {
    return jsonError(400, 'invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  }
  const client = await c.env.DB.prepare('SELECT * FROM mcp_oauth_clients WHERE client_id = ?').bind(clientId).first();
  if (!client) return jsonError(400, 'invalid_client', 'This client_id is not registered.');
  const registeredUris = JSON.parse(client.redirect_uris || '[]');
  if (!registeredUris.includes(redirectUri)) {
    return jsonError(400, 'invalid_redirect_uri', 'The redirect_uri does not match the registered client.');
  }

  const params = new URLSearchParams({
    tab: 'mcp',
    mcp_authorize: '1',
    client_id: clientId,
    client_name: client.client_name,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...(state ? { state } : {}),
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${dashOf(c)}/connectors/?${params.toString()}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** POST /oauth/mcp/authorize (admin): approves consent and issues a short-lived authorization code. */
export async function handleMcpAuthorizeApprove(c) {
  const parsed = await readJson(c.request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.value ?? {};
  const clientId = String(b.client_id ?? '').trim();
  const redirectUri = String(b.redirect_uri ?? '').trim();
  const codeChallenge = String(b.code_challenge ?? '').trim();
  const method = String(b.code_challenge_method ?? 'S256').trim();
  const state = typeof b.state === 'string' ? b.state : '';
  const scopes = parseScopes(b.scopes ?? b.scope);

  if (!clientId || !isAllowedMcpRedirectUri(redirectUri)) {
    return jsonError(400, 'invalid_request', 'A valid client_id and allowlisted redirect_uri are required.');
  }
  if (!codeChallenge || method !== 'S256') {
    return jsonError(400, 'invalid_request', 'PKCE S256 code_challenge is required.');
  }
  const client = await c.env.DB.prepare('SELECT * FROM mcp_oauth_clients WHERE client_id = ?').bind(clientId).first();
  if (!client) return jsonError(400, 'invalid_client', 'This client_id is not registered.');
  const registeredUris = JSON.parse(client.redirect_uris || '[]');
  if (!registeredUris.includes(redirectUri)) {
    return jsonError(400, 'invalid_redirect_uri', 'The redirect_uri does not match the registered client.');
  }

  const code = `mcpc_${toBase64Url(randomBytes(24))}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO mcp_oauth_codes (code_hash, client_id, client_name, redirect_uri, scopes, code_challenge, code_challenge_method, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?)`,
  )
    .bind(await sha256Hex(code), clientId, client.client_name, redirectUri, scopes.join(' '), codeChallenge, now.toISOString(), expiresAt)
    .run();

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  return json({ ok: true, code, redirectTo: target.toString(), expiresAt, requestId: c.requestId });
}

async function readTokenRequestParams(request) {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  const text = await request.text();
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
}

/** POST /oauth/mcp/token: exchanges an authorization code (with PKCE) or refresh token for an MCP token pair. */
export async function handleMcpTokenExchange(c) {
  const params = await readTokenRequestParams(c.request);
  const grantType = String(params.grant_type ?? '');

  if (grantType === 'authorization_code') {
    const code = String(params.code ?? '');
    const verifier = String(params.code_verifier ?? '');
    const redirectUri = String(params.redirect_uri ?? '');
    const clientId = String(params.client_id ?? '');
    if (!code || !verifier) {
      return json({ error: 'invalid_request', error_description: 'code and code_verifier are required.' }, 400);
    }
    const codeHash = await sha256Hex(code);
    const row = await c.env.DB.prepare('SELECT * FROM mcp_oauth_codes WHERE code_hash = ?').bind(codeHash).first();
    if (!row || row.used_at || row.expires_at < nowIso()) {
      return json({ error: 'invalid_grant', error_description: 'The authorization code is invalid, expired, or already used.' }, 400);
    }
    if (clientId && row.client_id !== clientId) {
      return json({ error: 'invalid_client', error_description: 'client_id does not match.' }, 400);
    }
    if (redirectUri && row.redirect_uri !== redirectUri) {
      return json({ error: 'invalid_grant', error_description: 'redirect_uri does not match.' }, 400);
    }
    const computedChallenge = await pkceS256(verifier);
    if (!equalConstantTime(computedChallenge, row.code_challenge)) {
      return json({ error: 'invalid_grant', error_description: 'PKCE code_verifier check failed.' }, 400);
    }
    await c.env.DB.prepare('UPDATE mcp_oauth_codes SET used_at = ? WHERE code_hash = ?').bind(nowIso(), codeHash).run();

    const accessToken = `${TOKEN_PREFIX}${toBase64Url(randomBytes(32))}`;
    const refreshToken = `titan_mcpr_${toBase64Url(randomBytes(32))}`;
    const tokenId = `t_${toBase64Url(randomBytes(6))}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();

    await c.env.DB.prepare(
      `INSERT INTO mcp_tokens (id, label, token_hash, refresh_token_hash, scopes, kind, client_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'oauth', ?, ?, ?)`,
    )
      .bind(tokenId, `${row.client_name} (OAuth)`, await sha256Hex(accessToken), await sha256Hex(refreshToken), row.scopes, row.client_id, now.toISOString(), expiresAt)
      .run();

    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: row.scopes,
    });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = String(params.refresh_token ?? '');
    if (!refreshToken) return json({ error: 'invalid_request', error_description: 'refresh_token is required.' }, 400);
    const refreshHash = await sha256Hex(refreshToken);
    const row = await c.env.DB.prepare('SELECT * FROM mcp_tokens WHERE refresh_token_hash = ? AND revoked_at IS NULL').bind(refreshHash).first();
    if (!row) return json({ error: 'invalid_grant', error_description: 'The refresh token is invalid or revoked.' }, 400);

    const newAccessToken = `${TOKEN_PREFIX}${toBase64Url(randomBytes(32))}`;
    const newRefreshToken = `titan_mcpr_${toBase64Url(randomBytes(32))}`;
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
    await c.env.DB.prepare('UPDATE mcp_tokens SET token_hash = ?, refresh_token_hash = ?, expires_at = ?, last_used_at = ? WHERE id = ?')
      .bind(await sha256Hex(newAccessToken), await sha256Hex(newRefreshToken), expiresAt, nowIso(), row.id)
      .run();

    return json({
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newRefreshToken,
      scope: row.scopes,
    });
  }

  return json({ error: 'unsupported_grant_type', error_description: 'Supported grant_types: authorization_code, refresh_token.' }, 400);
}
