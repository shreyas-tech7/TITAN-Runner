/**
 * @file The shared ops services of contract v1 (RO1 to RO6). See docs/CONTRACT.md.
 *
 *   POST /ops/usage     one usage record or an array of them
 *   GET  /ops/usage     daily totals
 *   GET  /ops/quota     limit, used, remaining, reset, and exhausted, for each provider and model
 *   GET  /ops/health    the latest canary result of each provider and model
 *   GET  /ops/eval      the latest eval score of each model and taxonomy category
 *   GET  /ops/hosts     status and uptime of each host, by name
 *   POST /ops/health, /ops/eval, /ops/hosts, /ops/doorbell   stores the results of the workflows
 *
 * Every route needs the ops token in the Authorization header. The app pipeline checks the token. TITAN-Runner is public, so
 * every body is validated with a strict schema: a field that the contract does not name is refused. That keeps a
 * prompt, a note, or a person's data out of the tables if a caller sends it by mistake.
 */
import { PROVIDERS } from './lib/catalog.js';
import { validate } from './lib/jsonschema.js';
import { json, jsonError, nowIso, sha256Hex, timingSafeEqual } from './lib/util.js';
import { QUOTAS, blockedUntilAfter429, computeQuota, dayWindow, monthStart, providerKey, resolveLimit } from '../../src/ops/quota.js';

export const CONTRACT_VERSION = '1';
const MAX_BODY_BYTES = 262_144;
const MAX_RECORDS = 500;

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

/**
 * Check the Authorization header, which must hold the Bearer scheme and the ops token. A token under 24 characters counts as not set, so a weak value never opens a door.
 * @returns {'ok'|'missing'|'wrong'}
 */
export function authenticateOps(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  if (!header) return 'missing';
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return 'wrong';
  if (typeof env.OPS_TOKEN !== 'string' || env.OPS_TOKEN.length < 24) return 'wrong';
  return timingSafeEqual(m[1], env.OPS_TOKEN) ? 'ok' : 'wrong';
}

// ---------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------

const NAME = '^[a-z][a-z0-9_.-]{0,39}$';
const MODEL = '^(?:\\*|[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119})$';
const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$';
const count = { type: 'integer', minimum: 0, maximum: 1_000_000_000 };

export const USAGE_RECORD = {
  type: 'object',
  required: ['source', 'provider', 'model', 'requests', 'tokens_in', 'tokens_out', 'status', 'ts'],
  additionalProperties: false,
  properties: {
    source: { enum: ['titan', 'runner'] },
    provider: { type: 'string', pattern: NAME },
    model: { type: 'string', pattern: MODEL },
    requests: count,
    tokens_in: count,
    tokens_out: count,
    status: { enum: ['ok', 'error', 'rate_limited'] },
    ts: { type: 'string', pattern: ISO, maxLength: 40 },
    remaining_requests: count,
    remaining_tokens: count,
  },
};

const HEALTH_STATUS = ['healthy', 'degraded', 'down', 'not_configured'];
const HEALTH_BODY = {
  type: 'object', required: ['results'], additionalProperties: false,
  properties: {
    results: {
      type: 'array', minItems: 1, maxItems: 200,
      items: {
        type: 'object', required: ['provider', 'model', 'status', 'checked_at'], additionalProperties: false,
        properties: {
          provider: { type: 'string', pattern: NAME }, model: { type: 'string', pattern: MODEL }, status: { enum: HEALTH_STATUS },
          latency_ms: { type: ['integer', 'null'], minimum: 0, maximum: 3_600_000 }, checked_at: { type: 'string', pattern: ISO },
          error_class: { type: ['string', 'null'], maxLength: 80 },
        },
      },
    },
  },
};

const EVAL_BODY = {
  type: 'object', required: ['results'], additionalProperties: false,
  properties: {
    results: {
      type: 'array', minItems: 1, maxItems: 500,
      items: {
        type: 'object', required: ['model', 'category', 'score', 'tasks_run', 'run_at', 'eval_version'], additionalProperties: false,
        properties: {
          model: { type: 'string', pattern: MODEL }, category: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,59}$' },
          score: { type: 'number', minimum: 0, maximum: 1 }, tasks_run: { type: 'integer', minimum: 0, maximum: 10_000 },
          run_at: { type: 'string', pattern: ISO }, eval_version: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,40}$' },
        },
      },
    },
  },
};

