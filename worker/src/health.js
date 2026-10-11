/**
 * @file Health and setup (Wave 12, Track H).
 *
 * H1  GET /health/full: one row for each part. Each check has 6 seconds, the checks run in parallel, and the Worker keeps the
 *     answer for 30 seconds.
 * H2  POST /admin/diagnose/full: the long list of checks, as a report that holds no secret.
 * H3  GET /admin/setup: the checklist on the home page.
 * The free plan allows 50 subrequests and 50 D1 queries in one call, so each check makes only a few.
 */
import { listCatalog } from './connectors/broker.js';
import { githubClient } from './lib/github.js';
import { getSetting, getSettings, setSetting } from './lib/db.js';
import { SafeFetchError, safeFetch } from './lib/safeFetch.js';
import { json, jsonError, nowIso, readJson } from './lib/util.js';
import { VAULT_FIX, vaultReady } from './lib/vault.js';
import { SCHEMA_VERSION } from './lib/migrate.js';
import { handleListKeys, secretRoundTrip } from './keys.js';
import { STUCK_AFTER_MINUTES } from './tasks.js';
import { isChannel } from './connectors/notifyRouter.js';

export const CHECK_TIMEOUT_MS = 6000;
export const CACHE_SECONDS = 30;
const URLS_KEY = 'health.urls';
const CACHE_KEY = 'health.cache';
const MAX_EXTERNAL = 8;
const DEFAULT_EXTERNAL = Object.freeze([{ id: 'gev', label: "God's Eye View host", url: 'https://titan-gev.onrender.com/healthz' }]);

const DOCS = 'https://github.com/shreyas-tech7/TITAN-Runner/blob/main/docs';
const fix = (text, doc, action) => ({ text, ...(doc ? { doc: `${DOCS}/${doc}` } : {}), ...(action ? { action } : {}) });
const row = (id, group, label, state, detail, extra = {}) => ({ id, group, label, state, detail, checkedAt: nowIso(), latencyMs: null, fix: null, ...extra });

/** Run a check with a time limit. A check that fails or hangs becomes a row, never an error. */
async function guarded(id, group, label, fn) {
  const started = Date.now();
  try {
    const out = await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS))]);
    const rows = Array.isArray(out) ? out : [out];
    return rows.map((r) => ({ ...r, latencyMs: r.latencyMs ?? Date.now() - started }));
  } catch (err) {
    const timeout = err instanceof Error && err.message === 'timeout';
    return [row(id, group, label, 'down', timeout ? `No answer in ${CHECK_TIMEOUT_MS / 1000} seconds.` : 'The check failed.', { latencyMs: Date.now() - started })];
  }
}

// ---------------------------------------------------------------------
// External health URLs (a setting)
// ---------------------------------------------------------------------

export async function readExternalUrls(env) {
  const raw = await getSetting(env, URLS_KEY).catch(() => null);
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch {
      // fall through to the defaults
    }
  }
  return [...DEFAULT_EXTERNAL];
}

/** GET /admin/health/urls */
export async function handleGetUrls(c) {
  return json({ urls: await readExternalUrls(c.env), max: MAX_EXTERNAL, requestId: c.requestId });
}

/** POST /admin/health/urls  { urls: [{ id, label, url }] } */
export async function handleSetUrls(c) {
  const parsed = await readJson(c.request, 8192);
  if (!parsed.ok) return parsed.response;
  const list = Array.isArray(parsed.value.urls) ? parsed.value.urls : null;
  if (!list || list.length > MAX_EXTERNAL) return jsonError(422, 'invalid_fields', `Send a list of at most ${MAX_EXTERNAL} health addresses.`);
  const clean = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item?.id ?? '').toLowerCase();
    const label = String(item?.label ?? '').trim().slice(0, 60);
    let url;
    try {
      url = new URL(String(item?.url ?? ''));
    } catch {
      return jsonError(422, 'invalid_fields', `The address for "${label || id}" is not valid.`);
    }
    if (!/^[a-z][a-z0-9_-]{0,29}$/.test(id) || !label || seen.has(id)) return jsonError(422, 'invalid_fields', 'Each address needs a unique short id and a label.');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return jsonError(422, 'invalid_fields', `The address for "${label}" must use https and hold no user name.`);
    seen.add(id);
    clean.push({ id, label, url: url.toString() });
  }
  await setSetting(c.env, URLS_KEY, JSON.stringify(clean));
  await setSetting(c.env, CACHE_KEY, '');
  return json({ urls: clean, requestId: c.requestId });
}

