/**
 * @file The remote MCP client (Wave 12, M3). It speaks to a server that somebody else runs, over Streamable HTTP.
 *
 * Two eras exist, and this client handles both ("dual-era" in the words of the 2026-07-28 specification):
 *   - modern (2026-07-28 and later): no handshake. Every request holds its version, its client info, and its
 *     capabilities in `params._meta`, and the headers `MCP-Protocol-Version` and `Mcp-Method` repeat them.
 *   - legacy (2025-11-25 and earlier): `initialize`, then `notifications/initialized`, then the request. A server may give a
 *     session id in the header `Mcp-Session-Id`.
 * The client tries a modern request first. A recognized modern error (-32020, -32021, -32022) means a modern server. Any
 * other 4xx answer means a legacy server, and the client falls back to `initialize`. The era is kept in the connection.
 *
 * Everything the server returns is untrusted data. The text of a tool result never becomes an instruction for TITAN.
 * Every call goes through safeFetch: https only, the host of the endpoint only, a public address only, no redirect.
 */
import { SafeFetchError, safeFetch } from '../lib/safeFetch.js';
import { nowIso } from '../lib/util.js';
import { updateConnection } from './store.js';

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';
export const MCP_TIMEOUT_MS = 20_000;
const CLIENT_INFO = Object.freeze({ name: 'titan-runner-brain', version: '1.0.0' });
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);
const MAX_TOOLS = 200;
const MAX_PAGES = 5;
const MAX_TEXT = 12_000;

export class McpClientError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'McpClientError';
    this.code = code;
    this.status = status;
  }
}

function hostOf(url) {
  return new URL(url).hostname.toLowerCase();
}

/** Parse a text/event-stream body and return the JSON-RPC message that answers `id`. */
export function parseSse(text, id) {
  let last = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg && typeof msg === 'object' && 'id' in msg && msg.id === id && ('result' in msg || 'error' in msg)) return msg;
      if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) last = msg;
    } catch {
      // A line that is not JSON is skipped.
    }
  }
  return last;
}

/** One POST. @returns {Promise<{ status: number, headers: Headers, message: any, text: string }>} */
async function post(env, endpoint, token, headers, body, id) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await safeFetch(env, endpoint, { method: 'POST', headers: h, body: JSON.stringify(body) }, { allow: [hostOf(endpoint)], timeoutMs: MCP_TIMEOUT_MS, maxBytes: 1_000_000, checkDns: true });
  } catch (err) {
    if (err instanceof SafeFetchError) throw new McpClientError(err.code, err.message);
    throw err;
  }
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  let message = null;
  if (type.includes('text/event-stream')) message = parseSse(text, id);
  else if (text) {
    try {
      message = JSON.parse(text);
    } catch {
      message = null;
    }
  }
  return { status: res.status, headers: res.headers, message, text };
}