const HOST_STATUS = ['up', 'asleep', 'down'];
const percent = { type: ['number', 'null'], minimum: 0, maximum: 100 };
const HOSTS_BODY = {
  type: 'object', required: ['checks'], additionalProperties: false,
  properties: {
    checks: {
      type: 'array', minItems: 1, maxItems: 50,
      items: {
        type: 'object', required: ['host', 'status', 'last_check'], additionalProperties: false,
        properties: {
          host: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,39}$' }, status: { enum: HOST_STATUS }, last_check: { type: 'string', pattern: ISO },
          uptime_24h: percent, uptime_7d: percent, uptime_30d: percent, last_pulse_at: { type: ['string', 'null'], pattern: ISO },
        },
      },
    },
  },
};

const DOORBELL_BODY = {
  type: 'object', required: ['job', 'status_code', 'at'], additionalProperties: false,
  properties: {
    job: { enum: ['digest', 'weekly-review', 'sweep'] }, status_code: { type: ['integer', 'null'], minimum: 0, maximum: 999 }, at: { type: 'string', pattern: ISO },
  },
};

// ---------------------------------------------------------------------
// Reading a body
// ---------------------------------------------------------------------

async function readBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: jsonError(400, 'invalid_body', 'The body could not be read.') };
  }
  if (text.length > MAX_BODY_BYTES) return { error: jsonError(413, 'body_too_large', `The body is larger than ${MAX_BODY_BYTES} bytes.`) };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: jsonError(400, 'invalid_json', 'The body is not valid JSON.') };
  }
}

const withMeta = (data) => ({ contract: CONTRACT_VERSION, generated_at: nowIso(), ...data });
const fieldOf = (problem) => problem.split(': ')[0].replace(/^\$\.?/, '') || 'body';

// ---------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------

async function dedupeKey(r) {
  return sha256Hex([r.source, r.provider, r.model, r.ts, r.status, r.requests, r.tokens_in, r.tokens_out, r.remaining_requests ?? '', r.remaining_tokens ?? ''].join('|'));
}

/** Requests of one provider (or one model) since a time. A provider scope counts every model that the limit entry covers. */
function sumRequests(rows, { provider, matcher, since }) {
  let n = 0;
  for (const r of rows) if (r.provider === provider && matcher(r.model) && r.ts >= since) n += r.requests;
  return n;
}

function matcherFor(entryKey, scope, model) {
  if (scope !== 'provider') return (m) => m === model;
  if (entryKey === '*') return () => true;
  if (entryKey.startsWith('*')) return (m) => m.endsWith(entryKey.slice(1));
  return (m) => m === entryKey;
}