// ---------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------

async function checkWorker(env) {
  return row('worker', 'core', 'Worker', 'ok', `Commit ${env.TITAN_COMMIT || 'unknown'}, schema ${SCHEMA_VERSION}.`);
}

async function checkD1(env) {
  const t0 = Date.now();
  await env.DB.prepare('SELECT 1').first();
  const read = Date.now() - t0;
  await setSetting(env, 'health.d1Probe', nowIso());
  return row('d1', 'core', 'D1 database', 'ok', `Read ${read} ms, write ${Date.now() - t0 - read} ms.`);
}

async function checkPulse(env) {
  const s = await getSettings(env, ['pulse.lastHeartbeatAt', 'pulse.lastKeeperError', 'pulse.lastPulseStatus']);
  const hb = s['pulse.lastHeartbeatAt'];
  const age = hb ? Math.round((Date.now() - Date.parse(hb)) / 60_000) : null;
  const keeper = s['pulse.lastKeeperError'] || null;
  if (age === null) return row('pulse', 'core', 'Pulse and keeper', 'unknown', 'No heartbeat has arrived yet.', { fix: fix('Run the pulse once, or wait for the keeper.', 'RUNBOOK.md') });
  if (age > 60) return row('pulse', 'core', 'Pulse and keeper', 'down', `The last heartbeat was ${age} minutes ago.`, { fix: fix('Choose "Run pulse now" in Settings.', 'RUNBOOK.md', { label: 'Run pulse now', method: 'POST', path: '/admin/pulse/run' }) });
  if (age > 30 || keeper) return row('pulse', 'core', 'Pulse and keeper', 'warn', keeper ? `Keeper error: ${keeper.slice(0, 120)}` : `The last heartbeat was ${age} minutes ago.`, { fix: fix('Check the GITHUB_PAT of the Worker.', 'RUNBOOK.md') });
  return row('pulse', 'core', 'Pulse and keeper', 'ok', `The last heartbeat was ${age} minutes ago. Last status: ${s['pulse.lastPulseStatus'] || 'unknown'}.`);
}

async function checkPages(env) {
  const base = String(env.DASHBOARD_URL || 'https://shreyas-tech7.github.io/TITAN-Runner').replace(/\/+$/, '');
  const host = new URL(base).hostname;
  const res = await safeFetch(env, `${base}/`, { method: 'GET' }, { allow: [host], timeoutMs: 5000, maxBytes: 200_000 });
  const modified = res.headers.get('last-modified');
  const ageH = modified ? Math.round((Date.now() - Date.parse(modified)) / 3_600_000) : null;
  await res.body?.cancel().catch(() => null);
  if (res.status !== 200) return row('pages', 'core', 'Pages build', 'down', `The dashboard answered ${res.status}.`, { fix: fix('Open the Actions tab and run "Deploy dashboard".', 'RUNBOOK.md') });
  return row('pages', 'core', 'Pages build', 'ok', ageH === null ? 'The dashboard answers 200.' : `The dashboard answers 200. Built ${ageH} hours ago.`);
}

