/**
 * @file HTTP handlers of the connector hub (Wave 12, C3, C4, C8, M2, C7). The route table in routes.js names them.
 */
import { jsonError, json, readJson } from '../lib/util.js';
import { MCP_SCOPES, createMcpToken, listMcpTokens, revokeMcpToken } from '../mcpServer.js';
import { emitEvent, EVENT_TYPES } from '../notify.js';
import {
  BrokerError, beginConnectionOAuth, callLog, connect, decideApproval, defaultMode, disconnect, invokeAction, listApprovals, listCatalog, publicConnection, renameConnection, setActionMode, testConnection,
} from './broker.js';
import { actionOf, manifestById, publicManifest } from './core.js';
import { hookInfo, rotateHookSecret } from './hooks.js';
import { McpClientError, listCachedTools, setToolRisk } from './mcpClient.js';
import { OAuthError, finishOAuth } from './oauth.js';
import { applyPreset, deleteRule, listRules, routeEvents, saveRule, sendTest } from './notifyRouter.js';
import { getConnection, listConnections, listPolicies, recentCalls } from './store.js';
import { createPairCode, unpair } from './telegram.js';

const originOf = (c) => c.env.WORKER_URL || new URL(c.request.url).origin;

/** Turn a BrokerError into the standard error answer. */
export const guard = (fn) => async (c) => {
  try {
    return await fn(c);
  } catch (err) {
    if (err instanceof BrokerError) {
      const res = jsonError(err.status, err.code, err.message, { ...err.extra, requestId: c.requestId });
      if (err.extra?.retryAfterSeconds) res.headers.set('Retry-After', String(err.extra.retryAfterSeconds));
      return res;
    }
    if (err instanceof McpClientError) return jsonError(err.status, err.code, err.message, { requestId: c.requestId });
    throw err;
  }
};

async function body(c, max = 16_384) {
  const parsed = await readJson(c.request, max);
  return parsed.ok ? { value: parsed.value } : { response: parsed.response };
}

// ---------------------------------------------------------------------
// Admin: the catalog and the connections
// ---------------------------------------------------------------------

export const handleCatalog = guard(async (c) => json({ ...(await listCatalog(c.env)), requestId: c.requestId }));

export const handleConnect = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  const result = await connect(c.env, { connectorId: c.params.id, label: b.value.label, fields: b.value.fields ?? {}, saveIfUnverified: b.value.saveIfUnverified === true, origin: originOf(c) });
  return json({ ...result, requestId: c.requestId }, 201);
});

export const handleConnectionDetail = guard(async (c) => {
  const connection = await getConnection(c.env, c.params.cid);
  if (!connection) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  const manifest = manifestById(connection.connectorId);
  return json({
    connection: publicConnection(connection, manifest, await listPolicies(c.env, connection.id)),
    connector: publicManifest(manifest),
    calls: await recentCalls(c.env, connection.id, 20),
    ...(connection.connectorId === 'webhook_in' ? { hook: await hookInfo(c.env, connection, originOf(c)) } : {}),
    ...(connection.connectorId === 'mcp_remote' ? { tools: await listCachedTools(c.env, connection.id) } : {}),
    ...(connection.connectorId === 'google_calendar' || connection.connectorId === 'gmail' ? { redirectUri: `${originOf(c)}/oauth/${connection.connectorId}/callback` } : {}),
    requestId: c.requestId,
  });
});

export const handleTestConnection = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  return json({ ...(await testConnection(c.env, c.params.cid, { send: b.value.send === true })), requestId: c.requestId });
});

export const handleRename = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  return json({ connection: await renameConnection(c.env, c.params.cid, b.value.label), requestId: c.requestId });
});

export const handleDisconnect = guard(async (c) => json({ ...(await disconnect(c.env, c.params.cid)), requestId: c.requestId }));

export const handleSetPolicy = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  return json({ ...(await setActionMode(c.env, c.params.cid, String(b.value.actionId ?? ''), String(b.value.mode ?? ''))), requestId: c.requestId });
});

export const handleCalls = guard(async (c) => json({ ...(await callLog(c.env, c.params.cid, new URL(c.request.url).searchParams.get('limit') ?? 50)), requestId: c.requestId }));

/** POST /connections/:cid/actions/:actionId (admin) */
export const handleRunAction = guard(async (c) => {
  const b = await body(c, 65_536);
  if (b.response) return b.response;
  const result = await invokeAction(c.env, { connectionId: c.params.cid, actionId: c.params.actionId, input: b.value.input ?? {}, caller: { kind: 'admin' }, confirm: b.value.confirm, origin: originOf(c) });
  return json({ ...result, requestId: c.requestId }, result.state === 'pending_approval' ? 202 : 200);
});

// ---------------------------------------------------------------------
// Admin: pairing, hook secret, remote tools
// ---------------------------------------------------------------------

