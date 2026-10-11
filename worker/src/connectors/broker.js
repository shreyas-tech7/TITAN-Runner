/**
 * @file The connector broker (Wave 12, C3). It connects, tests, and runs actions, and it keeps the approvals queue.
 *
 * An action call goes through these steps, in this order:
 *   1 find the connection and the action, and check the input against the JSON Schema;
 *   2 apply the risk rules and the data rules for the caller;
 *   3 apply the rate limit;
 *   4 build the request from the template (the pure core);
 *   5 call it through safeFetch;
 *   6 keep only the `pick` fields, limit the size, and redact;
 *   7 write metadata to `connector_calls`. A payload is never logged.
 *
 * Callers: `admin` and `owner` (the paired Telegram chat) are people. `mcp` is a tool with a token and scopes. `internal`
 * is a sub-agent with the callback token. `approval` is a call that a person approved.
 */
import { SafeFetchError, checkUrl, safeFetch } from '../lib/safeFetch.js';
import { hmacHex } from '../lib/hmac.js';
import { addMinutes, nowIso, randomHex } from '../lib/util.js';
import { VAULT_FIX, vaultReady } from '../lib/vault.js';
import { emitEvent } from '../notify.js';
import { CONNECTORS } from '../connectors.generated.js';
import {
  ActionInputError, actionOf, allowedHosts, buildActionRequest, buildTestRequest, checkSecretUrl, manifestById, publicManifest, shapeResponse, shapeTestResponse, validateConnectFields,
} from './core.js';
import { isImpureHandler } from './handlers.js';
import { scrubValue } from './shape.js';
import { createHook, hookInfo } from './hooks.js';
import { callRemoteTool, listCachedTools, McpClientError, refreshRemoteTools, testRemote, toolRisk } from './mcpClient.js';
import { OAuthError, beginOAuth, ensureAccessToken } from './oauth.js';
import {
  deleteConnectionRows, getConnection, insertConnection, listConnections, listPolicies, loadSecrets, logCall, newConnectionId, recentCalls, saveSecrets, setPolicy, takeRate, updateConnection,
} from './store.js';
import { notifyApprovalViaTelegram, telegramAfterConnect, telegramBeforeDisconnect } from './telegram.js';
import { TemplateError } from '../lib/template.js';

export class BrokerError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, any>} [extra] */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'BrokerError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const MAX_PENDING_APPROVALS = 20;
export const APPROVAL_HOURS = 24;
const SAFE_META = ['expiresAt', 'scope', 'authorizedAt', 'mcpEra', 'mcpVersion', 'hookId', 'botName', 'botUsername'];

const callerLabel = (caller) => (caller.id ? `${caller.kind}:${caller.id}` : caller.kind);

// ---------------------------------------------------------------------
// Catalog and public shapes
// ---------------------------------------------------------------------

export function publicConnection(conn, manifest, policies = {}) {
  return {
    id: conn.id,
    connectorId: conn.connectorId,
    label: conn.label,
    status: conn.status,
    lastTestAt: conn.lastTestAt,
    lastTestOk: conn.lastTestOk,
    lastTestMs: conn.lastTestMs,
    lastError: conn.lastError,
    createdAt: conn.createdAt,
    config: conn.config,
    secretNames: conn.secretNames,
    meta: Object.fromEntries(Object.entries(conn.meta ?? {}).filter(([k]) => SAFE_META.includes(k))),
    ownerPaired: Boolean(conn.config?.chat_id),
    policies: Object.fromEntries((manifest?.actions ?? []).map((a) => [a.id, policies[a.id] ?? defaultMode(a)])),
  };
}

export const defaultMode = (action) => (action.risk === 'read' ? 'auto' : 'ask');

/** GET /connectors */
export async function listCatalog(env) {
  const all = await listConnections(env);
  const policyRows = await env.DB.prepare('SELECT connection_id, action_id, mode FROM connector_policies').all();
  const byConn = {};
  for (const r of policyRows.results ?? []) (byConn[r.connection_id] ??= {})[r.action_id] = r.mode;
  return {
    vault: { ready: vaultReady(env), fix: vaultReady(env) ? null : VAULT_FIX },
    connectors: CONNECTORS.map((m) => ({
      ...publicManifest(m),
      connections: all.filter((c) => c.connectorId === m.id).map((c) => publicConnection(c, m, byConn[c.id] ?? {})),
    })),
  };
}

