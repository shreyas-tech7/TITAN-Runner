/**
 * @file titan-runner-brain — the always-on sub-agent cluster's coordinator.
 *
 * A Cloudflare Worker, not a server: it holds no state itself (D1 does),
 * runs no long-lived process, and does no heavy computation — every tick
 * reads/writes a handful of D1 rows and makes a few GitHub REST calls, then
 * hands real work to a GitHub Actions runner via `repository_dispatch`
 * (see ../../.github/workflows/spawn-subagent.yml). This is what keeps it
 * inside the Workers free plan's 10ms-CPU-per-invocation budget.
 *
 * This is a SEPARATE layer on top of the existing 15-minute
 * `titan-pulse.yml` cron — it does not replace, weaken, or touch that
 * pulse, `src/issueSync.js`, or the Reviewer Gate. It mirrors the same
 * `titan-task`-labeled issues into its own D1 queue purely for this
 * cluster's own (redundant, and that's fine — Actions minutes are free)
 * execution and dashboard visibility; it never comments on or closes a
 * GitHub issue itself, so it cannot race the existing pulse's own
 * comment/close behavior on the same issue. See docs/RUNTIME.md.
 */
// Default import, not `import * as sealedbox` — this package is a UMD/CJS
// bundle with no statically-analyzable named exports, so `import *` only
// ever yields a `default` property under Node's ESM-CJS interop (verified
// directly while writing test/sealedbox.test.mjs: `sealedbox.seal` was
// `undefined` with the namespace-import form). The default import binds to
// `module.exports` itself, which already has `.seal`/`.open` as direct
// properties.
import sealedbox from 'tweetnacl-sealedbox-js';
import { runMetaAgent } from './meta-agent.js';

const GITHUB_API = 'https://api.github.com';

/** The five adapters this repo already has (src/providers/registry.js's
 * FAILOVER_ORDER) — task brief, section 3: never write a new adapter, and
 * a task whose type doesn't map to one of these is marked failed with a
 * clear reason rather than improvised. */
const KNOWN_PROVIDERS = ['groq', 'together', 'openrouter', 'gemini', 'huggingface'];

/** GitHub Actions secret name per provider — must match titan-pulse.yml's
 * own env mapping and .env.example exactly (HuggingFace's real env var is
 * HF_API_KEY, not HUGGINGFACE_API_KEY — see .env.example's own note). */
const PROVIDER_SECRET_NAMES = Object.freeze({
  groq: 'GROQ_API_KEY',
  together: 'TOGETHER_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  huggingface: 'HF_API_KEY',
});

const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Titan-Auth',
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Constant-time string compare — the admin token is a bearer credential,
 * so a `===` compare here would leak timing information byte by byte. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function isAuthed(request, env) {
  const token = request.headers.get('X-Titan-Auth') ?? '';
  return Boolean(env.TITAN_ADMIN_TOKEN) && timingSafeEqual(token, env.TITAN_ADMIN_TOKEN);
}

/** Encrypts `plaintext` for GitHub's repo-secret sealed-box scheme
 * (crypto_box_seal — X25519 + XSalsa20-Poly1305, ephemeral sender keypair,
 * BLAKE2b-derived nonce). `tweetnacl-sealedbox-js` implements exactly this
 * construction, cross-tested against real libsodium in its own test suite
 * — see GitHub's "Create or update a repository secret" docs for the spec
 * this must match. */
function sealForGithub(plaintext, publicKeyBase64) {
  const publicKey = fromBase64(publicKeyBase64);
  const messageBytes = new TextEncoder().encode(plaintext);
  const sealed = sealedbox.seal(messageBytes, publicKey);
  return toBase64(sealed);
}

function ghHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${env.GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'titan-runner-brain-worker',
    ...extra,
  };
}

/** Turns a failed GitHub API response into a safe-to-return, actionable
 * error message, and logs the full status/headers/body server-side (visible
 * via `wrangler tail`) for debugging. A bare `${res.status}` (the previous
 * behavior) can't tell "GITHUB_PAT lacks the Secrets permission" apart from
 * "token expired" apart from "wrong repo" — the response body and the
 * rate-limit/request-id headers can. Never includes the request's own
 * Authorization header (ghHeaders() is never passed in). */