async function checkCallback(env) {
  const active = await env.DB.prepare("SELECT activated_at FROM worker_tokens WHERE kind = 'callback' AND status = 'active' ORDER BY id DESC LIMIT 1").first();
  const s = await getSettings(env, ['callback.lastError']);
  const ping = await env.DB.prepare('SELECT requested_at, received_at, auth_kind FROM callback_pings ORDER BY requested_at DESC LIMIT 1').first();
  if (s['callback.lastError']) return row('callback', 'core', 'Callback round trip', 'down', `The Worker could not set the token: ${String(s['callback.lastError']).slice(0, 120)}`, { fix: fix('Check the GITHUB_PAT permission "Secrets: Read and write".', 'KEYS.md') });
  if (!active) return row('callback', 'core', 'Callback round trip', 'warn', 'No callback token exists yet. Legacy mode is on.', { fix: fix('Wait for the next tick, or check the PAT.', 'KEYS.md') });
  if (!ping) return row('callback', 'core', 'Callback round trip', 'unknown', 'A token exists. No ping has run.', { fix: fix('Start a ping from the Keys page.', 'KEYS.md', { label: 'Start ping', method: 'POST', path: '/admin/callback-ping' }) });
  if (!ping.received_at) return row('callback', 'core', 'Callback round trip', 'warn', 'The last ping got no answer yet.', { fix: fix('Wait one minute, then ping again.', 'KEYS.md') });
  return row('callback', 'core', 'Callback round trip', ping.auth_kind === 'callback' ? 'ok' : 'warn', `The last ping came back with the ${ping.auth_kind ?? 'callback'} token.`);
}

async function checkQueue(env) {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString();
  const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM subagents WHERE status IN ('queued','dispatched','running') GROUP BY status").all();
  const stuck = await env.DB.prepare("SELECT COUNT(*) AS n FROM subagents WHERE status IN ('dispatched','running') AND COALESCE(dispatched_at, started_at, queued_at) < ?").bind(cutoff).first();
  const by = Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n]));
  const detail = `${by.queued ?? 0} queued, ${by.dispatched ?? 0} dispatched, ${by.running ?? 0} running, ${stuck?.n ?? 0} stuck.`;
  return row('queue', 'core', 'Sub-agent queue', (stuck?.n ?? 0) > 0 ? 'warn' : 'ok', detail, (stuck?.n ?? 0) > 0 ? { fix: fix(`A task that stays more than ${STUCK_AFTER_MINUTES} minutes is marked failed. Retry it from the Tasks list.`, 'RUNBOOK.md') } : {});
}

async function checkVault(env) {
  return vaultReady(env)
    ? row('vault', 'core', 'Vault', 'ok', 'CONNECTOR_KEK is set.')
    : row('vault', 'core', 'Vault', 'warn', 'CONNECTOR_KEK is not set.', { fix: fix(VAULT_FIX, 'RUNBOOK.md') });
}

const KEY_STATE = { proven: 'ok', provider_ok: 'ok', saved_unverified: 'warn', rate_limited: 'warn', unverifiable: 'unknown', missing: 'unknown', invalid: 'down', error: 'down' };

async function checkKeys(env) {
  if (!env.GITHUB_PAT) return [row('keys', 'keys', 'Provider keys', 'warn', 'GITHUB_PAT is not set, so TITAN cannot see the key secrets.', { fix: fix('Set GITHUB_PAT on the Worker.', 'KEYS.md') })];
  const body = await (await handleListKeys({ env, requestId: 'health' })).json();
  if (body.pat && body.pat.ok === false) return [row('keys', 'keys', 'Provider keys', 'down', body.pat.hint ?? 'GitHub did not answer.', { fix: fix(body.pat.hint ?? 'Check the GITHUB_PAT.', 'KEYS.md') })];
  return (body.providers ?? []).map((p) => row(`key:${p.id}`, 'keys', p.name, KEY_STATE[p.state] ?? 'unknown', `${p.state}. ${p.stateReason ?? ''}`.trim(), p.state === 'proven' || p.state === 'provider_ok' || p.state === 'unverifiable' ? {} : { fix: fix(p.state === 'missing' ? 'Add this key on the Keys page.' : 'Open the Keys page and test the key.', 'KEYS.md', { label: 'Open Keys', href: '/keys/' }) }));
}