// ---------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------

/** One outbound call through safeFetch. @returns {Promise<{ status: number, text: string, contentType: string }>} */
export async function sendRequest(env, manifest, connection, secrets, req, { timeoutMs = 8000 } = {}) {
  const { hosts, dynamic } = allowedHosts(manifest, connection.config, secrets);
  const host = new URL(req.url).hostname.toLowerCase();
  const res = await safeFetch(env, req.url, { method: req.method, headers: req.headers, body: req.body }, { allow: hosts, timeoutMs, maxBytes: 1_000_000, checkDns: dynamic.includes(host) });
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

async function signIfNeeded(manifest, secrets, req) {
  const field = manifest.auth.signingField;
  if (!field || !secrets[field] || req.body === undefined) return req;
  const t = Math.floor(Date.now() / 1000);
  return { ...req, headers: { ...req.headers, 'X-Titan-Signature': `t=${t},v1=${await hmacHex(secrets[field], `${t}.${req.body}`)}` } };
}

/** Wrap errors of the lower layers in one shape. */
function lowerError(err, manifest) {
  if (err instanceof BrokerError) return err;
  if (err instanceof SafeFetchError) return new BrokerError(502, `egress_${err.code}`, err.message);
  if (err instanceof ActionInputError) return new BrokerError(422, 'invalid_input', err.message, { problems: err.problems });
  if (err instanceof OAuthError) return new BrokerError(err.status, err.code, err.message);
  if (err instanceof McpClientError) return new BrokerError(err.status, err.code, err.message);
  if (err instanceof TemplateError) {
    if (manifest?.id === 'telegram' && /chat_id/.test(err.message)) return new BrokerError(409, 'not_paired', 'Pair the owner chat first. Send /pair with the code from the dashboard to your bot.');
    return new BrokerError(400, 'bad_request', err.message);
  }
  if (err?.name === 'HandlerError') return new BrokerError(422, 'invalid_input', err.message);
  if (err?.name === 'VaultNotReadyError') return new BrokerError(503, 'vault_not_ready', err.message, { fix: VAULT_FIX });
  return err;
}

// ---------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------

/** @returns {Promise<{ ok: boolean|null, skipped?: boolean, status?: number, ms: number, data?: any, error?: string, message?: string }>} */
export async function runTest(env, manifest, connection, secretsIn, { send = false } = {}) {
  const t = manifest.test;
  const started = Date.now();
  try {
    if (t.mode === 'none') return { ok: true, skipped: true, ms: 0, message: 'This connector has nothing to test.' };
    let secrets = secretsIn;
    if (isImpureHandler(t.handler)) {
      const r = await testRemote(env, connection, secrets);
      return { ok: true, status: r.status, ms: r.ms, data: r.data };
    }
    if (t.mode === 'onClick' && !send) return { ok: null, skipped: true, ms: 0, message: 'TITAN does not send a message when you connect. Choose "Send test" to check it.' };
    if (manifest.auth.kind === 'oauth2_pkce') secrets = await ensureAccessToken(env, connection, manifest, secrets);
    const req = buildTestRequest(manifest, { config: connection.config, secrets });
    if (!req) return { ok: true, skipped: true, ms: 0 };
    const res = await sendRequest(env, manifest, connection, secrets, req);
    const shaped = shapeTestResponse(manifest, { ...res, input: {} });
    return { ok: shaped.ok, status: res.status, ms: Date.now() - started, data: shaped.ok ? scrubValue(shaped.data) : undefined, error: shaped.ok ? undefined : shaped.error };
  } catch (err) {
    const e = lowerError(err, manifest);
    if (e instanceof BrokerError) return { ok: false, ms: Date.now() - started, error: e.message, code: e.code };
    throw err;
  }
}

/** POST /connections/:cid/test */
export async function testConnection(env, connectionId, { send = false } = {}) {
  const connection = await getConnection(env, connectionId);
  if (!connection) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  const manifest = manifestById(connection.connectorId);
  if (!manifest) throw new BrokerError(404, 'unknown_connector', 'This connector is not in the catalog.');
  const secrets = await loadSecrets(env, connection);
  const result = await runTest(env, manifest, connection, secrets, { send });
  if (result.ok !== null) {
    const patch = { lastTestAt: nowIso(), lastTestOk: result.ok, lastTestMs: result.ms, lastError: result.ok ? null : result.error ?? null };
    if (result.ok && ['unverified', 'error'].includes(connection.status) && !result.skipped) patch.status = 'connected';
    if (!result.ok && connection.status === 'connected') patch.status = 'error';
    await updateConnection(env, connection.id, patch);
  }
  return { connectionId, ...result };
}

// ---------------------------------------------------------------------
// Connect, rename, disconnect
// ---------------------------------------------------------------------

async function uniqueLabel(env, connectorId, wanted) {
  const taken = new Set((await listConnections(env, connectorId)).map((c) => c.label));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 50; n += 1) if (!taken.has(`${wanted} ${n}`)) return `${wanted} ${n}`;
  throw new BrokerError(409, 'label_taken', 'Too many connections have this label.');
}