export async function describeGithubFailure(label, res) {
  const headers = {};
  for (const [key, value] of res.headers.entries()) headers[key] = value;
  const body = await res.text().catch(() => '');
  console.error(`${label}: GitHub API ${res.status} ${res.url}`, { headers, body: body.slice(0, 500) });

  const hints = {
    401: 'GITHUB_PAT is missing, expired, or revoked',
    403: 'GITHUB_PAT lacks the "Secrets" repository permission (fine-grained PAT) or the "repo" scope (classic PAT) — see worker/wrangler.toml',
    404: 'check GITHUB_OWNER/GITHUB_REPO in wrangler.toml, or the PAT cannot see this repo',
  };
  const requestId = headers['x-github-request-id'];
  return [
    `${label} failed: ${res.status}`,
    hints[res.status],
    requestId ? `request-id: ${requestId}` : null,
    body ? body.slice(0, 200) : null,
  ]
    .filter(Boolean)
    .join(' — ');
}

async function ghGetPublicKey(env) {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/secrets/public-key`,
    { headers: ghHeaders(env) },
  );
  if (!res.ok) throw new Error(await describeGithubFailure('GitHub public-key fetch', res));
  return res.json();
}

async function ghPutSecret(env, name, encryptedValue, keyId) {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/secrets/${name}`,
    {
      method: 'PUT',
      headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId }),
    },
  );
  if (!res.ok) throw new Error(await describeGithubFailure('GitHub secret PUT', res));
}

async function ghListOpenTitanIssues(env) {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?labels=titan-task&state=open&per_page=20`,
    { headers: ghHeaders(env) },
  );
  if (!res.ok) throw new Error(`GitHub issues list failed: ${res.status}`);
  return res.json();
}

async function ghFetchRaw(path) {
  const res = await fetch(`https://raw.githubusercontent.com/${path}`, {
    headers: { 'User-Agent': 'titan-runner-brain-worker' },
  });
  if (!res.ok) throw new Error(`raw.githubusercontent.com fetch failed: ${res.status}`);
  return res.text();
}

async function ghDispatch(env, payload) {
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ event_type: 'spawn-subagent', client_payload: payload }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`repository_dispatch failed: ${res.status} ${detail.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

async function handleStatus(env) {
  const subagents = await env.DB.prepare(
    `SELECT id, task_type, brief, status, source, provider, queued_at, started_at, finished_at, result_summary, run_url, tokens_used
     FROM subagents ORDER BY queued_at DESC LIMIT 100`,
  ).all();
  const providers = await env.DB.prepare(
    `SELECT provider, configured, updated_at FROM provider_keys_meta ORDER BY provider ASC`,
  ).all();
  const learningPaths = await env.DB.prepare(
    `SELECT id, subagent_id, topic, tree, created_at FROM learning_paths ORDER BY created_at DESC LIMIT 50`,
  ).all();
  return json({
    subagents: subagents.results,
    providers: providers.results,
    learningPaths: learningPaths.results,
    generatedAt: new Date().toISOString(),
  });
}

async function handleCreateTask(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const brief = typeof body?.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return json({ error: 'brief is required' }, 400);
  const taskType = typeof body?.task_type === 'string' && body.task_type.trim() ? body.task_type.trim() : 'auto';

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO subagents (id, task_type, brief, status, source, queued_at) VALUES (?, ?, ?, 'queued', 'dashboard', ?)`,
  )
    .bind(id, taskType, brief.slice(0, 4000), now)
    .run();
  return json({ ok: true, id });
}