async function checkConnectors(env) {
  const catalog = await listCatalog(env);
  const rows = [];
  for (const c of catalog.connectors) {
    for (const conn of c.connections) {
      const bad = ['needs_reconnect', 'needs_authorization', 'error'].includes(conn.status);
      const state = bad ? 'down' : conn.status === 'unverified' || conn.lastTestOk === false ? 'warn' : 'ok';
      rows.push(row(`connector:${conn.id}`, 'connectors', `${c.name}: ${conn.label}`, state, bad ? (conn.lastError ?? conn.status) : conn.lastTestAt ? `Last test ${conn.lastTestOk ? 'passed' : 'failed'} at ${conn.lastTestAt}.` : 'Connected. No test has run.', state === 'ok' ? {} : { fix: fix('Open Connectors and test or reconnect.', 'CONNECTORS.md', { label: 'Open Connectors', href: '/connectors/' }) }));
    }
  }
  if (rows.length === 0) rows.push(row('connectors', 'connectors', 'Connectors', 'unknown', 'No connector is connected yet.', { fix: fix('Connect a tool on the Connectors page.', 'CONNECTORS.md', { label: 'Open Connectors', href: '/connectors/' }) }));
  return rows;
}

async function checkVms(env) {
  const { results } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM vms GROUP BY status').all();
  if (!results?.length) return row('vms', 'fleet', 'VM fleet', 'unknown', 'No VM has been asked for.');
  const by = Object.fromEntries(results.map((r) => [r.status, r.n]));
  return row('vms', 'fleet', 'VM fleet', by.failed && !by.active ? 'down' : 'ok', Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') + '.');
}

async function checkExternal(env, item) {
  const t0 = Date.now();
  try {
    const host = new URL(item.url).hostname;
    const res = await safeFetch(env, item.url, { method: 'GET' }, { allow: [host], timeoutMs: 5500, maxBytes: 50_000, checkDns: true });
    await res.body?.cancel().catch(() => null);
    return row(`ext:${item.id}`, 'external', item.label, res.status >= 200 && res.status < 300 ? 'ok' : 'down', `Answered ${res.status} in ${Date.now() - t0} ms.`, res.ok ? {} : { fix: fix('Open the service and check its logs.', 'RUNBOOK.md') });
  } catch (err) {
    const msg = err instanceof SafeFetchError ? err.message : 'The check failed.';
    return row(`ext:${item.id}`, 'external', item.label, 'down', msg, { fix: fix('A free host sleeps when idle. Wait a minute and check again, or open its logs.', 'RUNBOOK.md') });
  }
}

/** Run every check in parallel. @returns {Promise<{ rows: any[], generatedAt: string }>} */
export async function runChecks(env) {
  const external = await readExternalUrls(env);
  const jobs = [
    guarded('worker', 'core', 'Worker', () => checkWorker(env)),
    guarded('d1', 'core', 'D1 database', () => checkD1(env)),
    guarded('pulse', 'core', 'Pulse and keeper', () => checkPulse(env)),
    guarded('pages', 'core', 'Pages build', () => checkPages(env)),
    guarded('callback', 'core', 'Callback round trip', () => checkCallback(env)),
    guarded('queue', 'core', 'Sub-agent queue', () => checkQueue(env)),
    guarded('vault', 'core', 'Vault', () => checkVault(env)),
    guarded('keys', 'keys', 'Provider keys', () => checkKeys(env)),
    guarded('connectors', 'connectors', 'Connectors', () => checkConnectors(env)),
    guarded('vms', 'fleet', 'VM fleet', () => checkVms(env)),
    ...external.map((item) => guarded(`ext:${item.id}`, 'external', item.label, () => checkExternal(env, item))),
  ];
  const rows = (await Promise.all(jobs)).flat();
  if (external.length <= DEFAULT_EXTERNAL.length) {
    rows.push(row('ext:render', 'external', 'Render sub-servers', 'unknown', 'No health address is set.', { fix: fix('Add the health address of each Render sub-server in Settings.', 'HEALTH.md', { label: 'Open Settings', href: '/?settings=health' }) }));
    rows.push(row('ext:hf', 'external', 'Hugging Face orchestrator', 'unknown', 'No health address is set.', { fix: fix('Add the health address of the orchestrator in Settings.', 'HEALTH.md', { label: 'Open Settings', href: '/?settings=health' }) }));
  }
  return { rows, generatedAt: nowIso() };
}

/** GET /health/full */
export async function handleHealthFull(c) {
  const { env } = c;
  const cached = await getSetting(env, CACHE_KEY).catch(() => null);
  if (cached) {
    try {
      const hit = JSON.parse(cached);
      if (Date.now() - Date.parse(hit.generatedAt) < CACHE_SECONDS * 1000) return json({ ...hit, cached: true, requestId: c.requestId });
    } catch {
      // ignore a broken cache
    }
  }
  const out = await runChecks(env);
  const summary = summarize(out.rows);
  const body = { ...out, summary };
  await setSetting(env, CACHE_KEY, JSON.stringify(body)).catch(() => null);
  return json({ ...body, cached: false, requestId: c.requestId });
}

export function summarize(rows) {
  const summary = { ok: 0, warn: 0, down: 0, unknown: 0 };
  for (const r of rows) summary[r.state] = (summary[r.state] ?? 0) + 1;
  return summary;
}

// ---------------------------------------------------------------------
// H2: the full diagnosis
// ---------------------------------------------------------------------

async function localRequest(env, request) {
  const { handleRequest } = await import('./app.js');
  return handleRequest(request, env);
}

/** POST /admin/diagnose/full */
export async function handleDiagnoseFull(c) {
  const { env } = c;
  const origin = env.WORKER_URL || new URL(c.request.url).origin;
  const items = [];
  const add = (id, label, state, detail) => items.push({ id, label, state, detail });
  const run = async (id, label, fn) => {
    try {
      const r = await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000))]);
      add(id, label, r.state, r.detail);
    } catch (err) {
      add(id, label, 'down', err instanceof Error && err.message === 'timeout' ? 'No answer in 15 seconds.' : 'The check failed.');
    }
  };
  const gh = env.GITHUB_PAT ? githubClient(env) : null;

  await run('version', 'Worker version', async () => ({ state: 'ok', detail: `Commit ${env.TITAN_COMMIT || 'unknown'}, schema ${SCHEMA_VERSION}.` }));
  await run('d1', 'D1 read and write', async () => {
    await env.DB.prepare('SELECT 1').first();
    await setSetting(env, 'health.d1Probe', nowIso());
    return { state: 'ok', detail: 'Read and write work.' };
  });
  await run('pat-read', 'GITHUB_PAT read access', async () => {
    if (!gh) return { state: 'down', detail: 'GITHUB_PAT is not set on the Worker.' };
    const names = await gh.listSecrets();
    return { state: 'ok', detail: `The PAT can list the repo secrets (${names.length}).` };
  });
  await run('secret-roundtrip', 'Secret write round trip (K10)', async () => {
    if (!gh) return { state: 'down', detail: 'GITHUB_PAT is not set.' };
    const r = await secretRoundTrip(env);
    return { state: r.ok ? 'ok' : 'down', detail: r.steps.map((s) => `${s.step}: ${s.ok ? 'ok' : s.detail}`).join(', ') };
  });
  await run('pat-issues', 'PAT Issues write access (T4)', async () => ({ state: 'unknown', detail: 'No safe probe exists. A pulse approval from Telegram posts a comment. If the PAT lacks "Issues: Read and write", that step shows a clear message.' }));
  await run('callback', 'Callback round trip (K8)', async () => {
    const r = await checkCallback(env);
    return { state: r.state, detail: r.detail };
  });
  await run('variable', 'Repo variable TITAN_WORKER_URL', async () => {
    if (!gh) return { state: 'unknown', detail: 'GITHUB_PAT is not set.' };
    try {
      const v = await gh.getVariable('TITAN_WORKER_URL');
      return v ? { state: 'ok', detail: 'The variable exists.' } : { state: 'warn', detail: 'The variable does not exist. The workflows cannot find the Worker.' };
    } catch {
      return { state: 'unknown', detail: 'The PAT cannot read variables. Add "Variables: Read" to see this.' };
    }
  });
  await run('pages', 'Pages build', async () => {
    const r = await checkPages(env);
    return { state: r.state, detail: r.detail };
  });
  await run('vault', 'Vault', async () => {
    const r = await checkVault(env);
    return { state: r.state, detail: r.detail };
  });
  const keys = await guarded('keys', 'keys', 'Provider keys', () => checkKeys(env));
  for (const k of keys) add(k.id, `Provider ${k.label}`, k.state, k.detail);
  const connectors = await guarded('connectors', 'connectors', 'Connectors', () => checkConnectors(env));
  for (const k of connectors) add(k.id, k.label, k.state, k.detail);
  await run('mcp', 'The /mcp route', async () => {
    const res = await localRequest(env, new Request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const tokens = await env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL').first();
    return res.status === 401 ? { state: 'ok', detail: `Answers 401 without a token. ${tokens?.n ?? 0} token(s) exist.` } : { state: 'down', detail: `A call without a token got ${res.status}. It must be 401.` };
  });
  await run('cors', 'CORS headers', async () => {
    const pages = await localRequest(env, new Request(`${origin}/status`, { method: 'OPTIONS', headers: { Origin: 'https://shreyas-tech7.github.io', 'Access-Control-Request-Method': 'GET' } }));
    const evil = await localRequest(env, new Request(`${origin}/status`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } }));
    const ok = pages.status === 204 && pages.headers.get('access-control-allow-origin') === 'https://shreyas-tech7.github.io' && evil.status === 403;
    return { state: ok ? 'ok' : 'down', detail: ok ? 'The Pages origin passes. Another origin gets 403.' : `The Pages origin got ${pages.status}. Another origin got ${evil.status}.` };
  });
  await run('lockout', 'Lockout table', async () => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures').first();
    return { state: 'ok', detail: `The table exists and holds ${r?.n ?? 0} row(s).` };
  });

  const summary = summarize(items);
  const lines = [`TITAN full diagnosis, ${nowIso()}`, `Worker commit ${env.TITAN_COMMIT || 'unknown'}, schema ${SCHEMA_VERSION}`, `Result: ${summary.ok} ok, ${summary.warn} warn, ${summary.down} down, ${summary.unknown} not tested`, ''];
  for (const i of items) lines.push(`[${i.state.toUpperCase()}] ${i.label}: ${i.detail}`);
  return json({ generatedAt: nowIso(), summary, items, report: lines.join('\n'), requestId: c.requestId });
}