/** A base address that a person typed must pass the same checks as any outbound address. */
function checkTypedAddress(manifest, config, secrets) {
  const fieldNames = [manifest.auth.baseUrlField, manifest.auth.kind === 'mcp_remote' ? 'url' : null].filter(Boolean);
  for (const name of fieldNames) {
    const value = config[name];
    if (!value) continue;
    const host = (() => {
      try {
        return new URL(value).hostname.toLowerCase();
      } catch {
        return null;
      }
    })();
    const checked = host ? checkUrl(value, [host]) : { ok: false, message: 'The address is not valid.' };
    if (!checked.ok) throw new BrokerError(422, 'invalid_fields', checked.message, { errors: [checked.message] });
  }
  if (manifest.auth.kind === 'secret_url' && secrets.url && !manifest.auth.hostAllowlist) {
    const host = new URL(secrets.url).hostname.toLowerCase();
    const checked = checkUrl(secrets.url, [host]);
    if (!checked.ok) throw new BrokerError(422, 'invalid_fields', checked.message, { errors: [checked.message] });
  }
}

/**
 * POST /connectors/:id/connect
 * @param {Record<string, any>} env
 * @param {{ connectorId: string, label?: string, fields?: Record<string, string>, saveIfUnverified?: boolean, origin: string }} args
 */
export async function connect(env, { connectorId, label, fields = {}, saveIfUnverified = false, origin }) {
  const manifest = manifestById(connectorId);
  if (!manifest) throw new BrokerError(404, 'unknown_connector', 'This connector is not in the catalog.');
  if (!vaultReady(env)) throw new BrokerError(503, 'vault_not_ready', 'The vault is not ready.', { fix: VAULT_FIX });

  const checked = validateConnectFields(manifest, fields);
  if (!checked.ok) throw new BrokerError(422, 'invalid_fields', checked.errors[0], { errors: checked.errors });
  const { config, secrets } = checked;
  if (manifest.auth.kind === 'secret_url') {
    const bad = checkSecretUrl(manifest, secrets.url);
    if (bad) throw new BrokerError(422, 'invalid_fields', bad, { errors: [bad] });
  }
  checkTypedAddress(manifest, config, secrets);

  const connection = {
    id: newConnectionId(),
    connectorId,
    label: await uniqueLabel(env, connectorId, String(label || config.label || manifest.name).trim().slice(0, 60) || manifest.name),
    status: 'connected',
    config,
    secretNames: Object.keys(secrets),
    meta: {},
  };

  // OAuth: store the client, then wait for the approval in the browser.
  if (manifest.auth.kind === 'oauth2_pkce') {
    connection.status = 'needs_authorization';
    await insertConnection(env, connection);
    await saveSecrets(env, connection, secrets);
    return { connection: publicConnection(await getConnection(env, connection.id), manifest), needsAuthorization: true, test: { ok: null, skipped: true, ms: 0 } };
  }

  const test = await runTest(env, manifest, connection, secrets);
  if (test.ok === false && !saveIfUnverified) {
    throw new BrokerError(422, 'test_failed', test.error ?? 'The test failed.', { test, canSaveAnyway: true });
  }
  connection.status = test.ok === true ? 'connected' : 'unverified';
  if (test.ok !== null && !test.skipped) Object.assign(connection, { lastTestAt: nowIso(), lastTestOk: test.ok, lastTestMs: test.ms, lastError: test.ok ? null : test.error ?? null });

  const extras = {};
  let stored;
  try {
    await insertConnection(env, connection);
    await saveSecrets(env, connection, secrets);
    stored = await getConnection(env, connection.id);
    if (connectorId === 'webhook_in') Object.assign(extras, await createHook(env, stored, { origin }));
    if (connectorId === 'telegram') Object.assign(extras, await telegramAfterConnect(env, stored, secrets, { origin }));
    if (connectorId === 'mcp_remote') extras.tools = (await refreshRemoteTools(env, stored, secrets)).tools;
  } catch (err) {
    await deleteConnectionRows(env, connection.id);
    const e = lowerError(err, manifest);
    if (e instanceof BrokerError) throw new BrokerError(e.status, e.code, `The connection was not saved. ${e.message}`, e.extra);
    throw err;
  }
  return { connection: publicConnection(await getConnection(env, connection.id), manifest), test, ...extras };
}