/** POST /ops/usage */
export async function handleOpsUsagePost(c) {
  const body = await readBody(c.request);
  if (body.error) return body.error;
  const list = Array.isArray(body.value) ? body.value : [body.value];
  if (list.length === 0 || list.length > MAX_RECORDS) return jsonError(400, 'invalid_records', `Send 1 to ${MAX_RECORDS} records.`);
  const now = new Date();
  const rejected = [];
  const good = [];
  list.forEach((record, index) => {
    const problems = validate(USAGE_RECORD, record);
    if (problems.length > 0) {
      for (const p of problems.slice(0, 5)) rejected.push({ index, field: fieldOf(p), message: p.split(': ').slice(1).join(': ') });
      return;
    }
    const ts = Date.parse(record.ts);
    if (ts > now.getTime() + 3_600_000) rejected.push({ index, field: 'ts', message: 'is in the future' });
    else if (ts < now.getTime() - 40 * 86_400_000) rejected.push({ index, field: 'ts', message: 'is older than 40 days' });
    else good.push(record);
  });
  if (good.length === 0) return jsonError(400, 'invalid_records', 'No record is valid.', { rejected: rejected.slice(0, 20) });

  const statements = [];
  const keys = [];
  for (const r of good) {
    const dedupe = await dedupeKey(r);
    keys.push(dedupe);
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO usage_log (dedupe, source, provider, model, requests, tokens_in, tokens_out, status, ts, remaining_requests, remaining_tokens, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(dedupe, r.source, r.provider, r.model, r.requests, r.tokens_in, r.tokens_out, r.status, new Date(Date.parse(r.ts)).toISOString(), r.remaining_requests ?? null, r.remaining_tokens ?? null, nowIso(now)),
    );
  }
  const results = await c.env.DB.batch(statements);
  const inserted = results.map((res) => res.meta?.changes ?? 0);
  const accepted = inserted.reduce((a, b) => a + b, 0);

  // Provider facts: a 429 holds the model until the reset, and a header shows what is left.
  for (let i = 0; i < good.length; i += 1) {
    if (!inserted[i]) continue;
    const r = good[i];
    if (r.status === 'rate_limited') {
      await c.env.DB.prepare(
        `INSERT INTO quota_state (provider, model, blocked_until, last_429_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET blocked_until = excluded.blocked_until, last_429_at = excluded.last_429_at`,
      ).bind(r.provider, r.model, blockedUntilAfter429(r.provider, new Date(Date.parse(r.ts))), new Date(Date.parse(r.ts)).toISOString()).run();
    }
    if (r.remaining_requests != null || r.remaining_tokens != null) {
      const found = resolveLimit(r.provider, r.model);
      const win = dayWindow(found?.provider.reset ?? 'utc-midnight', now);
      const { results: rows } = await c.env.DB.prepare('SELECT provider, model, requests, ts FROM usage_log WHERE provider = ? AND ts >= ?').bind(r.provider, win.start.toISOString()).all();
      const matcher = matcherFor(found?.matched ?? '*', found?.entry.scope ?? 'model', r.model);
      const usedDay = sumRequests(rows ?? [], { provider: r.provider, matcher, since: win.start.toISOString() });
      await c.env.DB.prepare(
        `INSERT INTO quota_state (provider, model, observed_remaining_requests, observed_remaining_tokens, observed_at, used_day_at_observation) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET observed_remaining_requests = excluded.observed_remaining_requests, observed_remaining_tokens = excluded.observed_remaining_tokens,
           observed_at = excluded.observed_at, used_day_at_observation = excluded.used_day_at_observation`,
      ).bind(r.provider, r.model, r.remaining_requests ?? null, r.remaining_tokens ?? null, new Date(Date.parse(r.ts)).toISOString(), usedDay).run();
    }
  }
  return json({ accepted, duplicates: good.length - accepted, rejected: rejected.slice(0, 20) });
}

/** GET /ops/usage?days=7 */
export async function handleOpsUsageGet(c) {
  const days = Math.min(40, Math.max(1, Number.parseInt(c.url.searchParams.get('days') ?? '7', 10) || 7));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { results } = await c.env.DB.prepare(
    `SELECT substr(ts, 1, 10) AS day, source, provider, model, SUM(requests) AS requests, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
       SUM(CASE WHEN status = 'error' THEN requests ELSE 0 END) AS errors, SUM(CASE WHEN status = 'rate_limited' THEN requests ELSE 0 END) AS rate_limited
     FROM usage_log WHERE ts >= ? GROUP BY day, source, provider, model ORDER BY day DESC, provider, model LIMIT 2000`,
  ).bind(since).all();
  return json(withMeta({ days, usage: results ?? [] }));
}

// ---------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------

