/**
 * @file D1 and vault access of the connector broker (Wave 12, C2 and C3). The pure core never calls this file.
 *
 * A connection keeps its non-secret fields in the `connections` table. Each secret field sits in `vault_records`
 * under the id `conn:<connectionId>:<field>`. The vault binds a record to its connection and its connector with
 * additional data, so a record that is copied to another row does not open.
 */
import { decryptValue, putVaultRecord } from '../lib/vault.js';
import { nowIso, randomHex } from '../lib/util.js';

export const newConnectionId = () => `c_${randomHex(8)}`;

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** @param {any} row */
export function rowToConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    connectorId: row.connector_id,
    label: row.label,
    status: row.status,
    config: parse(row.config_json, {}),
    secretNames: parse(row.secret_names, []),
    meta: parse(row.meta_json, {}),
    lastTestAt: row.last_test_at ?? null,
    lastTestOk: row.last_test_ok === null || row.last_test_ok === undefined ? null : Boolean(row.last_test_ok),
    lastTestMs: row.last_test_ms ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getConnection(env, id) {
  return rowToConnection(await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind(id).first());
}

export async function listConnections(env, connectorId) {
  const stmt = connectorId
    ? env.DB.prepare('SELECT * FROM connections WHERE connector_id = ? ORDER BY created_at').bind(connectorId)
    : env.DB.prepare('SELECT * FROM connections ORDER BY connector_id, created_at');
  const { results } = await stmt.all();
  return (results ?? []).map(rowToConnection);
}

export async function insertConnection(env, c) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO connections (id, connector_id, label, status, config_json, secret_names, meta_json, last_test_at, last_test_ok, last_test_ms, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(c.id, c.connectorId, c.label, c.status, JSON.stringify(c.config ?? {}), JSON.stringify(c.secretNames ?? []), JSON.stringify(c.meta ?? {}), c.lastTestAt ?? null, c.lastTestOk === undefined || c.lastTestOk === null ? null : c.lastTestOk ? 1 : 0, c.lastTestMs ?? null, c.lastError ?? null, now, now)
    .run();
}

const COLUMN = { label: 'label', status: 'status', config: 'config_json', secretNames: 'secret_names', meta: 'meta_json', lastTestAt: 'last_test_at', lastTestOk: 'last_test_ok', lastTestMs: 'last_test_ms', lastError: 'last_error' };

/** @param {Record<string, any>} patch */
export async function updateConnection(env, id, patch) {
  const sets = [];
  const args = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = COLUMN[key];
    if (!col) throw new Error(`unknown connection field ${key}`);
    sets.push(`${col} = ?`);
    if (key === 'config' || key === 'secretNames' || key === 'meta') args.push(JSON.stringify(value));
    else if (key === 'lastTestOk') args.push(value === null || value === undefined ? null : value ? 1 : 0);
    else args.push(value ?? null);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  await env.DB.prepare(`UPDATE connections SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

export async function deleteConnectionRows(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vault_records WHERE scope = 'connection' AND owner_id = ?").bind(id),
    env.DB.prepare('DELETE FROM connector_policies WHERE connection_id = ?').bind(id),
    env.DB.prepare('DELETE FROM mcp_remote_tools WHERE connection_id = ?').bind(id),
    env.DB.prepare('DELETE FROM oauth_states WHERE connection_id = ?').bind(id),
    env.DB.prepare('DELETE FROM hooks WHERE connection_id = ?').bind(id),
    env.DB.prepare('DELETE FROM connections WHERE id = ?').bind(id),
  ]);
}

// ---------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------

const vaultId = (connectionId, name) => `conn:${connectionId}:${name}`;

/** Store each secret of a connection in the vault. @param {Record<string,string>} secrets */
export async function saveSecrets(env, connection, secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    await putVaultRecord(env, { id: vaultId(connection.id, name), scope: 'connection', ownerId: connection.id, connectionId: connection.id, connectorId: connection.connectorId, plaintext: value });
  }
}

/** Read and decrypt every secret of a connection with one query. @returns {Promise<Record<string,string>>} */
export async function loadSecrets(env, connection) {
  const { results } = await env.DB.prepare("SELECT id, iv, ciphertext, kek_version FROM vault_records WHERE scope = 'connection' AND owner_id = ?").bind(connection.id).all();
  const out = {};
  for (const row of results ?? []) {
    const name = row.id.slice(`conn:${connection.id}:`.length);
    out[name] = await decryptValue(env, { connectionId: connection.id, connectorId: connection.connectorId }, row);
  }
  return out;
}

export async function deleteSecret(env, connectionId, name) {
  await env.DB.prepare('DELETE FROM vault_records WHERE id = ?').bind(vaultId(connectionId, name)).run();
}

// ---------------------------------------------------------------------
// Policy, calls, and rate limits
// ---------------------------------------------------------------------

export async function listPolicies(env, connectionId) {
  const { results } = await env.DB.prepare('SELECT action_id, mode FROM connector_policies WHERE connection_id = ?').bind(connectionId).all();
  return Object.fromEntries((results ?? []).map((r) => [r.action_id, r.mode]));
}

export async function setPolicy(env, connectionId, actionId, mode) {
  await env.DB.prepare(
    `INSERT INTO connector_policies (connection_id, action_id, mode, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(connection_id, action_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  )
    .bind(connectionId, actionId, mode, nowIso())
    .run();
}

/**
 * Record a call. It holds metadata only: who called, which action, how it ended. It never holds an input or a result.
 * @param {{ connectionId: string, connectorId: string, actionId: string, caller: string, outcome: string, httpStatus?: number|null, ms?: number|null, error?: string|null }} c
 */
export async function logCall(env, c) {
  try {
    await env.DB.prepare('INSERT INTO connector_calls (at, connection_id, connector_id, action_id, caller, outcome, http_status, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(nowIso(), c.connectionId, c.connectorId, c.actionId, c.caller, c.outcome, c.httpStatus ?? null, c.ms ?? null, c.error ? String(c.error).slice(0, 300) : null)
      .run();
  } catch (err) {
    console.error('titan-runner-brain: could not log a connector call:', err instanceof Error ? err.message : err);
  }
}

export async function recentCalls(env, connectionId, limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { results } = await env.DB.prepare('SELECT at, action_id, caller, outcome, http_status, ms, error FROM connector_calls WHERE connection_id = ? ORDER BY id DESC LIMIT ?').bind(connectionId, n).all();
  return (results ?? []).map((r) => ({ at: r.at, actionId: r.action_id, caller: r.caller, outcome: r.outcome, httpStatus: r.http_status, ms: r.ms, error: r.error }));
}

/**
 * Count one call against a limit for each minute.
 * @returns {Promise<{ ok: boolean, count: number, retryAfterSeconds: number }>}
 */
export async function takeRate(env, key, perMinute, now = Date.now()) {
  const window = Math.floor(now / 60_000);
  const row = await env.DB.prepare(
    `INSERT INTO connector_rate (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, window)
    .first();
  const count = Number(row?.count ?? 1);
  return { ok: count <= perMinute, count, retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)) };
}