export async function renameConnection(env, id, label) {
  const connection = await getConnection(env, id);
  if (!connection) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  const next = String(label ?? '').trim().slice(0, 60);
  if (!next) throw new BrokerError(422, 'invalid_fields', 'The label cannot be empty.');
  const clash = (await listConnections(env, connection.connectorId)).find((c) => c.label === next && c.id !== id);
  if (clash) throw new BrokerError(409, 'label_taken', 'Another connection of this connector has this label.');
  await updateConnection(env, id, { label: next });
  return publicConnection(await getConnection(env, id), manifestById(connection.connectorId));
}

/** POST /connections/:cid/disconnect. It deletes the vault records and the remote registrations. */
export async function disconnect(env, id) {
  const connection = await getConnection(env, id);
  if (!connection) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  const manifest = manifestById(connection.connectorId);
  const remote = {};
  if (connection.connectorId === 'telegram') {
    try {
      Object.assign(remote, await telegramBeforeDisconnect(env, connection));
    } catch (err) {
      remote.telegramWebhook = `not removed: ${err instanceof Error ? err.message : 'error'}`;
    }
  }
  await deleteConnectionRows(env, id);
  await env.DB.prepare("UPDATE approvals SET status = 'expired', input_json = '{}' WHERE connection_id = ? AND status = 'pending'").bind(id).run();
  void manifest;
  return { ok: true, remote };
}

export async function setActionMode(env, connectionId, actionId, mode) {
  const connection = await getConnection(env, connectionId);
  if (!connection) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  const manifest = manifestById(connection.connectorId);
  const action = actionOf(manifest, actionId);
  if (!action) throw new BrokerError(404, 'unknown_action', 'This action does not exist.');
  if (!['ask', 'auto', 'deny'].includes(mode)) throw new BrokerError(422, 'invalid_fields', 'The mode must be ask, auto, or deny.');
  if (action.risk === 'destructive' && mode === 'auto') throw new BrokerError(422, 'invalid_fields', 'A destructive action can never run on its own.');
  await setPolicy(env, connectionId, actionId, mode);
  return { ok: true, actionId, mode };
}

export async function callLog(env, connectionId, limit) {
  if (!(await getConnection(env, connectionId))) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  return { calls: await recentCalls(env, connectionId, limit) };
}

export async function beginConnectionOAuth(env, connectionId, origin) {
  const connection = await getConnection(env, connectionId);
  if (!connection) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  const manifest = manifestById(connection.connectorId);
  try {
    return await beginOAuth(env, { connection, manifest, secrets: await loadSecrets(env, connection), origin });
  } catch (err) {
    throw lowerError(err, manifest);
  }
}

// ---------------------------------------------------------------------
// Running an action
// ---------------------------------------------------------------------

const SCOPE_READ = 'connectors:read';
const SCOPE_WRITE = 'connectors:write';
const SCOPE_PERSONAL = 'personal:read';

/**
 * Decide what a caller may do with an action.
 * @returns {{ decision: 'run' | 'approve' } | { decision: 'deny', status: number, code: string, message: string }}
 */
