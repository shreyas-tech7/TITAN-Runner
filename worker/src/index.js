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

async function ghGetPublicKey(env) {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/secrets/public-key`,
    { headers: ghHeaders(env) },
  );
  if (!res.ok) throw new Error(`GitHub public-key fetch failed: ${res.status}`);
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
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub secret PUT failed: ${res.status} ${detail.slice(0, 200)}`);
  }
}

async function ghListOpenTitanIssues(env) {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?labels=titan-task&state=open&per_page=20`,
    { headers: ghHeaders(env) },
  );
  if (!res.ok) throw new Error(`GitHub issues list failed: ${res.status}`);
  return res.json();
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
    `SELECT id, task_type, brief, status, source, provider, queued_at, started_at, finished_at, result_summary, run_url
     FROM subagents ORDER BY queued_at DESC LIMIT 100`,
  ).all();
  const providers = await env.DB.prepare(
    `SELECT provider, configured, updated_at FROM provider_keys_meta ORDER BY provider ASC`,
  ).all();
  return json({
    subagents: subagents.results,
    providers: providers.results,
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

async function handleInternalStatus(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const { id, status, provider, result_summary: resultSummary, run_url: runUrl } = body ?? {};
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

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleTick(env));
  },
};
