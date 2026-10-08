/**
 * @file The vault: AES-256-GCM through WebCrypto under the key encryption key `CONNECTOR_KEK` (Wave 12, C2, decision W12-D2).
 *
 * Each record uses a fresh random 12 byte IV. The additional data is `connectionId|connectorId|kekVersion`, so a record
 * that is copied to another row, or read under another version, fails to open. If `CONNECTOR_KEK` is not set, the
 * vault is not ready and every vault route answers 503 `vault_not_ready`.
 *
 * The KEK comes from a GitHub runner (`worker-deploy.yml` or `vault-provision.yml`). No person sees it.
 */
import { fromBase64, fromHex, nowIso, toBase64 } from './util.js';

export const KEK_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class VaultNotReadyError extends Error {
  constructor() {
    super('The vault is not ready. The Worker has no CONNECTOR_KEK secret.');
    this.name = 'VaultNotReadyError';
    this.code = 'vault_not_ready';
  }
}

/** The fix that the dashboard shows when the vault is not ready. */
export const VAULT_FIX =
  'Run the workflow "Provision vault key" on the Actions tab. It makes the key inside a GitHub runner and sends it to the Worker. No person sees it.';

/** Accepts a 64 character hex string or a base64 string of 32 bytes. */
function parseKek(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return fromHex(text.toLowerCase());
  try {
    const bytes = fromBase64(text);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function vaultReady(env) {
  return parseKek(env?.CONNECTOR_KEK) !== null;
}

async function importKek(env, version = KEK_VERSION) {
  const raw = version === KEK_VERSION ? env?.CONNECTOR_KEK : env?.CONNECTOR_KEK_PREV;
  const bytes = parseKek(raw);
  if (!bytes) throw new VaultNotReadyError();
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const aadOf = (connectionId, connectorId, version) => encoder.encode(`${connectionId}|${connectorId}|${version}`);

/**
 * @param {Record<string, any>} env
 * @param {{ connectionId: string, connectorId: string }} ctx
 * @param {string} plaintext
 * @returns {Promise<{ iv: string, ciphertext: string, kek_version: number }>}
 */
export async function encryptValue(env, ctx, plaintext) {
  const key = await importKek(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(ctx.connectionId, ctx.connectorId, KEK_VERSION) }, key, encoder.encode(plaintext));
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(sealed)), kek_version: KEK_VERSION };
}

/**
 * @returns {Promise<string>} The plaintext. It throws when the data, the IV, the version, or the additional data is wrong.
 */
export async function decryptValue(env, ctx, record) {
  const version = Number(record.kek_version ?? KEK_VERSION);
  const key = await importKek(env, version);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(record.iv), additionalData: aadOf(ctx.connectionId, ctx.connectorId, version) },
    key,
    fromBase64(record.ciphertext),
  );
  return decoder.decode(plain);
}

/** Store or replace a record in `vault_records`. */
export async function putVaultRecord(env, { id, scope, ownerId, connectionId, connectorId, plaintext }) {
  const sealed = await encryptValue(env, { connectionId, connectorId }, plaintext);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO vault_records (id, scope, owner_id, iv, ciphertext, kek_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, kek_version = excluded.kek_version, updated_at = excluded.updated_at`,
  )
    .bind(id, scope, ownerId, sealed.iv, sealed.ciphertext, sealed.kek_version, now, now)
    .run();
}

export async function getVaultPlaintext(env, { id, connectionId, connectorId }) {
  const row = await env.DB.prepare('SELECT iv, ciphertext, kek_version FROM vault_records WHERE id = ?').bind(id).first();
  if (!row) return null;
  return decryptValue(env, { connectionId, connectorId }, row);
}

export async function deleteVaultRecord(env, id) {
  await env.DB.prepare('DELETE FROM vault_records WHERE id = ?').bind(id).run();
}