export function decide(caller, action, risk, mode) {
  const deny = (status, code, message) => ({ decision: 'deny', status, code, message });
  if (mode === 'deny') return deny(403, 'action_disabled', 'A person turned this action off.');
  const person = caller.kind === 'admin' || caller.kind === 'owner';
  if (risk === 'destructive' && !person) return deny(403, 'destructive_needs_admin', 'A destructive action runs only for a person with the admin token.');
  if (person || caller.kind === 'approval') return { decision: 'run' };

  if (action.dataClass === 'personal' && caller.kind === 'internal') return deny(403, 'personal_data_forbidden', 'A sub-agent cannot use an action that handles personal data.');
  if (caller.kind === 'internal') return risk === 'read' && mode === 'auto' ? { decision: 'run' } : { decision: 'approve' };

  if (caller.kind === 'mcp') {
    const scopes = new Set(caller.scopes ?? []);
    if (!scopes.has(risk === 'read' ? SCOPE_READ : SCOPE_WRITE)) return deny(403, 'scope_missing', `The token needs the scope ${risk === 'read' ? SCOPE_READ : SCOPE_WRITE}.`);
    if (action.dataClass === 'personal' && !scopes.has(SCOPE_PERSONAL)) return deny(403, 'scope_missing', `The token needs the scope ${SCOPE_PERSONAL} for personal data.`);
    return mode === 'auto' ? { decision: 'run' } : { decision: 'approve' };
  }
  return deny(403, 'caller_unknown', 'This caller is not known.');
}

async function previewOf(input) {
  const safe = scrubValue(input ?? {});
  const parts = Object.entries(safe)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 60)}`);
  return parts.join(', ');
}

/** Run the action. The decision about who may run it is already made. */
export async function executeAction(env, { connection, manifest, action, input }) {
  const started = Date.now();
  let secrets = await loadSecrets(env, connection);
  if (manifest.auth.kind === 'oauth2_pkce') secrets = await ensureAccessToken(env, connection, manifest, secrets);

  if (isImpureHandler(action.handler)) {
    let out;
    if (action.handler === 'mcp_list_tools') out = { ok: true, status: 200, data: await refreshRemoteTools(env, connection, secrets) };
    else if (action.handler === 'mcp_call_tool') {
      if ((await toolRisk(env, connection.id, input.name)) === null) await refreshRemoteTools(env, connection, secrets);
      if ((await toolRisk(env, connection.id, input.name)) === null) throw new BrokerError(404, 'unknown_tool', `The server has no tool named "${input.name}".`);
      out = await callRemoteTool(env, connection, secrets, input.name, input.arguments);
    } else throw new BrokerError(500, 'handler_missing', `The handler ${action.handler} is not implemented.`);
    return { ...out, ms: Date.now() - started, data: out.data === undefined ? undefined : scrubValue(out.data) };
  }

  let req = buildActionRequest(manifest, action, { config: connection.config, secrets, input });
  req = await signIfNeeded(manifest, secrets, req);
  const res = await sendRequest(env, manifest, connection, secrets, req, { timeoutMs: 10_000 });
  const shaped = shapeResponse(manifest, action, { ...res, input: req.input });
  const out = { ...shaped, ms: Date.now() - started };
  if (shaped.ok) out.data = scrubValue(shaped.data);
  return out;
}

async function createApproval(env, { connection, manifest, action, risk, input, caller, origin }) {
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first();
  if (Number(pending?.n ?? 0) >= MAX_PENDING_APPROVALS) throw new BrokerError(429, 'too_many_pending', 'Too many calls wait for approval. Decide some of them first.');
  const now = new Date();
  const id = randomHex(4);
  const summary = `${manifest.name}: ${action.title}${(await previewOf(input)) ? ` (${await previewOf(input)})` : ''}`.slice(0, 300);
  await env.DB.prepare(
    `INSERT INTO approvals (id, connection_id, connector_id, action_id, risk, data_class, summary, input_json, requested_by, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(id, connection.id, manifest.id, action.id, risk, action.dataClass, summary, JSON.stringify(input ?? {}), callerLabel(caller), nowIso(now), nowIso(addMinutes(now, APPROVAL_HOURS * 60)))
    .run();
  await emitEvent(env, { type: 'approval.needed', severity: 'warn', title: `Approval needed: ${manifest.name} ${action.title}`, body: `Requested by ${callerLabel(caller)}. Risk ${risk}.`, source: 'broker', dedupeKey: `approval:${id}` }).catch(() => null);
  await notifyApprovalViaTelegram(env, { id, summary, risk, requestedBy: callerLabel(caller), origin }).catch(() => null);
  return id;
}

