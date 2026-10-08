/**
 * @file TITAN as an MCP server (Wave 12, M1 and M2): `POST /mcp`, Streamable HTTP, stateless, JSON answers.
 *
 * The server is "dual-era", in the words of the 2026-07-28 specification:
 *   - A request with `params._meta["io.modelcontextprotocol/protocolVersion"]` is modern (2026-07-28). The headers
 *     `MCP-Protocol-Version` and `Mcp-Method` must repeat the body (and `Mcp-Name` for `tools/call`), or the answer is
 *     `400` with the error `-32020`. A version that the server does not know gets `400` with `-32022` and a `supported` list.
 *   - `initialize` selects the legacy form (2025-03-26 to 2025-11-25). The server keeps no session, so the answer holds no
 *     `Mcp-Session-Id`, and every later request stands alone.
 * `GET /mcp` answers 405. A request without a valid token answers 401.
 *
 * Tools: titan_status, titan_list_tasks, titan_get_task, titan_queue_task, titan_keys_status, titan_connectors,
 * titan_connector_call, titan_notify, titan_lessons. Each tool needs one scope. The scopes are in `MCP_SCOPES`.
 */
import { checkLockout, recordAuthFailure } from './lib/auth.js';
import { getSettings } from './lib/db.js';
import { validate } from './lib/jsonschema.js';
import { json, jsonError, nowIso, randomBytes, sha256Hex, toBase64Url } from './lib/util.js';
import { BrokerError, invokeAction, listApprovals, listCatalog } from './connectors/broker.js';
import { actionOf, manifestById } from './connectors/core.js';
import { listConnections } from './connectors/store.js';
import { handleListKeys } from './keys.js';
import { handleSystemMemory } from './legacy.js';
import { emitEvent } from './notify.js';
import { queueTask } from './tasks.js';

export const MCP_MODERN_VERSION = '2026-07-28';
export const MCP_SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
export const MCP_SCOPES = Object.freeze(['status:read', 'tasks:write', 'connectors:read', 'connectors:write', 'personal:read', 'notify:write', 'chat:write']);
export const TOKEN_PREFIX = 'titan_mcp_';
const SERVER_INFO = Object.freeze({ name: 'titan-runner-brain', title: 'TITAN', version: '1.0.0' });
const MAX_BODY = 64 * 1024;
const TOUCH_EVERY_MS = 60_000;

// ---------------------------------------------------------------------
// Tokens (M2)
// ---------------------------------------------------------------------

/** Make a token. The token leaves the Worker one time, in this answer. A hash is all that stays. */
export async function createMcpToken(env, { label, scopes, expiresInDays }) {
  const errors = [];
  const name = String(label ?? '').trim().slice(0, 60);
  if (!name) errors.push('A token needs a label.');
  const list = Array.isArray(scopes) ? [...new Set(scopes.map(String))] : [];
  if (list.length === 0) errors.push('Choose at least one scope.');
  for (const s of list) if (!MCP_SCOPES.includes(s)) errors.push(`The scope "${s}" is not known.`);
  if (expiresInDays !== undefined && expiresInDays !== null && !(Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365)) errors.push('The expiry must be 1 to 365 days.');
  if (errors.length > 0) return { errors };
  const token = `${TOKEN_PREFIX}${toBase64Url(randomBytes(32))}`;
  const id = `t_${toBase64Url(randomBytes(6))}`;
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
  await env.DB.prepare('INSERT INTO mcp_tokens (id, label, token_hash, scopes, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, await sha256Hex(token), list.join(' '), 'static', nowIso(), expiresAt)
    .run();
  return { id, token, label: name, scopes: list, expiresAt };
}

const publicToken = (r) => ({
  id: r.id, label: r.label, scopes: String(r.scopes).split(' ').filter(Boolean), kind: r.kind, clientId: r.client_id ?? null,
  createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null, expiresAt: r.expires_at ?? null, revokedAt: r.revoked_at ?? null,
});

export async function listMcpTokens(env) {
  const { results } = await env.DB.prepare('SELECT id, label, scopes, kind, client_id, created_at, last_used_at, expires_at, revoked_at FROM mcp_tokens ORDER BY created_at DESC').all();
  return (results ?? []).map(publicToken);
}

export async function revokeMcpToken(env, id) {
  const res = await env.DB.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(nowIso(), id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** @returns {Promise<{ id: string, scopes: string[] } | null>} */
export async function authenticateMcp(request, env, now = new Date()) {
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT id, scopes, expires_at, revoked_at, last_used_at FROM mcp_tokens WHERE token_hash = ?').bind(await sha256Hex(m[1])).first();
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < nowIso(now))) return null;
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > TOUCH_EVERY_MS) {
    await env.DB.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(now), row.id).run().catch(() => null);
  }
  return { id: row.id, scopes: String(row.scopes).split(' ').filter(Boolean) };
}