/** The (provider, model) pairs that the quota answer lists. */
async function knownPairs(env) {
  const since = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const pairs = new Set();
  const add = (p, m) => pairs.add(`${p}\u0000${m}`);
  for (const t of ['usage_log', 'ops_health']) {
    const col = t === 'usage_log' ? 'ts' : 'checked_at';
    const { results } = await env.DB.prepare(`SELECT DISTINCT provider, model FROM ${t} WHERE ${col} >= ?`).bind(since).all();
    for (const r of results ?? []) add(r.provider, r.model);
  }
  const seen = new Set([...pairs].map((k) => k.split('\u0000')[0]));
  for (const p of PROVIDERS) if (!seen.has(p.id)) add(p.id, '*');
  return [...pairs].map((k) => k.split('\u0000')).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

/** The whole quota table. Exported for the mirror script and the tests. */
export async function buildQuotaTable(env, now = new Date()) {
  const month = monthStart(now).toISOString();
  const { results: usage } = await env.DB.prepare('SELECT provider, model, requests, ts FROM usage_log WHERE ts >= ?').bind(month).all();
  const { results: states } = await env.DB.prepare('SELECT * FROM quota_state').all();
  const rows = usage ?? [];
  const out = {};
  for (const [provider, model] of await knownPairs(env)) {
    const found = resolveLimit(provider, model);
    const win = dayWindow(found?.provider.reset ?? 'utc-midnight', now);
    const scope = found?.entry.scope ?? 'model';
    const matcher = matcherFor(found?.matched ?? '*', scope, model);
    const dayStart = win.start.toISOString();
    const mine = (s) => s.provider === provider && matcher(s.model);
    const blockedList = (states ?? []).filter(mine).map((s) => s.blocked_until).filter(Boolean).sort();
    const obsRow = (states ?? []).filter((s) => mine(s) && s.observed_at).sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1))[0];
    const quota = computeQuota({
      provider, model, now,
      usage: {
        day: sumRequests(rows, { provider, matcher, since: dayStart }),
        month: sumRequests(rows, { provider, matcher, since: month }),
        blockedUntil: blockedList.at(-1) ?? null,
        observed: obsRow ? { remainingRequests: obsRow.observed_remaining_requests, remainingTokens: obsRow.observed_remaining_tokens, observedAt: obsRow.observed_at, usedDayAtObservation: obsRow.used_day_at_observation } : undefined,
      },
    });
    (out[provider] ??= {})[model] = quota;
  }
  return out;
}

/** GET /ops/quota */
export async function handleOpsQuota(c) {
  return json(withMeta({ providers: await buildQuotaTable(c.env) }));
}

// ---------------------------------------------------------------------
// Health, eval, hosts, doorbell
// ---------------------------------------------------------------------

export async function buildHealthTable(env) {
  const { results } = await env.DB.prepare('SELECT provider, model, status, latency_ms, checked_at, error_class FROM ops_health ORDER BY provider, model').all();
  const out = {};
  for (const r of results ?? []) (out[r.provider] ??= {})[r.model] = { status: r.status, latency_ms: r.latency_ms, checked_at: r.checked_at, error_class: r.error_class };
  return out;
}

export async function buildEvalTable(env) {
  const { results } = await env.DB.prepare('SELECT model, category, score, tasks_run, run_at, eval_version FROM ops_eval ORDER BY model, category').all();
  const out = {};
  for (const r of results ?? []) (out[r.model] ??= {})[r.category] = { score: r.score, tasks_run: r.tasks_run, run_at: r.run_at, eval_version: r.eval_version };
  return out;
}

export async function buildHostsTable(env) {
  const { results } = await env.DB.prepare('SELECT host, status, last_check, uptime_24h, uptime_7d, uptime_30d, last_pulse_at FROM ops_hosts ORDER BY host').all();
  const out = {};
  for (const r of results ?? []) {
    out[r.host] = { status: r.status, last_check: r.last_check, uptime_24h: r.uptime_24h, uptime_7d: r.uptime_7d, uptime_30d: r.uptime_30d };
    if (r.host === 'github_actions') out[r.host].last_pulse_at = r.last_pulse_at;
  }
  return out;
}

export const handleOpsHealth = async (c) => json(withMeta({ providers: await buildHealthTable(c.env) }));
export const handleOpsEval = async (c) => json(withMeta({ models: await buildEvalTable(c.env) }));
export const handleOpsHosts = async (c) => json(withMeta({ hosts: await buildHostsTable(c.env) }));

