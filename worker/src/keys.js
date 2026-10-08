/**
 * @file Provider keys (Wave 12, Track K): true status, save and verify, remove, test now, audit, and runner proof.
 *
 * A key takes one path. The browser sends it over https to `POST /admin/keys`. The Worker checks it with the provider,
 * seals it with the public key of GitHub (a sealed box), and writes the Actions secret. D1 keeps a fingerprint, the
 * last four characters, and the check results. The key is never in a response, a log line, an error message, D1, or an
 * audit event. The only other copy is the optional encrypted one in the vault, and only when a person asks for chat.
 */
import { CATALOG, PROVIDERS, findMisnamedSecrets, getProvider, publicProvider } from './lib/catalog.js';
import { GitHubError, PERMISSIONS, githubClient } from './lib/github.js';
import { getSettings, recordKeyEvent } from './lib/db.js';
import { SafeFetchError, checkUrl, safeFetch } from './lib/safeFetch.js';
import { sealForGithub } from './lib/sealedbox.js';
import { deleteVaultRecord, putVaultRecord, vaultReady, VAULT_FIX } from './lib/vault.js';
import { fingerprintOf, json, jsonError, last4Of, nowIso, readJson } from './lib/util.js';
import { emitEvent } from './notify.js';

export const MAX_PROVIDER_KEY_LENGTH = 1024;

/** Time limit for a provider check (K3, step 5). */
export const PROVIDER_CHECK_TIMEOUT_MS = 8000;

/** A key is one printable token. The cap is far above any real key and stops an odd body from being sealed. */
export function checkProviderKeyValue(value) {
  if (!value) return 'value is required';
  if (value.length > MAX_PROVIDER_KEY_LENGTH) return `value is too long (the limit is ${MAX_PROVIDER_KEY_LENGTH} characters)`;
  if (!/^[\x21-\x7e]+$/.test(value)) return 'value must be a single token of printable characters with no spaces';
  return null;
}

// ---------------------------------------------------------------------
// Input checks for the extra fields (base URL, model, and similar)
// ---------------------------------------------------------------------

const INPUT_RULES = {
  baseUrl: { max: 300 },
  model: { max: 200, pattern: /^[A-Za-z0-9._:/@+-]+$/, message: 'The model id may hold letters, digits, and . _ : / @ + - only.' },
  chatPath: { max: 100, pattern: /^\/[A-Za-z0-9._~/-]*$/, message: 'The chat path must start with / and hold letters, digits, and . _ ~ / - only.' },
  specialization: { max: 200, pattern: /^[a-z0-9_, -]*$/i, message: 'The specialization may hold letters, digits, commas, spaces, _ and - only.' },
  label: { max: 40, pattern: /^[\w .()-]+$/, message: 'The label may hold letters, digits, spaces, and . ( ) _ - only.' },
};

/**
 * Check the extra inputs for a provider against the catalog.
 * @returns {{ ok: true, values: Record<string,string> } | { ok: false, error: string, message: string, field: string }}
 */
export function checkProviderInputs(entry, body) {
  const values = {};
  for (const [name, rule] of Object.entries(entry.inputs ?? {})) {
    const raw = body?.[name];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      if (rule.required) return { ok: false, error: 'missing_input', field: name, message: `The field "${name}" is required for ${entry.label}.` };
      continue;
    }
    const spec = INPUT_RULES[name] ?? { max: 200 };
    if (text.length > spec.max) return { ok: false, error: 'bad_input', field: name, message: `The field "${name}" is too long.` };
    if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: 'bad_input', field: name, message: `The field "${name}" holds a control character.` };
    if (spec.pattern && !spec.pattern.test(text)) return { ok: false, error: 'bad_input', field: name, message: spec.message ?? `The field "${name}" is not valid.` };
    if (name === 'baseUrl') {
      const host = hostOf(text);
      const checked = host ? checkUrl(text, [host]) : { ok: false, message: 'The base URL is not a valid address.' };
      if (!checked.ok) return { ok: false, error: 'bad_base_url', field: name, message: checked.message };
      values[name] = text.replace(/\/+$/, '');
      continue;
    }
    values[name] = text;
  }
  return { ok: true, values };
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// The provider check (K3, steps 5 to 8)
// ---------------------------------------------------------------------