export const handleTelegramPair = guard(async (c) => {
  const pair = await createPairCode(c.env, c.params.cid);
  if (!pair) throw new BrokerError(404, 'not_found', 'This is not a Telegram connection.');
  return json({ ...pair, instruction: `Send "/pair ${pair.code}" to your bot${pair.botUsername ? ` @${pair.botUsername}` : ''} within ${pair.minutes} minutes.`, requestId: c.requestId });
});

export const handleTelegramUnpair = guard(async (c) => {
  if (!(await unpair(c.env, c.params.cid))) throw new BrokerError(404, 'not_found', 'This is not a Telegram connection.');
  return json({ ok: true, requestId: c.requestId });
});

export const handleHookRotate = guard(async (c) => {
  const out = await rotateHookSecret(c.env, c.params.cid);
  if (!out) throw new BrokerError(404, 'not_found', 'This connection has no hook.');
  return json({ ...out, requestId: c.requestId });
});

export const handleToolRisk = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  const connection = await getConnection(c.env, c.params.cid);
  if (!connection || connection.connectorId !== 'mcp_remote') throw new BrokerError(404, 'not_found', 'This is not a remote MCP connection.');
  const ok = await setToolRisk(c.env, connection.id, c.params.name, String(b.value.risk ?? ''));
  if (!ok) throw new BrokerError(404, 'unknown_tool', 'This tool is not in the list. Refresh the tool list first.');
  return json({ ok: true, name: c.params.name, risk: b.value.risk, requestId: c.requestId });
});

// ---------------------------------------------------------------------
// OAuth (C8)
// ---------------------------------------------------------------------

export const handleOAuthBegin = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  const connection = await getConnection(c.env, String(b.value.connectionId ?? ''));
  if (!connection || connection.connectorId !== c.params.connectorId) throw new BrokerError(404, 'not_found', 'This connection does not exist for this connector.');
  return json({ ...(await beginConnectionOAuth(c.env, connection.id, originOf(c))), requestId: c.requestId });
});