/**
 * POST /connections/:cid/actions/:actionId
 * @param {Record<string, any>} env
 * @param {{ connectionId: string, actionId: string, input?: Record<string, any>, caller: { kind: string, id?: string, scopes?: string[] }, confirm?: string, origin?: string }} args
 * @returns {Promise<{ ok: boolean, state: 'done' | 'pending_approval' | 'error', status?: number, data?: any, truncated?: boolean, error?: string, approvalId?: string, ms?: number }>}
 */
export async function invokeAction(env, { connectionId, actionId, input = {}, caller, confirm, origin }) {
  const connection = await getConnection(env, connectionId);
  if (!connection) throw new BrokerError(404, 'not_found', 'This connection does not exist.');
  const manifest = manifestById(connection.connectorId);
  const action = manifest ? actionOf(manifest, actionId) : null;
  if (!action) throw new BrokerError(404, 'unknown_action', 'This action does not exist.');
  const label = callerLabel(caller);
  const base = { connectionId, connectorId: manifest.id, actionId, caller: label };

  try {
    // The risk of a remote MCP tool is the risk that a person set for that tool. The default is write.
    let risk = action.risk;
    if (action.handler === 'mcp_call_tool') risk = (await toolRisk(env, connectionId, input.name)) ?? 'write';

    const policies = await listPolicies(env, connectionId);
    const mode = policies[actionId] ?? (risk === 'read' ? 'auto' : 'ask');
    const verdict = decide(caller, action, risk, mode);
    if (verdict.decision === 'deny') {
      await logCall(env, { ...base, outcome: 'blocked', error: verdict.code });
      throw new BrokerError(verdict.status, verdict.code, verdict.message);
    }
    if (risk === 'destructive' && confirm !== `${manifest.id}.${action.id}`) {
      throw new BrokerError(400, 'confirm_required', `Send {"confirm": "${manifest.id}.${action.id}"} to run a destructive action.`);
    }
    if (connection.status === 'needs_reconnect' || connection.status === 'needs_authorization') {
      throw new BrokerError(409, connection.status, connection.status === 'needs_reconnect' ? `${manifest.name} needs a new sign in.` : 'Approve the access first.');
    }

    // Validate the input before anything waits in a queue.
    buildInputCheck(manifest, action, connection, input);

    if (verdict.decision === 'approve') {
      const approvalId = await createApproval(env, { connection, manifest, action, risk, input, caller, origin });
      await logCall(env, { ...base, outcome: 'pending_approval' });
      return { ok: true, state: 'pending_approval', approvalId, dataClass: action.dataClass };
    }

    const rate = await takeRate(env, `act:${connectionId}:${actionId}`, action.rateLimit?.perMinute ?? 60);
    if (!rate.ok) {
      await logCall(env, { ...base, outcome: 'rate_limited' });
      throw new BrokerError(429, 'rate_limited', `This action allows ${action.rateLimit?.perMinute ?? 60} calls for each minute.`, { retryAfterSeconds: rate.retryAfterSeconds });
    }

    const result = await executeAction(env, { connection, manifest, action, input });
    await logCall(env, { ...base, outcome: result.ok ? 'ok' : 'error', httpStatus: result.status, ms: result.ms, error: result.ok ? null : result.error });
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        await updateConnection(env, connectionId, { status: 'error', lastError: `${manifest.name} answered ${result.status}. Check the key.` });
        await emitEvent(env, { type: 'connector.needs_reconnect', severity: 'warn', title: `${manifest.name} refused the key`, body: `The service answered ${result.status}. Open Connectors to check it.`, source: `connector:${manifest.id}`, dedupeKey: `reconnect:${connectionId}` }).catch(() => null);
      }
      return { ok: false, state: 'error', status: result.status, error: result.error, ms: result.ms };
    }
    return { ok: true, state: 'done', status: result.status, data: result.data, truncated: result.truncated, ms: result.ms, dataClass: action.dataClass };
  } catch (err) {
    const e = lowerError(err, manifest);
    if (e instanceof BrokerError) {
      if (!['action_disabled', 'destructive_needs_admin', 'personal_data_forbidden', 'scope_missing'].includes(e.code)) await logCall(env, { ...base, outcome: 'error', error: e.code });
      throw e;
    }
    throw err;
  }
}