/**
 * @typedef {{ result: 'ok'|'rejected'|'rate_limited'|'timeout'|'unreachable'|'unverifiable'|'bad_url'|'error', httpStatus: number|null, httpClass: string, latencyMs: number, detail: string, at: string }} ProviderCheck
 */

function classOf(status) {
  if (status === null || status === undefined) return 'none';
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Check a key with the provider without costing a token. The key travels in a header and never in a query string.
 * The result text is fixed wording and a status. It never repeats anything that the provider sent, because a provider
 * error can echo part of a key.
 * @param {Record<string, any>} env
 * @param {object} entry A catalog provider.
 * @param {string} value The key.
 * @param {Record<string,string>} inputs The checked extra inputs.
 * @returns {Promise<ProviderCheck>}
 */
export async function verifyProviderKey(env, entry, value, inputs = {}) {
  const at = nowIso();
  const v = entry.validate;
  if (!entry.verifiable || !v) {
    return { result: 'unverifiable', httpStatus: null, httpClass: 'none', latencyMs: 0, detail: entry.unverifiableReason ?? 'This provider has no check route.', at };
  }
  const needsBase = v.url.includes('{baseUrl}');
  const baseUrl = inputs.baseUrl ?? entry.inputs?.baseUrl?.default ?? '';
  if (needsBase && !baseUrl) return { result: 'unverifiable', httpStatus: null, httpClass: 'none', latencyMs: 0, detail: 'No base URL, so there is nothing to check.', at };
  const url = v.url.replace('{baseUrl}', baseUrl.replace(/\/+$/, ''));
  const host = hostOf(url);
  const headers = { accept: 'application/json', 'user-agent': 'titan-runner-brain-worker' };
  if (v.auth?.style === 'bearer') headers.authorization = `Bearer ${value}`;
  else if (v.auth?.style === 'header' && v.auth.name) headers[v.auth.name] = value;
  else return { result: 'error', httpStatus: null, httpClass: 'none', latencyMs: 0, detail: 'The catalog has an unsupported auth style.', at };

  // Only a test can change the time limit (TITAN_TEST_MODE). The live limit is 8 seconds.
  const timeoutMs = env.TITAN_TEST_MODE === '1' && Number(env.TITAN_PROVIDER_CHECK_TIMEOUT_MS) > 0 ? Number(env.TITAN_PROVIDER_CHECK_TIMEOUT_MS) : PROVIDER_CHECK_TIMEOUT_MS;
  const started = Date.now();
  try {
    const res = await safeFetch(env, url, { method: v.method ?? 'GET', headers }, { allow: [host], timeoutMs, maxBytes: 300_000, checkDns: needsBase });
    const latencyMs = Date.now() - started;
    const status = res.status;
    const base = { httpStatus: status, httpClass: classOf(status), latencyMs, at };
    if ((v.ok ?? [200]).includes(status)) {
      await res.arrayBuffer().catch(() => null);
      return { ...base, result: 'ok', detail: `The provider answered ${status}.` };
    }
    if ((v.rejected ?? [401, 403]).includes(status)) {
      await res.arrayBuffer().catch(() => null);
      return { ...base, result: 'rejected', detail: `The provider answered ${status}.` };
    }
    for (const rule of v.rejectedWhen ?? []) {
      if (rule.status === status) {
        const body = await res.text().catch(() => '');
        if (rule.bodyIncludes && body.includes(rule.bodyIncludes)) return { ...base, result: 'rejected', detail: `The provider answered ${status} and named the key as not valid.` };
      }
    }
    await res.arrayBuffer().catch(() => null);
    if (status === 429) return { ...base, result: 'rate_limited', detail: 'The provider answered 429. It is limiting requests.' };
    if (status >= 500) return { ...base, result: 'error', detail: `The provider answered ${status}.` };
    if (status === 404 || status === 405) return { ...base, result: 'unverifiable', detail: `The check route answered ${status}, so TITAN cannot check this key.` };
    return { ...base, result: 'error', detail: `The provider answered ${status}.` };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof SafeFetchError) {
      if (err.code === 'not_public' || err.code === 'bad_url' || err.code === 'not_https') return { result: 'bad_url', httpStatus: null, httpClass: 'none', latencyMs, detail: err.message, at };
      if (err.code === 'timeout') return { result: 'timeout', httpStatus: null, httpClass: 'timeout', latencyMs, detail: 'The provider did not answer in 8 seconds.', at };
      return { result: 'unreachable', httpStatus: null, httpClass: 'network', latencyMs, detail: err.message, at };
    }
    return { result: 'error', httpStatus: null, httpClass: 'network', latencyMs, detail: 'The check failed before the provider answered.', at };
  }
}