async function handleAdminKeys(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return json({ error: `unknown provider "${provider}" — this cluster only reuses this repo's existing adapters: ${KNOWN_PROVIDERS.join(', ')}` }, 400);
  }
  if (!value) return json({ error: 'value is required' }, 400);
  if (!env.GITHUB_PAT) {
    return json({ error: 'GITHUB_PAT is not configured on this Worker yet — cannot manage repository secrets. See docs/RUNTIME.md.' }, 503);
  }

  const secretName = PROVIDER_SECRET_NAMES[provider];
  try {
    const { key, key_id: keyId } = await ghGetPublicKey(env);
    const encrypted = sealForGithub(value, key);
    await ghPutSecret(env, secretName, encrypted, keyId);
  } catch (err) {
    // Never echo the raw value back, and never let it reach a log line —
    // only the encrypted form and GitHub's own response ever left this
    // function's scope above.
    return json({ error: `failed to set ${secretName}: ${err instanceof Error ? err.message : 'unknown error'}` }, 502);
  }

  await env.DB.prepare(
    `INSERT INTO provider_keys_meta (provider, configured, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(provider) DO UPDATE SET configured = 1, updated_at = excluded.updated_at`,
  )
    .bind(provider, new Date().toISOString())
    .run();

  return json({ ok: true, provider, secretName });
}

/** A read-only self-test for GITHUB_PAT — reuses ghGetPublicKey(), which
 * never mutates anything, so the human wiring up this Worker can confirm
 * the PAT actually works (right scope, not expired, right owner/repo)
 * before ever pasting a real provider key into /admin/keys. Always 200: a
 * failed diagnosis is still a successful diagnosis, not a request error. */
export async function handleAdminDiagnose(env) {
  if (!env.GITHUB_PAT) {
    return json({ ok: false, error: 'GITHUB_PAT is not configured on this Worker yet — see docs/RUNTIME.md.' });
  }
  try {
    await ghGetPublicKey(env);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' });
  }
}