/** Validate a body against a schema. Returns the value, or a 400 response that names every bad field. */
async function strictBody(request, schema) {
  const body = await readBody(request);
  if (body.error) return { response: body.error };
  const problems = validate(schema, body.value);
  if (problems.length > 0) {
    return { response: jsonError(400, 'invalid_body', 'The body does not match the schema.', { fields: [...new Set(problems.map(fieldOf))].slice(0, 20), problems: problems.slice(0, 20) }) };
  }
  return { value: body.value };
}

export async function handleOpsHealthPost(c) {
  const parsed = await strictBody(c.request, HEALTH_BODY);
  if (parsed.response) return parsed.response;
  await c.env.DB.batch(parsed.value.results.map((r) => c.env.DB.prepare(
    `INSERT INTO ops_health (provider, model, status, latency_ms, checked_at, error_class) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model) DO UPDATE SET status = excluded.status, latency_ms = excluded.latency_ms, checked_at = excluded.checked_at, error_class = excluded.error_class`,
  ).bind(r.provider, r.model, r.status, r.latency_ms ?? null, r.checked_at, r.error_class ?? null)));
  return json({ stored: parsed.value.results.length });
}

export async function handleOpsEvalPost(c) {
  const parsed = await strictBody(c.request, EVAL_BODY);
  if (parsed.response) return parsed.response;
  await c.env.DB.batch(parsed.value.results.map((r) => c.env.DB.prepare(
    `INSERT INTO ops_eval (model, category, score, tasks_run, run_at, eval_version) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(model, category) DO UPDATE SET score = excluded.score, tasks_run = excluded.tasks_run, run_at = excluded.run_at, eval_version = excluded.eval_version`,
  ).bind(r.model, r.category, r.score, r.tasks_run, r.run_at, r.eval_version)));
  return json({ stored: parsed.value.results.length });
}

export async function handleOpsHostsPost(c) {
  const parsed = await strictBody(c.request, HOSTS_BODY);
  if (parsed.response) return parsed.response;
  const now = nowIso();
  await c.env.DB.batch(parsed.value.checks.map((h) => c.env.DB.prepare(
    `INSERT INTO ops_hosts (host, status, last_check, uptime_24h, uptime_7d, uptime_30d, last_pulse_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET status = excluded.status, last_check = excluded.last_check, uptime_24h = excluded.uptime_24h, uptime_7d = excluded.uptime_7d,
       uptime_30d = excluded.uptime_30d, last_pulse_at = excluded.last_pulse_at, updated_at = excluded.updated_at`,
  ).bind(h.host, h.status, h.last_check, h.uptime_24h ?? null, h.uptime_7d ?? null, h.uptime_30d ?? null, h.last_pulse_at ?? null, now)));
  return json({ stored: parsed.value.checks.length });
}

export async function handleOpsDoorbellPost(c) {
  const parsed = await strictBody(c.request, DOORBELL_BODY);
  if (parsed.response) return parsed.response;
  await c.env.DB.prepare('INSERT INTO doorbell_log (job, status_code, at) VALUES (?, ?, ?)').bind(parsed.value.job, parsed.value.status_code, parsed.value.at).run();
  return json({ stored: 1 });
}

/** Retention for the ops tables. Run in the 6-hour cron. */
export async function pruneOps(env, now = new Date()) {
  const usage = await env.DB.prepare('DELETE FROM usage_log WHERE ts < ?').bind(new Date(now.getTime() - 40 * 86_400_000).toISOString()).run();
  const bell = await env.DB.prepare('DELETE FROM doorbell_log WHERE at < ?').bind(new Date(now.getTime() - 30 * 86_400_000).toISOString()).run();
  const state = await env.DB.prepare('DELETE FROM quota_state WHERE COALESCE(observed_at, last_429_at, \'\') < ? AND (blocked_until IS NULL OR blocked_until < ?)')
    .bind(new Date(now.getTime() - 40 * 86_400_000).toISOString(), now.toISOString()).run();
  return { usage_log: usage.meta?.changes ?? 0, doorbell_log: bell.meta?.changes ?? 0, quota_state: state.meta?.changes ?? 0 };
}

export { providerKey, QUOTAS };