// ---------------------------------------------------------------------
// State of one key (K2)
// ---------------------------------------------------------------------

const SLACK_MS = 120_000;

/**
 * Compute the state label of a key from the evidence. The proof and the check count only if they are newer than the
 * secret, because a newer secret means a different key.
 * @returns {{ state: string, reason: string, proof: object|null, check: object|null }}
 */
export function computeKeyState({ entry, secretPresent, secretUpdatedAt, row, pulse, stale = false }) {
  if (secretPresent === null) return { state: 'error', reason: 'GitHub did not answer, so TITAN cannot see the secret.', proof: null, check: null };
  if (!secretPresent) return { state: 'missing', reason: 'No secret with this name exists in the repo.', proof: null, check: null };

  const updated = Date.parse(secretUpdatedAt ?? '') || 0;
  const fresh = (iso) => Boolean(iso) && (Date.parse(iso) || 0) >= updated - SLACK_MS;
  const usable = row && !stale;

  const check = usable && row.check_result && fresh(row.check_at)
    ? { result: row.check_result, httpStatus: row.check_status, httpClass: classOf(row.check_status), latencyMs: row.check_latency_ms, at: row.check_at, detail: row.check_detail }
    : null;

  let proof = usable && row.proof_result && fresh(row.proof_at)
    ? { result: row.proof_result, source: 'runner', model: row.proof_model, latencyMs: row.proof_latency_ms, at: row.proof_at, detail: row.proof_detail }
    : null;

  const pulseFresh = pulse && fresh(pulse.lastCheckedAt);
  if (!proof && pulse && pulse.status === 'ok' && fresh(pulse.lastSuccessAt)) {
    proof = { result: 'ok', source: 'pulse', model: pulse.model ?? null, latencyMs: pulse.latencyMs ?? null, at: pulse.lastSuccessAt, detail: 'The pulse used this key with success.' };
  }

  if (proof?.result === 'ok') return { state: 'proven', reason: proof.source === 'pulse' ? 'The pulse used this key with success.' : 'A runner used this key with success.', proof, check };
  if (proof?.result === 'failed') {
    const text = String(proof.detail ?? '');
    if (/reject|401|403|unauthor|invalid/i.test(text)) return { state: 'invalid', reason: 'The runner test showed that the provider rejects this key.', proof, check };
    if (/429|rate/i.test(text)) return { state: 'rate_limited', reason: 'The runner test hit a rate limit.', proof, check };
    return { state: 'error', reason: 'The runner test failed.', proof, check };
  }
  if (pulseFresh && pulse.status === 'misconfigured') return { state: 'invalid', reason: 'The pulse shows that the provider rejects this key.', proof, check };
  if (pulseFresh && pulse.status === 'rate_limited') return { state: 'rate_limited', reason: 'The pulse hit a rate limit with this key.', proof, check };
  if (check?.result === 'ok') return { state: 'provider_ok', reason: 'The provider accepted this key. No runner has used it yet.', proof, check };
  if (check?.result === 'rejected') return { state: 'invalid', reason: 'The provider rejected this key.', proof, check };
  // A check that did not finish (429, timeout, no route) is not evidence. The key stays "Saved, not verified".
  if (!entry.verifiable) return { state: 'unverifiable', reason: entry.unverifiableReason ?? 'TITAN cannot check this provider.', proof, check };
  return { state: 'saved_unverified', reason: 'Saved, not verified.', proof, check };
}

// ---------------------------------------------------------------------
// The pulse view, cached for 60 seconds (K2)
// ---------------------------------------------------------------------

async function cachedText(key, ttlSeconds, producer) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const request = new Request(`https://cache.titan.invalid/${key}`);
  if (cache) {
    const hit = await cache.match(request).catch(() => null);
    if (hit) return hit.text();
  }
  const text = await producer();
  if (cache) {
    await cache.put(request, new Response(text, { headers: { 'Cache-Control': `max-age=${ttlSeconds}`, 'Content-Type': 'application/json' } })).catch(() => null);
  }
  return text;
}

