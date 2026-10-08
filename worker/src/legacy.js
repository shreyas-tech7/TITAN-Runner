/**
 * @file The handlers that existed before Wave 12: the God's Eye View token, the VM fleet, OSINT, geospatial events,
 * learning paths, system memory, and the PAT diagnosis. They moved here from index.js without a change in behavior,
 * because the Workers runtime allows the entry module to export a default handler only. Tests import them from here.
 */
import { parseSigningJwk, publicJwkOf, signingKeyIsConsistent, mintGevToken, GEV_TOKEN_TTL_SECONDS } from './gev-token.js';
import { githubClient } from './lib/github.js';
import { SafeFetchError, safeFetch } from './lib/safeFetch.js';
import { json } from './lib/util.js';

/** Railway free-VM fixed specs — see railway.com/free-vm. A box is 2 vCPU /
 * 2 GB RAM, free with no account and no card (identity is the SSH key). The
 * build/claim windows below are the deadlines the driver script computes
 * from connect time when Railway's own manifest doesn't supply them. */
const RAILWAY_VM = Object.freeze({
  provider: 'railway',
  vcpu: 2,
  ramMb: 2048,
  buildWindowMs: 60 * 60 * 1000, // 60 minutes to build
  claimWindowMs: 24 * 60 * 60 * 1000, // 24 hours to claim
});

/** VM lifecycle states POST /internal/vm-status will accept. */
const VM_STATUSES = Object.freeze(['requested', 'provisioning', 'live', 'claimed', 'expired', 'failed']);

/** Cap VMs dispatched per tick well under Railway's 3-boxes-per-IP-per-day
 * limit — an Actions runner's egress IP is shared, so a burst of provisions
 * would trip "Anonymous trials are temporarily disabled" for all of them. */
const MAX_VMS_DISPATCHED_PER_TICK = 3;

/**
 * GET /gev/token mints a 5 minute access token for the God's Eye View tab.
 *
 * The dashboard calls this with the admin token it already holds (the same
 * login gate as every other route here), then loads the TITAN-GEV host with
 * the token in the URL. The host swaps it for a session cookie, so this
 * value never has to live longer than a few minutes. The token is an Ed25519
 * signature made with the private key in GEV_SIGNING_KEY. A missing or broken
 * key returns 503 and never mints.
 */
export async function handleGevToken(env) {
  const raw = typeof env.GEV_SIGNING_KEY === 'string' ? env.GEV_SIGNING_KEY : '';
  const jwk = parseSigningJwk(raw);
  if (!jwk || !(await signingKeyIsConsistent(raw))) return json({ error: 'gev_not_configured' }, 503);
  const { token, exp } = await mintGevToken(jwk);
  const res = json({ token, expires_at: new Date(exp * 1000).toISOString(), ttl_seconds: GEV_TOKEN_TTL_SECONDS });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * GET /gev/jwks publishes the public half of the signing key so the gateway
 * host can verify tokens. It needs no admin token because a public key is not
 * a secret. The response holds kty, crv, and x and nothing else. It never
 * includes the private `d` value. With no usable key it returns 503.
 */
export async function handleGevJwks(env) {
  const raw = typeof env.GEV_SIGNING_KEY === 'string' ? env.GEV_SIGNING_KEY : '';
  const jwk = parseSigningJwk(raw);
  if (!jwk || !(await signingKeyIsConsistent(raw))) {
    const res = json({ error: 'gev_not_configured' }, 503);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
  const res = json(publicJwkOf(jwk));
  res.headers.set('Cache-Control', 'public, max-age=300');
  return res;
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
    await githubClient(env).getPublicKey();
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' });
  }
}

/** GET /vms — recent VM rows for the dashboard's VM Fleet panel. */
export async function handleListVms(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, subagent_id, brief, status, provider, region, vcpu, ram_mb,
            preview_url, claim_url, build_deadline, claim_deadline, run_url,
            result_summary, created_at, updated_at
     FROM vms ORDER BY created_at DESC LIMIT 100`,
  ).all();
  return json({ vms: results, generatedAt: new Date().toISOString() });
}

/** POST /vms/provision — file a request for a free Railway VM. The 1-minute
 * tick's dispatchQueuedVms() picks it up and fires the vm-agent workflow.
 * Never provisions inline: the Worker's 10ms CPU budget can't hold an SSH
 * session open, and the actual `ssh railway.new` happens on a GitHub runner. */
export async function handleProvisionVm(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const brief = typeof body?.brief === 'string' ? body.brief.trim().slice(0, 4000) : '';
  const subagentId = typeof body?.subagent_id === 'string' && body.subagent_id.trim() ? body.subagent_id.trim() : null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO vms (id, subagent_id, brief, status, provider, vcpu, ram_mb, created_at)
     VALUES (?, ?, ?, 'requested', ?, ?, ?, ?)`,
  )
    .bind(id, subagentId, brief, RAILWAY_VM.provider, RAILWAY_VM.vcpu, RAILWAY_VM.ramMb, now)
    .run();
  return json({ ok: true, id });
}