// ---------------------------------------------------------------------
// H3: the setup checklist
// ---------------------------------------------------------------------

/** GET /admin/setup */
export async function handleSetup(c) {
  const { env } = c;
  const done = [];
  const item = (id, label, ok, detail, link) => done.push({ id, label, done: ok, detail, link });
  item('worker', 'The Worker is reachable and the admin token works', true, 'This answer proves it.', null);

  let patOk = false;
  if (env.GITHUB_PAT) patOk = await githubClient(env).listSecrets().then(() => true).catch(() => false);
  const cb = await checkCallback(env);
  item('pat', 'The PAT works and callbacks work', patOk && cb.state === 'ok', !env.GITHUB_PAT ? 'GITHUB_PAT is not set.' : !patOk ? 'The PAT cannot list secrets.' : cb.detail, { text: 'Open Keys', href: '/keys/' });
  item('vault', 'The vault is ready', vaultReady(env), vaultReady(env) ? 'CONNECTOR_KEK is set.' : VAULT_FIX, { text: 'See the fix', href: `${DOCS}/RUNBOOK.md` });

  let proven = 0;
  if (patOk) {
    const body = await (await handleListKeys({ env, requestId: 'setup' })).json().catch(() => ({ providers: [] }));
    proven = (body.providers ?? []).filter((p) => p.state === 'proven').length;
  }
  item('providers', 'Two providers are proven', proven >= 2, `${proven} of 2 proven.`, { text: 'Open Keys', href: '/keys/' });

  const catalog = await listCatalog(env);
  const channels = catalog.connectors.filter((x) => isChannel(x.id)).flatMap((x) => x.connections).length;
  item('channel', 'One notification channel exists', channels > 0, `${channels} channel(s).`, { text: 'Open Connectors', href: '/connectors/' });
  const tokens = await env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL').first();
  item('mcp', 'One MCP token exists', (tokens?.n ?? 0) > 0, `${tokens?.n ?? 0} token(s).`, { text: 'Open Connectors', href: '/connectors/?tab=mcp' });

  const count = done.filter((d) => d.done).length;
  return json({ items: done, done: count, total: done.length, complete: count === done.length, requestId: c.requestId });
}