/** Check the input against the schema now. It throws ActionInputError or HandlerError for a bad input. */
function buildInputCheck(manifest, action, connection, input) {
  try {
    if (isImpureHandler(action.handler)) return;
    buildActionRequest(manifest, action, { config: connection.config, secrets: placeholderSecrets(manifest), input });
  } catch (err) {
    throw lowerError(err, manifest);
  }
}

/** A stand-in for secrets, so the input check can build the request without reading the vault. */
function placeholderSecrets(manifest) {
  return Object.fromEntries(manifest.auth.fields.filter((f) => f.secret).map((f) => [f.name, f.name === 'url' ? 'https://placeholder.invalid/x' : 'x']).concat([['access_token', 'x']]));
}

// ---------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------

const publicApproval = (r) => ({
  id: r.id, connectionId: r.connection_id, connectorId: r.connector_id, actionId: r.action_id, risk: r.risk, dataClass: r.data_class, summary: r.summary,
  requestedBy: r.requested_by, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null,
  result: r.result_json ? JSON.parse(r.result_json) : null, error: r.error ?? null,
});

/** GET /approvals */
export async function listApprovals(env, { status } = {}) {
  const stmt = status
    ? env.DB.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100').bind(status)
    : env.DB.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100');
  const { results } = await stmt.all();
  return (results ?? []).map(publicApproval);
}

export async function getApproval(env, id) {
  const row = await env.DB.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first();
  return row ? publicApproval(row) : null;
}

/**
 * Approve or deny a call that waits. An approved call runs once.
 * @param {'approve' | 'deny'} decision
 */
export async function decideApproval(env, id, decision, by, origin) {
  const row = await env.DB.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first();
  if (!row) throw new BrokerError(404, 'not_found', 'This approval does not exist.');
  if (row.status !== 'pending') throw new BrokerError(409, 'already_decided', `This approval is already ${row.status}.`);
  const now = nowIso();
  if (row.expires_at < now) {
    await env.DB.prepare("UPDATE approvals SET status = 'expired', input_json = '{}' WHERE id = ? AND status = 'pending'").bind(id).run();
    throw new BrokerError(410, 'expired', 'This approval expired.');
  }
  // Claim it first, so that two clicks cannot run the call twice.
  const next = decision === 'approve' ? 'approved' : 'denied';
  const claim = await env.DB.prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").bind(next, now, by, id).run();
  if ((claim.meta?.changes ?? 0) === 0) throw new BrokerError(409, 'already_decided', 'This approval was decided a moment ago.');
  if (decision !== 'approve') {
    await env.DB.prepare("UPDATE approvals SET input_json = '{}' WHERE id = ?").bind(id).run();
    return { ...(await getApproval(env, id)), executed: false };
  }

  let outcome;
  let error = null;
  try {
    const result = await invokeAction(env, { connectionId: row.connection_id, actionId: row.action_id, input: JSON.parse(row.input_json), caller: { kind: 'approval', id }, confirm: `${row.connector_id}.${row.action_id}`, origin });
    outcome = { ok: result.ok, status: result.status ?? null };
    error = result.ok ? null : result.error ?? 'error';
  } catch (err) {
    outcome = { ok: false, status: null };
    error = err instanceof Error ? err.message.slice(0, 200) : 'error';
  }
  await env.DB.prepare('UPDATE approvals SET status = ?, result_json = ?, error = ?, input_json = ? WHERE id = ?').bind(outcome.ok ? 'executed' : 'failed', JSON.stringify(outcome), error, '{}', id).run();
  return { ...(await getApproval(env, id)), executed: true };
}

/** In the tick: expire the approvals that waited too long, and drop their input. */
export async function expireApprovals(env, now = new Date()) {
  const res = await env.DB.prepare("UPDATE approvals SET status = 'expired', input_json = '{}' WHERE status = 'pending' AND expires_at < ?").bind(nowIso(now)).run();
  return { expired: res.meta?.changes ?? 0 };
}

// Hook info for the dashboard drawer.
export { hookInfo, listCachedTools };