// ---------------------------------------------------------------------
// Tools (M1)
// ---------------------------------------------------------------------

const textResult = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}), ...(typeof value === 'object' && !isError ? { structuredContent: value } : {}) });

const TOOLS = [
  {
    name: 'titan_status', scope: 'status:read', title: 'TITAN status',
    description: 'Shows the pulse age, the task counts of the last 24 hours, and the number of approvals that wait.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(env) {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { results } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM subagents WHERE queued_at > ? GROUP BY status').bind(since).all();
      const s = await getSettings(env, ['pulse.lastHeartbeatAt', 'pulse.lastKeeperError']);
      const hb = s['pulse.lastHeartbeatAt'];
      const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first();
      return { pulseAgeMinutes: hb ? Math.round((Date.now() - Date.parse(hb)) / 60_000) : null, keeperError: s['pulse.lastKeeperError'] || null, tasksLast24h: Object.fromEntries((results ?? []).map((r) => [r.status, r.n])), approvalsWaiting: waiting?.n ?? 0 };
    },
  },
  {
    name: 'titan_list_tasks', scope: 'status:read', title: 'List tasks',
    description: 'Lists the newest tasks. The brief is cut to 200 characters.',
    inputSchema: { type: 'object', properties: { status: { enum: ['queued', 'dispatched', 'running', 'done', 'failed'] }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, additionalProperties: false },
    async run(env, args) {
      const limit = args.limit ?? 10;
      const stmt = args.status
        ? env.DB.prepare('SELECT id, task_type, brief, status, source, queued_at, finished_at FROM subagents WHERE status = ? ORDER BY queued_at DESC LIMIT ?').bind(args.status, limit)
        : env.DB.prepare('SELECT id, task_type, brief, status, source, queued_at, finished_at FROM subagents ORDER BY queued_at DESC LIMIT ?').bind(limit);
      const { results } = await stmt.all();
      return { tasks: (results ?? []).map((r) => ({ ...r, brief: String(r.brief).slice(0, 200) })) };
    },
  },
  {
    name: 'titan_get_task', scope: 'status:read', title: 'Get a task',
    description: 'Shows one task with its result summary and run link.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 8, maxLength: 64 } }, required: ['id'], additionalProperties: false },
    async run(env, args) {
      const row = await env.DB.prepare('SELECT id, task_type, brief, status, source, provider, queued_at, started_at, finished_at, result_summary, run_url, retry_count FROM subagents WHERE id = ? OR id LIKE ? LIMIT 1').bind(args.id, `${args.id}%`).first();
      return row ?? { error: 'not_found' };
    },
  },
  {
    name: 'titan_queue_task', scope: 'tasks:write', title: 'Queue a task',
    description: 'Queues a sub-agent task. The Worker hands it to a GitHub Actions runner within a minute.',
    inputSchema: { type: 'object', properties: { brief: { type: 'string', minLength: 1, maxLength: 4000 }, task_type: { type: 'string', maxLength: 40, pattern: '^[a-z0-9][a-z0-9_-]*$' } }, required: ['brief'], additionalProperties: false },
    async run(env, args, auth) {
      const { parseTaskType } = await import('./tasks.js');
      const type = parseTaskType(args.task_type);
      if ('error' in type) return { error: type.error };
      return { queued: await queueTask(env, { brief: args.brief, taskType: type.value, source: `mcp:${auth.id}` }) };
    },
  },
  {
    name: 'titan_keys_status', scope: 'status:read', title: 'Key states',
    description: 'Shows the state of each provider key. It never shows a key.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(env) {
      const body = await (await handleListKeys({ env, requestId: 'mcp' })).json();
      return { providers: (body.providers ?? []).map((p) => ({ id: p.id, name: p.name, state: p.state, reason: p.stateReason })) };
    },
  },
  {
    name: 'titan_connectors', scope: 'connectors:read', title: 'List connectors',
    description: 'Lists the connections and the actions that each one offers, with risk and data class. Pending approvals are included.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(env) {
      const catalog = await listCatalog(env);
      const approvals = await listApprovals(env, { status: 'pending' });
      return {
        connections: catalog.connectors.flatMap((c) => c.connections.map((conn) => ({ connectionId: conn.id, connector: c.id, label: conn.label, status: conn.status, actions: c.actions.map((a) => ({ id: a.id, title: a.title, risk: a.risk, dataClass: a.dataClass, mode: conn.policies[a.id] })) }))),
        approvalsWaiting: approvals.map((a) => ({ id: a.id, summary: a.summary, risk: a.risk })),
      };
    },
  },
  {
    name: 'titan_connector_call', scope: 'connectors:read', title: 'Call a connector action',
    description: 'Runs one action of a connection. A read action runs at once when the token has connectors:read. A write action needs connectors:write, and it waits for approval unless a person set it to auto. A destructive action is never available here.',
    inputSchema: { type: 'object', properties: { connection: { type: 'string', maxLength: 64, description: 'A connection id, or a connector id such as github.' }, action: { type: 'string', maxLength: 41 }, input: { type: 'object', additionalProperties: true } }, required: ['connection', 'action'], additionalProperties: false },
    async run(env, args, auth, ctx) {
      const all = await listConnections(env);
      const connection = all.find((c) => c.id === args.connection) ?? all.find((c) => c.connectorId === args.connection && c.status !== 'needs_reconnect');
      if (!connection) return { error: 'not_found', message: 'No connection matches. Use titan_connectors to see them.' };
      const manifest = manifestById(connection.connectorId);
      if (!actionOf(manifest, args.action)) return { error: 'unknown_action' };
      try {
        const r = await invokeAction(env, { connectionId: connection.id, actionId: args.action, input: args.input ?? {}, caller: { kind: 'mcp', id: auth.id, scopes: auth.scopes }, origin: ctx.origin });
        return r.state === 'pending_approval' ? { pending_approval: true, approvalId: r.approvalId, message: 'A person must approve this call in the dashboard or in Telegram.' } : r;
      } catch (err) {
        if (err instanceof BrokerError) return { error: err.code, message: err.message };
        throw err;
      }
    },
  },
  {
    name: 'titan_notify', scope: 'notify:write', title: 'Send a notification',
    description: 'Sends a short message to every notification channel that a person connected. Use it for results that a person should see.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', maxLength: 500 }, severity: { enum: ['info', 'warn', 'error'], default: 'info' } }, required: ['title'], additionalProperties: false },
    async run(env, args, auth) {
      const r = await emitEvent(env, { type: 'notify.custom', severity: args.severity ?? 'info', title: args.title, body: args.body, source: `mcp:${auth.id}` });
      return { queued: r.recorded };
    },
  },
  {
    name: 'titan_lessons', scope: 'status:read', title: 'Lessons',
    description: 'Reads the active lessons of the system memory. It is read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(env) {
      const { lessons } = await (await handleSystemMemory(env)).json();
      return { lessons: (lessons ?? []).map((l) => ({ id: l.id, category: l.category, lesson: String(l.lesson).slice(0, 400), createdAt: l.created_at })) };
    },
  },
];