const modernMeta = () => ({ 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientInfo': CLIENT_INFO, 'io.modelcontextprotocol/clientCapabilities': {} });

/**
 * A session over one endpoint.
 * @param {Record<string, any>} env
 * @param {{ id: string, meta: Record<string, any> }} connection
 * @param {{ url: string, token?: string }} target
 */
export function openSession(env, connection, target) {
  const state = { era: connection.meta?.mcpEra ?? null, version: connection.meta?.mcpVersion ?? null, sessionId: null, nextId: 1 };

  async function remember() {
    if (connection.meta?.mcpEra === state.era && connection.meta?.mcpVersion === state.version) return;
    connection.meta = { ...connection.meta, mcpEra: state.era, mcpVersion: state.version };
    await updateConnection(env, connection.id, { meta: connection.meta }).catch(() => null);
  }

  async function legacyHandshake(version) {
    const id = state.nextId++;
    const init = await post(env, target.url, target.token, {}, { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: version ?? LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, id);
    if (init.status === 401 || init.status === 403) throw new McpClientError('remote_auth', `The server answered ${init.status}. Check the bearer token.`, 401);
    if (init.status >= 400 || !init.message || init.message.error) {
      const why = init.message?.error?.message ? `: ${String(init.message.error.message).slice(0, 160)}` : '';
      throw new McpClientError('initialize_failed', `The server did not accept initialize (HTTP ${init.status})${why}.`);
    }
    state.era = 'legacy';
    state.version = String(init.message.result?.protocolVersion ?? version ?? LEGACY_VERSION);
    state.sessionId = init.headers.get('mcp-session-id');
    await post(env, target.url, target.token, legacyHeaders(), { jsonrpc: '2.0', method: 'notifications/initialized' }, null).catch(() => null);
    await remember();
  }

  const legacyHeaders = () => ({ 'MCP-Protocol-Version': state.version ?? LEGACY_VERSION, ...(state.sessionId ? { 'Mcp-Session-Id': state.sessionId } : {}) });

  /** @returns {Promise<any>} The `result` of the answer. */
  async function call(method, params = {}) {
    if (state.era === 'legacy' && !state.sessionId && !state.handshook) {
      await legacyHandshake(state.version);
      state.handshook = true;
    }
    if (state.era !== 'legacy') {
      const id = state.nextId++;
      const name = method === 'tools/call' ? params.name : undefined;
      const headers = { 'MCP-Protocol-Version': MODERN_VERSION, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': String(name) } : {}) };
      const res = await post(env, target.url, target.token, headers, { jsonrpc: '2.0', id, method, params: { ...params, _meta: modernMeta() } }, id);
      if (res.status === 401 || res.status === 403) throw new McpClientError('remote_auth', `The server answered ${res.status}. Check the bearer token.`, 401);
      const code = res.message?.error?.code;
      if (res.message?.result !== undefined && res.status < 400) {
        state.era = 'modern';
        state.version = MODERN_VERSION;
        await remember();
        return res.message.result;
      }
      if (MODERN_ERRORS.has(code)) {
        const supported = res.message.error.data?.supported;
        if (code === -32022 && Array.isArray(supported) && !supported.includes(MODERN_VERSION)) {
          const legacy = supported.find((v) => typeof v === 'string' && v <= LEGACY_VERSION) ?? LEGACY_VERSION;
          await legacyHandshake(legacy);
          state.handshook = true;
        } else {
          throw new McpClientError('remote_error', `The server refused the request: ${String(res.message.error.message ?? code).slice(0, 160)}`);
        }
      } else if (res.message?.error && res.status < 400) {
        throw new McpClientError('remote_error', `The server returned an error: ${String(res.message.error.message ?? 'unknown').slice(0, 160)}`);
      } else {
        // A 4xx answer that holds no modern error is a legacy server.
        await legacyHandshake(LEGACY_VERSION);
        state.handshook = true;
      }
    }
    const id = state.nextId++;
    const res = await post(env, target.url, target.token, legacyHeaders(), { jsonrpc: '2.0', id, method, params }, id);
    if (res.status === 401 || res.status === 403) throw new McpClientError('remote_auth', `The server answered ${res.status}. Check the bearer token.`, 401);
    if (res.message?.error) throw new McpClientError('remote_error', `The server returned an error: ${String(res.message.error.message ?? 'unknown').slice(0, 160)}`);
    if (res.message?.result === undefined) throw new McpClientError('bad_answer', `The server answered ${res.status} with no JSON-RPC result.`);
    return res.message.result;
  }

  return { call, state };
}

function targetOf(connection, secrets) {
  const url = connection.config?.url;
  if (!url) throw new McpClientError('no_endpoint', 'The connection has no MCP endpoint.', 400);
  return { url, token: secrets?.token || undefined };
}

const clip = (value, n) => (typeof value === 'string' && value.length > n ? `${value.slice(0, n - 3)}...` : value);

/** Read the tool list (up to 5 pages). */
export async function listRemoteTools(env, connection, secrets) {
  const session = openSession(env, connection, targetOf(connection, secrets));
  const tools = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await session.call('tools/list', cursor ? { cursor } : {});
    for (const t of result.tools ?? []) if (t && typeof t.name === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(t.name) && tools.length < MAX_TOOLS) tools.push({ name: t.name, description: clip(String(t.description ?? ''), 300), inputSchema: t.inputSchema ?? null });
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return { tools, era: session.state.era, version: session.state.version };
}

/** Test the connection. */
export async function testRemote(env, connection, secrets) {
  const started = Date.now();
  const { tools, era, version } = await listRemoteTools(env, connection, secrets);
  return { ok: true, status: 200, ms: Date.now() - started, data: { era, version, tools: tools.length } };
}

/** Read the tool list and keep it. A new tool starts with the risk write. A tool that left is removed. */
export async function refreshRemoteTools(env, connection, secrets) {
  const { tools, era, version } = await listRemoteTools(env, connection, secrets);
  const { results } = await env.DB.prepare('SELECT name, risk FROM mcp_remote_tools WHERE connection_id = ?').bind(connection.id).all();
  const known = new Map((results ?? []).map((r) => [r.name, r.risk]));
  const now = nowIso();
  const statements = [];
  for (const t of tools) {
    const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : null;
    statements.push(
      env.DB.prepare(
        `INSERT INTO mcp_remote_tools (connection_id, name, description, input_schema, risk, fetched_at) VALUES (?, ?, ?, ?, 'write', ?)
         ON CONFLICT(connection_id, name) DO UPDATE SET description = excluded.description, input_schema = excluded.input_schema, fetched_at = excluded.fetched_at`,
      ).bind(connection.id, t.name, t.description, schema && schema.length <= 8000 ? schema : null, now),
    );
  }
  for (const name of known.keys()) if (!tools.some((t) => t.name === name)) statements.push(env.DB.prepare('DELETE FROM mcp_remote_tools WHERE connection_id = ? AND name = ?').bind(connection.id, name));
  if (statements.length > 0) await env.DB.batch(statements);
  return { era, version, tools: tools.map((t) => ({ name: t.name, description: t.description, risk: known.get(t.name) ?? 'write' })) };
}

export async function listCachedTools(env, connectionId) {
  const { results } = await env.DB.prepare('SELECT name, description, input_schema, risk, fetched_at FROM mcp_remote_tools WHERE connection_id = ? ORDER BY name').bind(connectionId).all();
  return (results ?? []).map((r) => ({ name: r.name, description: r.description ?? '', inputSchema: r.input_schema ? JSON.parse(r.input_schema) : null, risk: r.risk, fetchedAt: r.fetched_at }));
}

export async function toolRisk(env, connectionId, name) {
  const row = await env.DB.prepare('SELECT risk FROM mcp_remote_tools WHERE connection_id = ? AND name = ?').bind(connectionId, name).first();
  return row ? row.risk : null;
}

export async function setToolRisk(env, connectionId, name, risk) {
  if (!['read', 'write', 'destructive'].includes(risk)) throw new McpClientError('bad_risk', 'The risk must be read, write, or destructive.', 400);
  const res = await env.DB.prepare('UPDATE mcp_remote_tools SET risk = ? WHERE connection_id = ? AND name = ?').bind(risk, connectionId, name).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Call one tool. The tool must be in the cached list. @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string }>} */
export async function callRemoteTool(env, connection, secrets, name, args) {
  const session = openSession(env, connection, targetOf(connection, secrets));
  const result = await session.call('tools/call', { name, arguments: args ?? {} });
  const text = (result.content ?? [])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  const otherParts = (result.content ?? []).filter((c) => c && c.type !== 'text').length;
  const data = { untrusted: true, text: clip(text, MAX_TEXT), ...(otherParts > 0 ? { otherParts } : {}), ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) };
  if (result.isError) return { ok: false, status: 200, error: `The tool reported an error: ${clip(text, 160)}`, data };
  return { ok: true, status: 200, data };
}