/** The `providers` object of `state/providers.json` on main, or an empty object when it cannot be read. */
export async function getPulseProviders(env) {
  try {
    const text = await cachedText('state-providers', 60, () => githubClient(env).rawFile('state/providers.json'));
    return JSON.parse(text)?.providers ?? {};
  } catch {
    return {};
  }
}

function pulseSummary(rec) {
  if (!rec) return null;
  return {
    status: rec.status ?? null,
    model: rec.model ?? null,
    latencyMs: rec.latencyMs ?? null,
    errorRate: rec.errorRate ?? null,
    lastCheckedAt: rec.lastCheckedAt ?? null,
    lastSuccessAt: rec.lastSuccessAt ?? null,
    models: Array.isArray(rec.discoveredModels) ? rec.discoveredModels.slice(0, 12) : [],
    modelCount: Array.isArray(rec.discoveredModels) ? rec.discoveredModels.length : 0,
  };
}

// ---------------------------------------------------------------------
// GET /admin/keys (K2, K11)
// ---------------------------------------------------------------------

function patBlock(err) {
  const status = err?.status ?? null;
  const permission = err?.permission ?? PERMISSIONS.secretsRead;
  let hint = 'GitHub did not answer the Worker.';
  if (status === 401) hint = 'The GITHUB_PAT of the Worker is missing, expired, or revoked. Make a new token and set it with wrangler secret put GITHUB_PAT.';
  else if (status === 403) hint = `The GITHUB_PAT of the Worker lacks the "${permission}" permission. Edit the token on GitHub and add it. Do not make a new token.`;
  else if (status === 404) hint = 'The GITHUB_PAT cannot see the repo, or GITHUB_OWNER and GITHUB_REPO are wrong.';
  else if (err?.code === 'pat_missing') hint = 'The Worker has no GITHUB_PAT yet. See docs/RUNTIME.md.';
  return { ok: false, status, permission, hint, message: err instanceof Error ? err.message : 'unknown error' };
}