/** A token may use a tool when it holds the scope of the tool. A write scope also opens titan_connector_call. */
const mayUse = (auth, tool) => auth.scopes.includes(tool.scope) || (tool.name === 'titan_connector_call' && auth.scopes.includes('connectors:write'));

export const TOOL_NAMES = TOOLS.map((t) => t.name);

const toolList = () => TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));

// ---------------------------------------------------------------------
// JSON-RPC over HTTP
// ---------------------------------------------------------------------

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const reply = (body, status = 200, headers = {}) => json(body, status, headers);

/** GET /mcp: this server has no stream to offer. */
export function handleMcpGet() {
  return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'Use POST for MCP requests.' }), { status: 405, headers: { 'content-type': 'application/json', Allow: 'POST' } });
}

/** @param {{ request: Request, env: any, requestId: string }} c */
export async function handleMcp(c) {
  const { request, env } = c;
  const lock = await checkLockout(request, env, 'mcp');
  if (lock.locked) return jsonError(429, 'locked_out', 'Too many wrong tokens. Try again later.', { retryAfterSeconds: lock.retryAfterSeconds });
  const auth = await authenticateMcp(request, env);
  if (!auth) {
    if (request.headers.get('authorization')) await recordAuthFailure(request, env, 'mcp').catch(() => null);
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json', 'WWW-Authenticate': 'Bearer realm="TITAN MCP"' } });
  }

  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (declared > MAX_BODY) return reply(rpcError(null, -32600, 'The request is too large.'), 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(rpcError(null, -32600, 'The request is too large.'), 413);
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return reply(rpcError(null, -32700, 'The body is not valid JSON.'), 400);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return reply(rpcError(msg?.id, -32600, 'The body must be one JSON-RPC request.'), 400);

  const isNotification = !('id' in msg);
  if (isNotification) return new Response(null, { status: 202 });

  const meta = msg.params?._meta ?? {};
  const modernVersion = meta['io.modelcontextprotocol/protocolVersion'];
  const header = request.headers.get('mcp-protocol-version');
  const ctx = { origin: env.WORKER_URL || new URL(request.url).origin };

  if (msg.method === 'initialize') return reply(rpcResult(msg.id, initializeResult(msg.params?.protocolVersion)));

  if (modernVersion !== undefined) {
    if (!MCP_SUPPORTED_VERSIONS.includes(modernVersion) || modernVersion !== MCP_MODERN_VERSION) {
      return reply(rpcError(msg.id, -32022, 'Unsupported protocol version', { supported: [...MCP_SUPPORTED_VERSIONS], requested: String(modernVersion) }), 400);
    }
    if (header !== modernVersion) return reply(rpcError(msg.id, -32020, `Header mismatch: MCP-Protocol-Version is "${header ?? ''}" and the body says "${modernVersion}".`), 400);
    if (request.headers.get('mcp-method') !== msg.method) return reply(rpcError(msg.id, -32020, `Header mismatch: Mcp-Method does not match the method "${msg.method}".`), 400);
    if (msg.method === 'tools/call' && request.headers.get('mcp-name') !== String(msg.params?.name ?? '')) return reply(rpcError(msg.id, -32020, 'Header mismatch: Mcp-Name does not match the tool name.'), 400);
  } else if (header && !MCP_SUPPORTED_VERSIONS.includes(header)) {
    return reply(rpcError(msg.id, -32022, 'Unsupported protocol version', { supported: [...MCP_SUPPORTED_VERSIONS], requested: header }), 400);
  }
  const modern = modernVersion !== undefined;
  const complete = (result) => (modern ? { resultType: 'complete', ...result } : result);

  switch (msg.method) {
    case 'ping':
      return reply(rpcResult(msg.id, {}));
    case 'server/discover':
      if (!modern) return reply(rpcError(msg.id, -32601, 'Method not found'), 404);
      return reply(rpcResult(msg.id, complete({ supportedVersions: [MCP_MODERN_VERSION], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }, instructions: 'TITAN runs sub-agent tasks and connector actions. Use titan_status first.', ttlMs: 3_600_000, cacheScope: 'public' })));
    case 'tools/list': {
      const visible = toolList().filter((t) => mayUse(auth, TOOLS.find((x) => x.name === t.name)));
      return reply(rpcResult(msg.id, complete({ tools: visible })));
    }
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return reply(rpcError(msg.id, -32602, `The tool "${msg.params?.name}" does not exist.`));
      if (!mayUse(auth, tool)) {
        return reply(rpcResult(msg.id, complete(textResult({ error: 'scope_missing', message: `This token lacks the scope ${tool.scope}.` }, true))));
      }
      const args = msg.params?.arguments ?? {};
      const problems = validate(tool.inputSchema, args);
      if (problems.length > 0) return reply(rpcResult(msg.id, complete(textResult({ error: 'invalid_arguments', problems: problems.slice(0, 5) }, true))));
      try {
        const out = await tool.run(env, args, auth, ctx);
        return reply(rpcResult(msg.id, complete(textResult(out, Boolean(out?.error)))));
      } catch (err) {
        console.error('titan-runner-brain: mcp tool failed:', tool.name, err instanceof Error ? err.message : err);
        return reply(rpcResult(msg.id, complete(textResult({ error: 'tool_failed', message: 'The tool failed. Quote the request id.', requestId: c.requestId }, true))));
      }
    }
    default:
      return reply(rpcError(msg.id, -32601, 'Method not found'), modern ? 404 : 200);
  }
}

function initializeResult(requested) {
  const legacy = MCP_SUPPORTED_VERSIONS.filter((v) => v !== MCP_MODERN_VERSION);
  const version = legacy.includes(requested) ? requested : legacy[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: 'TITAN runs sub-agent tasks and connector actions. Use titan_status first.',
  };
}