async function handleInternalStatus(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const { id, status, provider, result_summary: resultSummary, run_url: runUrl, tokens_used: tokensUsed } = body ?? {};
  const allowed = ['running', 'done', 'failed'];
  if (!id || !allowed.includes(status)) {
    return json({ error: `id is required and status must be one of: ${allowed.join(', ')}` }, 400);
  }

  const now = new Date().toISOString();
  const sets = ['status = ?'];
  const vals = [status];
  if (typeof provider === 'string' && provider) {
    sets.push('provider = ?');
    vals.push(provider);
  }
  if (Number.isFinite(Number(tokensUsed))) {
    sets.push('tokens_used = ?');
    vals.push(Number(tokensUsed));
  }
  if (typeof resultSummary === 'string' && resultSummary) {
    sets.push('result_summary = ?');
    vals.push(resultSummary.slice(0, 2000));
  }
  if (typeof runUrl === 'string' && runUrl) {
    sets.push('run_url = ?');
    vals.push(runUrl);
  }
  if (status === 'running') {
    sets.push('started_at = ?');
    vals.push(now);
  }
  if (status === 'done' || status === 'failed') {
    sets.push('finished_at = ?');
    vals.push(now);
  }
  vals.push(id);

  const result = await env.DB.prepare(`UPDATE subagents SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals)
    .run();
  if (result.meta.changes === 0) return json({ error: `no subagent row with id "${id}"` }, 404);
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Phase 2 — OSINT tool catalog + owner-gated investigation/geospatial feed
// ---------------------------------------------------------------------

/**
 * Parses Astrosp/Awesome-OSINT-List's README format: `## Category` section
 * headers, `- [Name](url) - description` (or `— `/no-dash) list items under
 * each. Tolerant of the minor formatting drift real awesome-lists have —
 * skips a line it can't parse rather than throwing, since one bad line must
 * never abort the whole ingestion.
 * @param {string} markdown
 * @returns {Array<{name: string, category: string, url: string, description: string}>}
 */
export function parseAwesomeOsintList(markdown) {
  const tools = [];
  let category = 'Uncategorized';
  const headingRe = /^#{2,3}\s+(.+?)\s*$/;
  const itemRe = /^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*[-—:]?\s*(.*)$/;

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(headingRe);
    if (heading) {
      // Ignore boilerplate section names an awesome-list README always has
      // that are not tool categories (contributing guide, license, etc.).
      const name = heading[1].replace(/[*_`]/g, '').trim();
      if (!/^(contents|table of contents|contributing|license|about|usage)$/i.test(name)) {
        category = name;
      }
      continue;
    }

    const item = line.match(itemRe);
    if (!item) continue;
    const [, name, url, description] = item;
    if (!/^https?:\/\//i.test(url)) continue; // skip relative/anchor links
    tools.push({ name: name.trim(), category, url: url.trim(), description: description.trim() });
  }
  return tools;
}

const AWESOME_OSINT_LIST_PATH = 'Astrosp/Awesome-OSINT-List/main/README.md';

/** POST /admin/osint/ingest — one-time (idempotent, re-runnable) catalog
 * ingestion. Admin-token-gated like every other write route; this is
 * reference data only (tool name/url/description), never something that
 * runs anything by itself. */
async function handleAdminOsintIngest(env) {
  let markdown;
  try {
    markdown = await ghFetchRaw(AWESOME_OSINT_LIST_PATH);
  } catch (err) {
    return json({ error: `failed to fetch the source list: ${err instanceof Error ? err.message : 'unknown error'}` }, 502);
  }

  const tools = parseAwesomeOsintList(markdown);
  if (tools.length === 0) {
    return json({ error: 'parsed zero tools from the source list — its format may have changed; see parseAwesomeOsintList()' }, 502);
  }

  const now = new Date().toISOString();
  let inserted = 0;
  for (const tool of tools) {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO osint_tools (name, category, url, description, ingested_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(tool.name.slice(0, 200), tool.category.slice(0, 100), tool.url.slice(0, 500), tool.description.slice(0, 500), now)
      .run();
    inserted += result.meta.changes ?? 0;
  }

  return json({ ok: true, parsed: tools.length, inserted, alreadyPresent: tools.length - inserted });
}

/** GET /osint/tools?category=&q= — the retrieval function: the best-match
 * catalog rows for a category/keyword, ranked by a simple relevance score
 * (category exact match beats a name/description substring hit). */
async function handleOsintTools(request, env) {
  const url = new URL(request.url);
  const category = (url.searchParams.get('category') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 50);

  const like = `%${q}%`;
  const { results } = await env.DB.prepare(
    `SELECT name, category, url, description,
            (CASE WHEN lower(category) = lower(?) THEN 2
                  WHEN lower(category) LIKE lower(?) THEN 1 ELSE 0 END) AS category_score
     FROM osint_tools
     WHERE (? = '' OR lower(category) LIKE lower(?))
       AND (? = '' OR lower(name) LIKE lower(?) OR lower(description) LIKE lower(?))
     ORDER BY category_score DESC, name ASC
     LIMIT ?`,
  )
    .bind(category, `%${category}%`, category, `%${category}%`, q, like, like, limit)
    .all();

  return json({ tools: results, count: results.length });
}

/**
 * POST /osint/investigate — the ONLY way an OSINT-category sub-agent task
 * can ever be created. Gated by the same X-Titan-Auth admin token every
 * other write route requires, which is what stands between this and the
 * public, unauthenticated github-issue intake (see README's Security
 * section, and schema.sql's comment on this table). `mirrorGithubIssues()`
 * below hardcodes task_type='auto' and source='github-issue' for every
 * issue-sourced row — it can never produce one of these.
 */
async function handleOsintInvestigate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const targetLabel = typeof body?.target_label === 'string' ? body.target_label.trim().slice(0, 300) : '';
  const category = typeof body?.category === 'string' ? body.category.trim().slice(0, 100) : '';
  if (!targetLabel) return json({ error: 'target_label is required' }, 400);

  const toolRow = await env.DB.prepare(
    `SELECT name, url FROM osint_tools WHERE (? = '' OR lower(category) LIKE lower(?)) ORDER BY name ASC LIMIT 1`,
  )
    .bind(category, `%${category}%`)
    .first();
  const tool = toolRow ? `${toolRow.name} (${toolRow.url})` : null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const brief =
    `OSINT investigation. Target: "${targetLabel}".` +
    (tool ? ` Suggested tool: ${tool}.` : '') +
    ` Respond with STRICT JSON ONLY: {"summary": string, "location": ` +
    `{"label": string, "lat": number|null, "lon": number|null, "ip": string|null, ` +
    `"confidence": "low"|"medium"|"high"} | null}. Set "location" to null if no ` +
    `physical location or IP was found — never invent one.`;

  await env.DB.prepare(
    `INSERT INTO subagents (id, task_type, brief, status, source, queued_at) VALUES (?, 'osint', ?, 'queued', 'dashboard', ?)`,
  )
    .bind(id, brief, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO osint_investigations (id, subagent_id, target_label, category, tool_used, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  )
    .bind(crypto.randomUUID(), id, targetLabel, category || null, tool, now)
    .run();

  return json({ ok: true, id, tool });
}

/** POST /internal/geospatial-event — called by run-subagent-task.mjs after
 * an 'osint' task's model response resolves a location. Re-validates the
 * linked subagents row is source='dashboard' AND task_type='osint' before
 * writing anything — a second, independent gate on top of the fact that
 * nothing else can create such a row in the first place (defense in depth:
 * this route, not "the mirror happens not to set this today", is what
 * actually enforces the invariant). */
async function handleInternalGeospatialEvent(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const subagentId = typeof body?.subagent_id === 'string' ? body.subagent_id : '';
  const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 300) : '';
  if (!subagentId || !label) return json({ error: 'subagent_id and label are required' }, 400);

  const row = await env.DB.prepare(`SELECT source, task_type FROM subagents WHERE id = ?`).bind(subagentId).first();
  if (!row || row.source !== 'dashboard' || row.task_type !== 'osint') {
    return json({ error: 'this subagent row is not an approved, dashboard-sourced OSINT investigation — refusing to record a geospatial event' }, 403);
  }

  const investigation = await env.DB.prepare(`SELECT id FROM osint_investigations WHERE subagent_id = ?`).bind(subagentId).first();
  if (!investigation) return json({ error: 'no matching osint_investigations row for this subagent_id' }, 403);

  const lat = Number.isFinite(Number(body?.lat)) ? Number(body.lat) : null;
  const lon = Number.isFinite(Number(body?.lon)) ? Number(body.lon) : null;
  const ip = typeof body?.ip === 'string' ? body.ip.trim().slice(0, 64) : null;
  const confidence = ['low', 'medium', 'high'].includes(body?.confidence) ? body.confidence : null;

  await env.DB.prepare(
    `INSERT INTO geospatial_events (investigation_id, subagent_id, label, lat, lon, ip, confidence, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(investigation.id, subagentId, label, lat, lon, ip, confidence, new Date().toISOString())
    .run();
  await env.DB.prepare(`UPDATE osint_investigations SET status = 'located' WHERE id = ?`).bind(investigation.id).run();

  return json({ ok: true });
}

/** GET /geospatial/events — what the /ops/geospatial dashboard page polls
 * to place pins on the globe. Reads only what /internal/geospatial-event
 * above was willing to write, so this feed is exactly as gated as that
 * route is. */
async function handleGeospatialEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, investigation_id, subagent_id, label, lat, lon, ip, confidence, recorded_at
     FROM geospatial_events ORDER BY recorded_at DESC LIMIT 200`,
  ).all();
  return json({ events: results, generatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------
// Phase 4 — "Learn anything" fallback
// ---------------------------------------------------------------------

/** POST /internal/learning-path — called by run-subagent-task.mjs when a
 * failed task's own follow-up probe names a specific knowledge gap. See
 * schema.sql's comment on why this generates the tree via this cluster's
 * own provider registry rather than a learn-anything.xyz API call that
 * does not exist. */
async function handleInternalLearningPath(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const subagentId = typeof body?.subagent_id === 'string' ? body.subagent_id : '';
  const topic = typeof body?.topic === 'string' ? body.topic.trim().slice(0, 200) : '';
  const tree = body?.tree;
  if (!subagentId || !topic || !tree || typeof tree !== 'object') {
    return json({ error: 'subagent_id, topic, and tree are required' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO learning_paths (subagent_id, topic, tree, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(subagentId, topic, JSON.stringify(tree).slice(0, 8000), new Date().toISOString())
    .run();

  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Phase 5 — Hermes self-improvement loop
// ---------------------------------------------------------------------

/**
 * POST /internal/system-memory — called by run-subagent-task.mjs after a
 * 'meta-lesson' analysis task completes. This is the ONLY place that ever
 * writes `system_memory`, and every write here also writes a matching
 * `system_memory_audit` row in the same request — old value, new value,
 * timestamp, and the specific task that triggered it — precisely so a
 * future drift in what this loop is teaching sub-agent tasks is
 * debuggable from a diffable history, not just observable after the fact.
 */
async function handleInternalSystemMemory(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const category = typeof body?.category === 'string' ? body.category.trim().slice(0, 100) : '';
  const lesson = typeof body?.lesson === 'string' ? body.lesson.trim().slice(0, 500) : '';
  const promptInjection = typeof body?.promptInjection === 'string' ? body.promptInjection.trim().slice(0, 500) : '';
  const triggeringTaskId = typeof body?.triggeringTaskId === 'string' ? body.triggeringTaskId : null;
  if (!category || !lesson || !promptInjection) {
    return json({ error: 'category, lesson, and promptInjection are required' }, 400);
  }

  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO system_memory (category, lesson, prompt_injection, active, created_at) VALUES (?, ?, ?, 1, ?)`,
  )
    .bind(category, lesson, promptInjection, now)
    .run();
  const memoryId = inserted.meta.last_row_id;

  await env.DB.prepare(
    `INSERT INTO system_memory_audit (memory_id, action, old_value, new_value, triggering_task_id, reason, created_at)
     VALUES (?, 'created', NULL, ?, ?, ?, ?)`,
  )
    .bind(
      memoryId,
      JSON.stringify({ category, lesson, promptInjection }),
      triggeringTaskId,
      `Hermes meta-agent analysis of ${triggeringTaskId ?? 'an unspecified task'}`,
      now,
    )
    .run();

  return json({ ok: true, memoryId });
}

/** GET /system-memory — what run-subagent-task.mjs prepends to every
 * future sub-agent task's context window before calling a provider (task
 * brief, phase 5: "Future sub-agent tasks MUST read from system_memory"),
 * and what the dashboard renders as the Hermes panel. */
async function handleSystemMemory(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, category, lesson, prompt_injection, created_at FROM system_memory WHERE active = 1 ORDER BY created_at DESC LIMIT 20`,
  ).all();
  return json({ lessons: results });
}

// ---------------------------------------------------------------------
// Scheduled tick
// ---------------------------------------------------------------------

async function mirrorGithubIssues(env) {
  if (!env.GITHUB_PAT) return;
  let issues;
  try {
    issues = await ghListOpenTitanIssues(env);
  } catch (err) {
    console.error('titan-runner-brain: issue mirror failed:', err instanceof Error ? err.message : err);
    return;
  }
  const now = new Date().toISOString();
  for (const issue of issues) {
    if (issue.pull_request) continue; // GitHub's issues endpoint also returns PRs with this label
    const id = `gh-issue-${issue.number}`;
    const brief = `${issue.title ?? ''}\n\n${issue.body ?? ''}`.trim().slice(0, 4000);
    try {
      // task_type is hardcoded to 'auto' here, never derived from issue
      // content — this is the reason an anonymous public GitHub issue can
      // never become an 'osint' task (see /osint/investigate's doc comment
      // and schema.sql's note on osint_investigations): the only place
      // task_type='osint' is ever written is that admin-token-gated route.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO subagents (id, task_type, brief, status, source, queued_at) VALUES (?, 'auto', ?, 'queued', 'github-issue', ?)`,
      )
        .bind(id, brief, now)
        .run();
    } catch (err) {
      console.error('titan-runner-brain: D1 insert failed for', id, err instanceof Error ? err.message : err);
    }
  }
}

async function dispatchQueuedTasks(env) {
  if (!env.GITHUB_PAT) return;
  // Cap well under GitHub's 20 concurrent-job account ceiling (task brief,
  // section 1b) — other repos on the same account may also be running CI.
  const { results } = await env.DB.prepare(
    `SELECT id, task_type, brief FROM subagents WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 5`,
  ).all();
  for (const row of results) {
    try {
      await ghDispatch(env, { id: row.id, task_type: row.task_type, brief: row.brief });
      await env.DB.prepare(`UPDATE subagents SET status = 'dispatched' WHERE id = ?`).bind(row.id).run();
    } catch (err) {
      // Left as 'queued' — the next tick (one minute away) retries it.
      console.error('titan-runner-brain: dispatch failed for', row.id, err instanceof Error ? err.message : err);
    }
  }
}

async function handleTick(env) {
  await mirrorGithubIssues(env);
  await dispatchQueuedTasks(env);
}

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === '/' && request.method === 'GET') {
      return json({ ok: true, service: 'titan-runner-brain' });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleStatus(env);
    }

    if (url.pathname === '/tasks' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleCreateTask(request, env);
    }

    if (url.pathname === '/admin/keys' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleAdminKeys(request, env);
    }

    if (url.pathname === '/admin/diagnose' && request.method === 'GET') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleAdminDiagnose(env);
    }

    // Phase 2 — OSINT catalog + owner-gated investigation/geospatial feed.
    // Every route below (including the GET ones) requires the admin token:
    // this data is exactly as world-readable-if-unguarded as everything
    // else the Worker holds, and /osint/investigate in particular is the
    // one and only path that can ever create an OSINT-category task — see
    // its own doc comment above.
    if (url.pathname === '/admin/osint/ingest' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleAdminOsintIngest(env);
    }

    if (url.pathname === '/osint/tools' && request.method === 'GET') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleOsintTools(request, env);
    }

    if (url.pathname === '/osint/investigate' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleOsintInvestigate(request, env);
    }

    if (url.pathname === '/geospatial/events' && request.method === 'GET') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleGeospatialEvents(env);
    }

    // Called back by scripts/run-subagent-task.mjs — same admin-token gate
    // as /internal/status, plus its own independent re-validation inside
    // the handler (see handleInternalGeospatialEvent's doc comment).
    if (url.pathname === '/internal/geospatial-event' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleInternalGeospatialEvent(request, env);
    }

    // Phase 4 — "learn anything" fallback (see handleInternalLearningPath).
    if (url.pathname === '/internal/learning-path' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleInternalLearningPath(request, env);
    }

    // Phase 5 — Hermes self-improvement loop (see meta-agent.js and
    // handleInternalSystemMemory's doc comment).
    if (url.pathname === '/internal/system-memory' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleInternalSystemMemory(request, env);
    }

    if (url.pathname === '/system-memory' && request.method === 'GET') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleSystemMemory(env);
    }

    // Called back by .github/workflows/spawn-subagent.yml to report
    // running/done/failed — gated by the same admin token, which that
    // workflow reads from its own repo secret of the same name (task
    // brief section 3 offered a second scoped Cloudflare API token
    // instead; reusing the one shared token here means one fewer
    // credential to generate and rotate — see the build brief).
    if (url.pathname === '/internal/status' && request.method === 'POST') {
      if (!isAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleInternalStatus(request, env);
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    // Two cron entries share this one handler (see wrangler.toml) —
    // branch on which fired rather than running both on every tick, since
    // the meta-agent's D1 scan is real work this Worker only wants to do
    // once every 6 hours, not once a minute.
    if (event.cron === '0 */6 * * *') {
      ctx.waitUntil(runMetaAgent(env));
      return;
    }
    ctx.waitUntil(handleTick(env));
  },
};