/** POST /internal/vm-status — the vm-agent workflow callback. Partial update
 * of only the provided fields, same shape as handleInternalStatus. */
export async function handleInternalVmStatus(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const id = typeof body?.id === 'string' ? body.id : '';
  const status = typeof body?.status === 'string' ? body.status : '';
  if (!id || !VM_STATUSES.includes(status)) {
    return json({ error: `id is required and status must be one of: ${VM_STATUSES.join(', ')}` }, 400);
  }

  const now = new Date().toISOString();
  const sets = ['status = ?', 'updated_at = ?'];
  const vals = [status, now];
  const optionalStringFields = {
    preview_url: body?.preview_url,
    claim_url: body?.claim_url,
    build_deadline: body?.build_deadline,
    claim_deadline: body?.claim_deadline,
    run_url: body?.run_url,
    region: body?.region,
  };
  for (const [col, value] of Object.entries(optionalStringFields)) {
    if (typeof value === 'string' && value) {
      sets.push(`${col} = ?`);
      vals.push(value.slice(0, 500));
    }
  }
  if (typeof body?.result_summary === 'string' && body.result_summary) {
    sets.push('result_summary = ?');
    vals.push(body.result_summary.slice(0, 2000));
  }
  vals.push(id);

  const result = await env.DB.prepare(`UPDATE vms SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals)
    .run();
  if (result.meta.changes === 0) return json({ error: `no vm row with id "${id}"` }, 404);
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

/** Read the OSINT list README from its public repo through the guarded fetch. */
async function fetchOsintList(env) {
  try {
    const res = await safeFetch(env, `https://raw.githubusercontent.com/${AWESOME_OSINT_LIST_PATH}`, { headers: { 'User-Agent': 'titan-runner-brain-worker' } }, { allow: ['raw.githubusercontent.com'], timeoutMs: 8000, maxBytes: 2_000_000 });
    if (!res.ok) throw new Error(`raw.githubusercontent.com fetch failed: ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof SafeFetchError) throw new Error(`raw.githubusercontent.com fetch failed: ${err.message}`);
    throw err;
  }
}


/** POST /admin/osint/ingest — one-time (idempotent, re-runnable) catalog
 * ingestion. Admin-token-gated like every other write route; this is
 * reference data only (tool name/url/description), never something that
 * runs anything by itself. */
export async function handleAdminOsintIngest(env) {
  let markdown;
  try {
    markdown = await fetchOsintList(env);
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
export async function handleOsintTools(request, env) {
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
export async function handleOsintInvestigate(request, env) {
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
export async function handleInternalGeospatialEvent(request, env) {
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
export async function handleGeospatialEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, investigation_id, subagent_id, label, lat, lon, ip, confidence, recorded_at
     FROM geospatial_events ORDER BY recorded_at DESC LIMIT 200`,
  ).all();
  return json({ events: results, generatedAt: new Date().toISOString() });
}

// Phase 4 — "Learn anything" fallback
// ---------------------------------------------------------------------

/** POST /internal/learning-path — called by run-subagent-task.mjs when a
 * failed task's own follow-up probe names a specific knowledge gap. See
 * schema.sql's comment on why this generates the tree via this cluster's
 * own provider registry rather than a learn-anything.xyz API call that
 * does not exist. */
export async function handleInternalLearningPath(request, env) {
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
export async function handleInternalSystemMemory(request, env) {
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
export async function handleSystemMemory(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, category, lesson, prompt_injection, created_at FROM system_memory WHERE active = 1 ORDER BY created_at DESC LIMIT 20`,
  ).all();
  return json({ lessons: results });
}

/** Fire the vm-agent workflow for any `requested` VM row, capped well under
 * Railway's 3-per-IP-per-day limit. A dispatch failure leaves the row
 * `requested` so the next tick retries — same pattern as dispatchQueuedTasks. */
export async function dispatchQueuedVms(env) {
  if (!env.GITHUB_PAT) return;
  const { results } = await env.DB.prepare(
    `SELECT id, brief FROM vms WHERE status = 'requested' ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(MAX_VMS_DISPATCHED_PER_TICK)
    .all();
  for (const row of results) {
    try {
      await githubClient(env).dispatch('provision-vm', { id: row.id, brief: row.brief });
      await env.DB.prepare(`UPDATE vms SET status = 'provisioning', updated_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), row.id)
        .run();
    } catch (err) {
      console.error('titan-runner-brain: vm dispatch failed for', row.id, err instanceof Error ? err.message : err);
    }
  }
}

/** Move a VM past its window: an unclaimed box dies 24h after creation (or,
 * if it never even reported live, 60m after). Honest lifecycle — the row
 * reflects that the free box and its files are gone, never a stale "live". */
export async function expireStaleVms(env) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE vms SET status = 'expired', updated_at = ?
     WHERE status IN ('live', 'provisioning', 'requested')
       AND (
         (claim_deadline IS NOT NULL AND claim_deadline < ?)
         OR (claim_deadline IS NULL AND build_deadline IS NOT NULL AND build_deadline < ?)
       )`,
  )
    .bind(now, now, now)
    .run();
}