/** @param {{ env: any, requestId: string }} c */
export async function handleListKeys(c) {
  const { env } = c;
  const gh = githubClient(env);
  let secrets = null;
  let pat = null;
  try {
    secrets = await gh.listSecrets();
  } catch (err) {
    pat = patBlock(err);
  }
  const byName = new Map((secrets ?? []).map((s) => [s.name, s]));
  const { results: rows } = await env.DB.prepare('SELECT * FROM provider_keys').all();
  const rowOf = new Map((rows ?? []).map((r) => [r.provider, r]));
  const pulse = await getPulseProviders(env);

  // K11: the first read fills D1 from the secret list. Keys that exist without a record were set outside the dashboard.
  const reconciled = [];
  if (secrets) {
    for (const p of PROVIDERS) {
      const s = byName.get(p.secrets.key);
      if (s && !rowOf.has(p.id)) {
        const names = Object.values(p.secrets).filter((n) => byName.has(n));
        await env.DB.prepare('INSERT OR IGNORE INTO provider_keys (provider, saved_via, saved_at, secrets_json, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(p.id, 'outside', s.updated_at ?? null, JSON.stringify(names), nowIso())
          .run();
        await env.DB.prepare('INSERT INTO provider_keys_meta (provider, configured, updated_at) VALUES (?, 1, ?) ON CONFLICT(provider) DO UPDATE SET configured = 1, updated_at = excluded.updated_at')
          .bind(p.id, s.updated_at ?? nowIso())
          .run();
        rowOf.set(p.id, { provider: p.id, saved_via: 'outside', saved_at: s.updated_at ?? null });
        reconciled.push(p.id);
      }
    }
  }

  const providers = PROVIDERS.map((p) => {
    const secret = secrets ? byName.get(p.secrets.key) : null;
    const secretPresent = secrets ? Boolean(secret) : null;
    const secretUpdatedAt = secret?.updated_at ?? null;
    const row = rowOf.get(p.id) ?? null;
    const replacedOutside = Boolean(row?.saved_via === 'dashboard' && row.saved_at && secretUpdatedAt && Date.parse(secretUpdatedAt) > Date.parse(row.saved_at) + SLACK_MS);
    const savedVia = !secretPresent ? (row?.saved_via ?? null) : replacedOutside ? 'outside' : (row?.saved_via ?? 'outside');
    const showFingerprint = savedVia === 'dashboard' && !replacedOutside;
    const pv = pulse[p.id] ?? null;
    const st = computeKeyState({ entry: p, secretPresent, secretUpdatedAt, row, pulse: pv, stale: replacedOutside });
    const extras = {};
    for (const [role, name] of Object.entries(p.secrets)) if (role !== 'key') extras[role] = byName.has(name);
    return {
      ...publicProvider(p),
      secretName: p.secrets.key,
      secretPresent,
      secretUpdatedAt,
      extrasPresent: extras,
      savedVia,
      replacedOutside,
      savedAt: row?.saved_at ?? null,
      fingerprint: showFingerprint ? (row?.fingerprint ?? null) : null,
      last4: showFingerprint ? (row?.last4 ?? null) : null,
      alsoForChat: Boolean(row?.also_for_chat),
      providerCheck: st.check,
      runnerProof: st.proof,
      pulseView: pulseSummary(pv),
      state: st.state,
      stateReason: st.reason,
    };
  });

  return json({
    generatedAt: nowIso(),
    requestId: c.requestId,
    repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
    catalogUpdated: CATALOG.updated,
    vault: { ready: vaultReady(env), fix: vaultReady(env) ? null : VAULT_FIX },
    pat,
    reconciled,
    misnamedSecrets: secrets ? findMisnamedSecrets(secrets.map((s) => s.name)) : [],
    providers,
  });
}

// ---------------------------------------------------------------------
// POST /admin/keys (K3)
// ---------------------------------------------------------------------

function safeMessage(err) {
  return err instanceof Error ? err.message : 'unknown error';
}

/** @param {{ request: Request, env: any, requestId: string }} c */
export async function handleSaveKey(c) {
  const { env, requestId } = c;
  // Step 1, the admin token, is checked by the router before this runs.
  const parsed = await readJson(c.request, 16_384);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // Step 2: the provider id.
  const providerId = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
  const entry = getProvider(providerId);
  if (!entry) return jsonError(400, 'unknown_provider', `The provider "${providerId.slice(0, 40)}" is not in the catalog.`, { providers: PROVIDERS.map((p) => p.id) });

  // Step 3: the format of the key, and the soft prefix hint.
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  const bad = checkProviderKeyValue(value);
  if (bad) return jsonError(400, 'bad_value', bad);
  const warnings = [];
  const hint = entry.keyHint ?? {};
  const prefixes = hint.prefixes ?? [];
  if ((prefixes.length > 0 || hint.pattern) && !prefixes.some((p) => value.startsWith(p)) && !(hint.pattern && new RegExp(hint.pattern).test(value))) {
    warnings.push(hint.text || 'This key does not look like the usual format.');
  }

  // Step 4: the extra inputs, and the base URL (https, public host, no user name or password).
  const inputsCheck = checkProviderInputs(entry, body);
  if (!inputsCheck.ok) return jsonError(400, inputsCheck.error, inputsCheck.message, { field: inputsCheck.field });
  const inputs = inputsCheck.values;

  if (!env.GITHUB_PAT) {
    return jsonError(503, 'pat_missing', 'GITHUB_PAT is not configured on this Worker yet, so it cannot manage repository secrets. See docs/RUNTIME.md.');
  }

  // Steps 5 to 9: ask the provider, then decide.
  const providerCheck = await verifyProviderKey(env, entry, value, inputs);
  if (providerCheck.result === 'rejected') {
    await recordKeyEvent(env, { action: 'save_rejected', provider: entry.id, result: 'rejected', requestId, detail: providerCheck.detail }).catch(() => null);
    return json({ ok: false, error: 'provider_rejected', reason: providerCheck.detail, provider: entry.id, providerCheck, requestId }, 422);
  }
  if (providerCheck.result === 'bad_url') return jsonError(400, 'bad_base_url', providerCheck.detail, { requestId });
  const verified = providerCheck.result === 'ok';
  if (!verified && body.saveIfUnverified !== true) {
    return json({ ok: false, needsConfirm: true, provider: entry.id, reason: providerCheck.detail, providerCheck, warnings, requestId }, 202);
  }

  // Step 10: seal the value and write the GitHub secrets.
  const gh = githubClient(env);
  const toWrite = [[entry.secrets.key, value]];
  for (const [role, text] of Object.entries(inputs)) if (entry.secrets[role]) toWrite.push([entry.secrets[role], text]);
  try {
    const { key: publicKey, key_id: keyId } = await gh.getPublicKey({ forWrite: true });
    for (const [name, plain] of toWrite) await gh.putSecret(name, await sealForGithub(plain, publicKey), keyId);
  } catch (err) {
    // The raw value never reaches this message. Only the sealed form and the answer of GitHub left this function.
    await recordKeyEvent(env, { action: 'save_failed', provider: entry.id, result: 'github_failed', requestId, detail: safeMessage(err) }).catch(() => null);
    const pat = err instanceof GitHubError && (err.status === 401 || err.status === 403 || err.status === 404) ? patBlock(err) : undefined;
    return json({ ok: false, error: 'github_failed', message: `failed to set ${entry.secrets.key}: ${safeMessage(err)}`, pat, requestId }, 502);
  }

  const fingerprint = await fingerprintOf(value);
  const last4 = last4Of(value);
  const now = nowIso();
  const previous = await env.DB.prepare('SELECT fingerprint FROM provider_keys WHERE provider = ?').bind(entry.id).first().catch(() => null);

  // Step 11: an optional encrypted copy for instant chat. It is off by default.
  let chat = 'off';
  if (body.alsoForChat === true) {
    if (!entry.usedBy.includes('chat')) chat = 'not_supported';
    else if (!vaultReady(env)) chat = 'vault_not_ready';
    else {
      try {
        await putVaultRecord(env, { id: `provider-key:${entry.id}`, scope: 'provider_key', ownerId: entry.id, connectionId: `providerkey:${entry.id}`, connectorId: 'provider-key', plaintext: value });
        chat = 'stored';
      } catch {
        chat = 'vault_failed';
      }
    }
  } else {
    await deleteVaultRecord(env, `provider-key:${entry.id}`).catch(() => null);
  }
  if (chat === 'vault_not_ready') warnings.push(VAULT_FIX);

  // Step 12: the metadata. A new key clears the old proof. The key itself is never written.
  const checkSaved = providerCheck;
  const metaWarnings = [];
  try {
    await env.DB.prepare(
      `INSERT INTO provider_keys (provider, fingerprint, last4, saved_via, saved_at, secrets_json, also_for_chat, check_result, check_status, check_latency_ms, check_at, check_detail, proof_result, proof_model, proof_latency_ms, proof_at, proof_detail, proof_request_id, updated_at)
       VALUES (?, ?, ?, 'dashboard', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET fingerprint = excluded.fingerprint, last4 = excluded.last4, saved_via = 'dashboard', saved_at = excluded.saved_at, secrets_json = excluded.secrets_json,
         also_for_chat = excluded.also_for_chat, check_result = excluded.check_result, check_status = excluded.check_status, check_latency_ms = excluded.check_latency_ms, check_at = excluded.check_at,
         check_detail = excluded.check_detail, proof_result = NULL, proof_model = NULL, proof_latency_ms = NULL, proof_at = NULL, proof_detail = NULL, proof_request_id = excluded.proof_request_id, updated_at = excluded.updated_at`,
    )
      .bind(entry.id, fingerprint, last4, now, JSON.stringify(toWrite.map(([n]) => n)), chat === 'stored' ? 1 : 0, checkSaved.result, checkSaved.httpStatus, checkSaved.latencyMs, checkSaved.at, checkSaved.detail, requestId, now)
      .run();
    await env.DB.prepare('INSERT INTO provider_keys_meta (provider, configured, updated_at) VALUES (?, 1, ?) ON CONFLICT(provider) DO UPDATE SET configured = 1, updated_at = excluded.updated_at')
      .bind(entry.id, now)
      .run();
  } catch (err) {
    metaWarnings.push('The secret was saved, but D1 did not keep the metadata. The next read of the key list will fix this.');
    console.error('keys: metadata write failed', safeMessage(err));
  }

  // Step 13: the audit event.
  await recordKeyEvent(env, { action: previous?.fingerprint ? 'replace' : 'save', provider: entry.id, fingerprint, oldFingerprint: previous?.fingerprint ?? null, result: verified ? 'verified' : 'saved_unverified', requestId }).catch(() => null);

  // Step 14: ask a runner to prove the key. A dispatch failure never undoes the save.
  let selftest = 'dispatched';
  try {
    await gh.dispatch('provider-selftest', { provider: entry.id, requestId });
  } catch (err) {
    selftest = 'dispatch_failed';
    warnings.push(`The runner test could not start: ${safeMessage(err)}`);
  }

  // Step 15: the answer. It holds the fingerprint and the last four characters, never the key.
  return json({
    ok: true,
    provider: entry.id,
    secretName: entry.secrets.key,
    secretsWritten: toWrite.map(([n]) => n),
    fingerprint,
    last4,
    providerCheck,
    verified,
    chat,
    selftest,
    warnings: [...warnings, ...metaWarnings],
    requestId,
  });
}

// ---------------------------------------------------------------------
// DELETE /admin/keys/:provider, POST /admin/keys/:provider/test, GET /admin/keys/events (K4)
// ---------------------------------------------------------------------

/** @param {{ request: Request, env: any, requestId: string }} c @param {string} providerId */
export async function handleRemoveKey(c, providerId) {
  const { env, requestId } = c;
  const entry = getProvider(providerId);
  if (!entry) return jsonError(404, 'unknown_provider', 'That provider is not in the catalog.');
  const parsed = await readJson(c.request, 2048);
  if (!parsed.ok) return parsed.response;
  if (parsed.value.confirm !== entry.id) return jsonError(400, 'confirm_required', `Send {"confirm": "${entry.id}"} to remove this key.`);
  if (!env.GITHUB_PAT) return jsonError(503, 'pat_missing', 'GITHUB_PAT is not configured on this Worker yet.');

  const gh = githubClient(env);
  const removed = [];
  try {
    for (const name of Object.values(entry.secrets)) if (await gh.deleteSecret(name)) removed.push(name);
  } catch (err) {
    await recordKeyEvent(env, { action: 'remove_failed', provider: entry.id, result: 'github_failed', requestId, detail: safeMessage(err) }).catch(() => null);
    return json({ ok: false, error: 'github_failed', message: safeMessage(err), removed, requestId }, 502);
  }
  const previous = await env.DB.prepare('SELECT fingerprint FROM provider_keys WHERE provider = ?').bind(entry.id).first().catch(() => null);
  await deleteVaultRecord(env, `provider-key:${entry.id}`).catch(() => null);
  await env.DB.prepare('DELETE FROM provider_keys WHERE provider = ?').bind(entry.id).run();
  await env.DB.prepare('INSERT INTO provider_keys_meta (provider, configured, updated_at) VALUES (?, 0, ?) ON CONFLICT(provider) DO UPDATE SET configured = 0, updated_at = excluded.updated_at').bind(entry.id, nowIso()).run();
  await recordKeyEvent(env, { action: 'remove', provider: entry.id, oldFingerprint: previous?.fingerprint ?? null, result: 'removed', requestId }).catch(() => null);
  return json({ ok: true, provider: entry.id, removed, requestId });
}

/** @param {{ env: any, requestId: string }} c @param {string} providerId */
export async function handleTestKey(c, providerId) {
  const { env, requestId } = c;
  const entry = getProvider(providerId);
  if (!entry) return jsonError(404, 'unknown_provider', 'That provider is not in the catalog.');
  if (!env.GITHUB_PAT) return jsonError(503, 'pat_missing', 'GITHUB_PAT is not configured on this Worker yet.');
  await env.DB.prepare('UPDATE provider_keys SET proof_request_id = ? WHERE provider = ?').bind(requestId, entry.id).run();
  try {
    await githubClient(env).dispatch('provider-selftest', { provider: entry.id, requestId });
  } catch (err) {
    return json({ ok: false, error: 'dispatch_failed', message: safeMessage(err), requestId }, 502);
  }
  await recordKeyEvent(env, { action: 'test', provider: entry.id, result: 'dispatched', requestId }).catch(() => null);
  return json({ ok: true, provider: entry.id, selftest: 'dispatched', requestId });
}

/** @param {{ env: any, url: URL }} c */
export async function handleKeyEvents(c) {
  const limit = Math.min(Math.max(Number.parseInt(c.url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
  const { results } = await c.env.DB.prepare('SELECT id, at, action, provider, fingerprint, old_fingerprint, result, actor, request_id, detail FROM key_events ORDER BY id DESC LIMIT ?').bind(limit).all();
  return json({ events: results ?? [], generatedAt: nowIso() });
}

// ---------------------------------------------------------------------
// POST /internal/provider-proof (K5)
// ---------------------------------------------------------------------

/** @param {{ request: Request, env: any, requestId: string }} c */
export async function handleProviderProof(c) {
  const { env } = c;
  const parsed = await readJson(c.request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.value;
  const entry = getProvider(typeof b.provider === 'string' ? b.provider : '');
  if (!entry) return jsonError(400, 'unknown_provider', 'That provider is not in the catalog.');
  const requestId = typeof b.requestId === 'string' ? b.requestId.slice(0, 64) : null;
  const now = nowIso();

  const row = await env.DB.prepare('SELECT provider, proof_request_id FROM provider_keys WHERE provider = ?').bind(entry.id).first();
  // A proof answers one request. A late answer for an older key must not mark a newer key as proven.
  if (requestId && row?.proof_request_id && row.proof_request_id !== requestId) {
    return json({ ok: true, ignored: true, reason: 'This proof is for an older request.' });
  }

  const ok = b.ok === true;
  const model = typeof b.model === 'string' ? b.model.slice(0, 120) : null;
  const latency = Number.isFinite(Number(b.latencyMs)) ? Math.round(Number(b.latencyMs)) : null;
  const detail = typeof b.detail === 'string' ? b.detail.replace(/\s+/g, ' ').slice(0, 240) : null;
  await env.DB.prepare(
    `INSERT INTO provider_keys (provider, saved_via, proof_result, proof_model, proof_latency_ms, proof_at, proof_detail, updated_at)
     VALUES (?, 'outside', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET proof_result = excluded.proof_result, proof_model = excluded.proof_model, proof_latency_ms = excluded.proof_latency_ms,
       proof_at = excluded.proof_at, proof_detail = excluded.proof_detail, updated_at = excluded.updated_at`,
  )
    .bind(entry.id, ok ? 'ok' : 'failed', model, latency, now, detail, now)
    .run();
  await recordKeyEvent(env, { action: 'proof', provider: entry.id, result: ok ? 'proven' : 'failed', actor: 'runner', requestId, detail }).catch(() => null);
  await emitEvent(env, { type: ok ? 'key.proven' : 'key.invalid', severity: ok ? 'info' : 'warn', title: `${entry.label}: ${ok ? 'proven' : 'failed'}`, body: ok ? `A runner used the ${entry.label} key with success.` : `The runner test for ${entry.label} failed.`, dedupeKey: `key:${entry.id}:${ok ? 'ok' : 'fail'}` }).catch(() => null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// The secret write round trip (K10)
// ---------------------------------------------------------------------

/**
 * Prove that the PAT can write secrets. It writes `TITAN_DIAG_PROBE` with a random value, reads the list to see it,
 * and deletes it. It never touches a provider key.
 * @param {Record<string, any>} env
 */
export async function secretRoundTrip(env) {
  const steps = [];
  const name = 'TITAN_DIAG_PROBE';
  const gh = githubClient(env);
  const mark = (step, ok, detail) => steps.push({ step, ok, detail: detail ?? null });
  let wrote = false;
  try {
    const { key, key_id: keyId } = await gh.getPublicKey({ forWrite: true });
    mark('read public key', true);
    const probe = crypto.randomUUID().replace(/-/g, '');
    await gh.putSecret(name, await sealForGithub(probe, key), keyId);
    wrote = true;
    mark('write secret', true);
    const names = (await gh.listSecrets()).map((s) => s.name);
    mark('list secrets', names.includes(name), names.includes(name) ? null : 'The probe secret is not in the list.');
  } catch (err) {
    mark('secret round trip', false, safeMessage(err));
  } finally {
    if (wrote) {
      try {
        await gh.deleteSecret(name);
        mark('delete secret', true);
      } catch (err) {
        mark('delete secret', false, safeMessage(err));
      }
    }
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
}

/** @param {{ env: any }} c */
export async function handleSecretRoundTrip(c) {
  if (!c.env.GITHUB_PAT) return json({ ok: false, steps: [], error: 'GITHUB_PAT is not configured on this Worker yet.' });
  return json(await secretRoundTrip(c.env));
}