/** GET /oauth/:connectorId/callback (group oauth). It redirects to the dashboard. The address holds no token. */
export async function handleOAuthCallback(c) {
  const dash = String(c.env.DASHBOARD_URL || 'https://shreyas-tech7.github.io/TITAN-Runner').replace(/\/+$/, '');
  const q = new URL(c.request.url).searchParams;
  const go = (params) => new Response(null, { status: 302, headers: { Location: `${dash}/connectors/?${new URLSearchParams(params).toString()}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  if (q.get('error')) {
    // The provider refused or the person said no. Delete the state so that it cannot be used.
    const state = q.get('state');
    if (state) await c.env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run().catch(() => null);
    return go({ oauth_error: 'access_denied' });
  }
  try {
    const done = await finishOAuth(c.env, { state: q.get('state'), code: q.get('code'), origin: originOf(c) });
    return go({ connected: done.connectorId });
  } catch (err) {
    if (err instanceof OAuthError) return go({ oauth_error: err.code });
    console.error('titan-runner-brain: oauth callback failed:', err instanceof Error ? err.message : err);
    return go({ oauth_error: 'failed' });
  }
}

// ---------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------

export const handleApprovals = guard(async (c) => {
  const status = new URL(c.request.url).searchParams.get('status') || undefined;
  return json({ approvals: await listApprovals(c.env, { status }), requestId: c.requestId });
});

export const handleDecide = (decision) =>
  guard(async (c) => json({ ...(await decideApproval(c.env, c.params.id, decision, 'dashboard', originOf(c))), requestId: c.requestId }));

// ---------------------------------------------------------------------
// MCP tokens (M2)
// ---------------------------------------------------------------------

export const handleMcpTokens = guard(async (c) => json({ tokens: await listMcpTokens(c.env), scopes: MCP_SCOPES, requestId: c.requestId }));

export const handleMcpTokenCreate = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  const out = await createMcpToken(c.env, { label: b.value.label, scopes: b.value.scopes, expiresInDays: b.value.expiresInDays });
  if (out.errors) return jsonError(422, 'invalid_fields', out.errors[0], { errors: out.errors, requestId: c.requestId });
  return json({ ...out, shownOnce: true, requestId: c.requestId }, 201);
});

export const handleMcpTokenRevoke = guard(async (c) => {
  const ok = await revokeMcpToken(c.env, c.params.id);
  return ok ? json({ ok: true, requestId: c.requestId }) : jsonError(404, 'not_found', 'This token does not exist or is already revoked.');
});

// ---------------------------------------------------------------------
// Notification rules (C7)
// ---------------------------------------------------------------------

export const handleRules = guard(async (c) => json({ rules: await listRules(c.env), eventTypes: EVENT_TYPES, requestId: c.requestId }));

export const handleRuleSave = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  const out = await saveRule(c.env, b.value);
  if (out.errors) return jsonError(422, 'invalid_fields', out.errors[0], { errors: out.errors, requestId: c.requestId });
  return json({ rule: out.rule, requestId: c.requestId }, 201);
});

export const handleRuleDelete = guard(async (c) => ((await deleteRule(c.env, c.params.id)) ? json({ ok: true, requestId: c.requestId }) : jsonError(404, 'not_found', 'This rule does not exist.')));

export const handleRulePreset = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  const out = await applyPreset(c.env, String(b.value.connectionId ?? ''));
  if (out.errors) return jsonError(422, 'invalid_fields', out.errors[0], { errors: out.errors, requestId: c.requestId });
  return json({ made: out.made, requestId: c.requestId }, 201);
});

export const handleNotifyTest = guard(async (c) => {
  const b = await body(c);
  if (b.response) return b.response;
  const res = await sendTest(c.env, String(b.value.connectionId ?? ''), originOf(c));
  return json({ ...res, requestId: c.requestId }, res.ok ? 200 : 502);
});

export const handleEvents = guard(async (c) => {
  const n = Math.min(Math.max(Number.parseInt(new URL(c.request.url).searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
  const { results } = await c.env.DB.prepare('SELECT id, at, type, severity, title, body, source FROM events ORDER BY id DESC LIMIT ?').bind(n).all();
  return json({ events: results ?? [], requestId: c.requestId });
});

// ---------------------------------------------------------------------
// Internal (the callback token): sub-agents and the pulse
// ---------------------------------------------------------------------

/** POST /internal/event: the pulse sends an event, and the router picks it up. */
export async function handleInternalEvent(c) {
  const b = await body(c, 4096);
  if (b.response) return b.response;
  const v = b.value;
  if (!EVENT_TYPES.includes(v.type) || v.type === 'hook.received' || v.type === 'notify.custom') return jsonError(422, 'invalid_fields', `The type must be one of: ${EVENT_TYPES.filter((t) => t !== 'hook.received' && t !== 'notify.custom').join(', ')}.`);
  if (typeof v.title !== 'string' || !v.title.trim()) return jsonError(422, 'invalid_fields', 'A title is needed.');
  const severity = ['info', 'warn', 'error'].includes(v.severity) ? v.severity : 'info';
  const res = await emitEvent(c.env, { type: v.type, severity, title: v.title.slice(0, 200), body: typeof v.body === 'string' ? v.body.slice(0, 500) : undefined, source: 'pulse', dedupeKey: typeof v.dedupeKey === 'string' ? v.dedupeKey.slice(0, 80) : undefined });
  if (res.recorded && c.ctx?.waitUntil) c.ctx.waitUntil(routeEvents(c.env, new Date(), originOf(c)).catch(() => null));
  return json({ ok: true, recorded: res.recorded, requestId: c.requestId }, 202);
}

/** GET /internal/connectors: what a sub-agent may call. Personal actions are not listed. */
export async function handleInternalConnectors(c) {
  const out = [];
  for (const conn of await listConnections(c.env)) {
    const manifest = manifestById(conn.connectorId);
    if (!manifest || ['needs_reconnect', 'needs_authorization'].includes(conn.status)) continue;
    const policies = await listPolicies(c.env, conn.id);
    const actions = manifest.actions.filter((a) => a.dataClass !== 'personal' && (policies[a.id] ?? defaultMode(a)) !== 'deny').map((a) => ({ id: a.id, title: a.title, risk: a.risk, dataClass: a.dataClass, input: a.input }));
    if (actions.length > 0) out.push({ connectionId: conn.id, connector: conn.connectorId, label: conn.label, actions });
  }
  return json({ connections: out, requestId: c.requestId });
}

/** POST /internal/connector-call: a sub-agent calls an action. Read and not personal runs. A write waits for approval. */
export const handleInternalCall = guard(async (c) => {
  const b = await body(c, 65_536);
  if (b.response) return b.response;
  const v = b.value;
  let connection = v.connectionId ? await getConnection(c.env, String(v.connectionId)) : null;
  if (!connection && v.connector) connection = (await listConnections(c.env, String(v.connector))).find((x) => !['needs_reconnect', 'needs_authorization'].includes(x.status)) ?? null;
  if (!connection) throw new BrokerError(404, 'not_found', 'No connection matches. Ask a person to connect the tool first.');
  const manifest = manifestById(connection.connectorId);
  if (!actionOf(manifest, String(v.action ?? ''))) throw new BrokerError(404, 'unknown_action', 'This action does not exist.');
  const result = await invokeAction(c.env, { connectionId: connection.id, actionId: String(v.action), input: v.input ?? {}, caller: { kind: 'internal', id: typeof v.taskId === 'string' ? v.taskId.slice(0, 40) : undefined }, origin: originOf(c) });
  return json({ ...result, requestId: c.requestId }, result.state === 'pending_approval' ? 202 : 200);
});
