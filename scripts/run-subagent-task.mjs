#!/usr/bin/env node
/**
 * @file One-shot sub-agent task runner. Invoked by
 * `.github/workflows/spawn-subagent.yml` on `repository_dispatch:
 * spawn-subagent`, fired by the titan-runner-brain Cloudflare Worker's
 * 1-minute cron tick. Does one unit of work and exits — nothing here is a
 * long-running or persistent process (task brief, section 3, step 6).
 *
 * Reuses `src/providers/registry.js`'s existing five-provider failover
 * exactly as `pulse.js` does; this script writes no new adapter and never
 * calls `providerHealth.save()`, so it never writes to `state/providers.json`
 * on disk — reading it (via `registry.chat` -> `base.js` -> `health.js`'s
 * lazy `load()`) only informs in-memory routing for this one call and is
 * discarded when the runner exits, which is what keeps this cluster from
 * ever colliding with the pre-existing 15-minute pulse's own state commits.
 *
 * `task_type` from the dispatch payload doubles as the routing hint: either
 * one of `registry.js`'s `FAILOVER_ORDER` ids (an explicit provider) or
 * `'auto'`/`'any'`/unset (full failover, fastest-first). Anything else is
 * marked `failed` with a clear reason rather than guessed at — see the
 * build brief's "Decisions made without asking" for why this mapping was
 * chosen over inventing a task-type taxonomy.
 *
 * Every brief runs past the same Reviewer Gate (`src/reviewer/`) `pulse.js`
 * already uses, before any provider is ever called — this cluster is a new
 * *dispatch* path, not a new *execution* path, and constraint 2 of the
 * build brief ("do not weaken, bypass, or remove the existing reviewer/
 * safety gate") applies to it exactly as it does to the 15-minute pulse.
 * A `titan-task`-labeled issue can be filed by anyone, since this repo is
 * public — the gate is what stands between that and a live provider call.
 */
import { registry, FAILOVER_ORDER } from '../src/providers/registry.js';
import { scrubForState } from '../src/lib/secretScrub.js';
import { reviewAction } from '../src/reviewer/index.js';
import { parseProbeJson } from '../src/orchestrator/capabilityRegistry.js';

const WORKER_URL = process.env.TITAN_WORKER_URL;
const ADMIN_TOKEN = process.env.TITAN_ADMIN_TOKEN;
const SUBAGENT_ID = process.env.TITAN_SUBAGENT_ID;
const RAW_TASK_TYPE = (process.env.TITAN_SUBAGENT_TASK_TYPE || 'auto').trim();
const BRIEF = process.env.TITAN_SUBAGENT_BRIEF || '';
const RUN_URL = process.env.GITHUB_RUN_URL || '';

/** Task types this cluster gives special handling beyond "route to a
 * named provider" — neither is one of registry.js's FAILOVER_ORDER ids,
 * so both route as full failover ('auto') rather than being rejected as
 * an unknown adapter. 'osint' is built exclusively by POST /osint/investigate
 * (see worker/src/index.js); 'meta-lesson' is built exclusively by
 * worker/src/meta-agent.js. */
const SPECIAL_TASK_TYPES = ['osint', 'meta-lesson'];

/** Every string here passes through `scrubForState` before it can reach a
 * console line or the Worker callback — the sub-agent's result_summary
 * ends up on the dashboard, which is exactly as world-readable as
 * `state/*.json` (see README's Security section), so the same "content
 * survives, secrets don't" rule applies. */
function safe(value) {
  return scrubForState(String(value ?? ''));
}

async function reportStatus(patch) {
  if (!WORKER_URL || !ADMIN_TOKEN || !SUBAGENT_ID) {
    console.error(
      'run-subagent-task: TITAN_WORKER_URL / TITAN_ADMIN_TOKEN / dispatch id not set — cannot report status back to the Worker.',
    );
    return;
  }
  try {
    const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/internal/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Titan-Auth': ADMIN_TOKEN },
      body: JSON.stringify({ id: SUBAGENT_ID, ...patch }),
    });
    if (!res.ok) console.error(`run-subagent-task: status callback rejected: ${res.status}`);
  } catch (err) {
    console.error('run-subagent-task: status callback errored:', safe(err instanceof Error ? err.message : err));
  }
}

/** Best-effort internal callback — never lets a reporting failure fail the
 * task itself, same spirit as reportStatus above. */
async function postInternal(path, body) {
  if (!WORKER_URL || !ADMIN_TOKEN) return;
  try {
    const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Titan-Auth': ADMIN_TOKEN },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`run-subagent-task: ${path} callback rejected: ${res.status}`);
  } catch (err) {
    console.error(`run-subagent-task: ${path} callback errored:`, safe(err instanceof Error ? err.message : err));
  }
}

/**
 * Phase 2 fallback: for an 'osint' task, the brief (built by
 * POST /osint/investigate) already instructs the model to answer in the
 * `{"summary", "location"}` shape below. Parsed defensively — the same
 * fenced/prose-wrapped-JSON tolerance capabilityRegistry.js's probe parser
 * already handles — and reported via /internal/geospatial-event only when
 * a location actually came back. That route re-validates this subagent id
 * is really a dashboard-sourced 'osint' row before it writes anything, so
 * this call is a report, not an authority.
 */
async function maybeReportGeospatialEvent(taskType, resultText) {
  if (taskType !== 'osint') return;
  const parsed = parseProbeJson(resultText);
  const location = parsed?.location;
  if (!location || typeof location !== 'object') return;
  const label = typeof location.label === 'string' ? location.label.trim().slice(0, 300) : '';
  if (!label) return;
  await postInternal('/internal/geospatial-event', {
    subagent_id: SUBAGENT_ID,
    label,
    lat: location.lat,
    lon: location.lon,
    ip: typeof location.ip === 'string' ? location.ip : null,
    confidence: location.confidence,
  });
}

/**
 * Phase 5 fallback: every future sub-agent task MUST read from
 * system_memory and prepend its lessons to its context window (task brief,
 * phase 5). Best-effort — an unreachable Worker or empty table just means
 * no lessons get prepended, never a failed task.
 * @returns {Promise<string>} A system-role prefix, or '' if there's nothing to prepend.
 */
async function fetchSystemMemoryPrefix() {
  if (!WORKER_URL || !ADMIN_TOKEN) return '';
  try {
    const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/system-memory`, {
      headers: { 'X-Titan-Auth': ADMIN_TOKEN },
    });
    if (!res.ok) return '';
    const { lessons } = await res.json();
    if (!Array.isArray(lessons) || lessons.length === 0) return '';
    const bullets = lessons.map((l) => `- ${l.prompt_injection}`).join('\n');
    return `Lessons learned from previous sub-agent runs — apply these:\n${bullets}`;
  } catch (err) {
    console.error('run-subagent-task: system-memory fetch failed (non-fatal):', safe(err instanceof Error ? err.message : err));
    return '';
  }
}

/**
 * Phase 5: for a 'meta-lesson' analysis task (queued exclusively by
 * worker/src/meta-agent.js), the brief already instructs the model to
 * respond in the `{category, lesson, promptInjection}` shape below. This
 * is the only place that ever posts to /internal/system-memory — the
 * Worker's own handler is what actually writes system_memory and its
 * audit row, this just supplies the analysis.
 */
async function maybeRecordSystemMemory(taskType, resultText) {
  if (taskType !== 'meta-lesson') return;
  const parsed = parseProbeJson(resultText);
  const category = typeof parsed?.category === 'string' ? parsed.category.trim() : '';
  const lesson = typeof parsed?.lesson === 'string' ? parsed.lesson.trim() : '';
  const promptInjection = typeof parsed?.promptInjection === 'string' ? parsed.promptInjection.trim() : '';
  if (!category || !lesson || !promptInjection) return;
  // meta-agent.js queues these with a deterministic id of `meta-<original id>`
  // — recovering the original id here is what lets the audit row name the
  // real triggering task, not this analysis task's own synthetic id.
  const triggeringTaskId = SUBAGENT_ID.startsWith('meta-') ? SUBAGENT_ID.slice('meta-'.length) : SUBAGENT_ID;
  await postInternal('/internal/system-memory', { category, lesson, promptInjection, triggeringTaskId });
}

/**
 * Phase 4 "learn anything" fallback. learn-anything.xyz has no public API
 * or queryable structured graph (see schema.sql's comment) — this builds
 * the dependency tree the same way capabilityRegistry.js already builds
 * capability probes, via one more structured-JSON call to this cluster's
 * own provider registry, using whichever provider is already configured.
 * Best-effort and independent of the task's own pass/fail reporting:
 * a failure here never turns an already-failed task into a crash.
 */
async function maybeBuildLearningPath(brief) {
  try {
    const gapPrompt =
      `A task failed: "${brief.slice(0, 400)}". Respond with STRICT JSON ONLY: ` +
      `{"knowledgeGap": string|null} — name the single specific domain/technology/skill ` +
      `an AI assistant would need to learn to complete this task, or null if the failure ` +
      `was unrelated to missing knowledge (e.g. a timeout or rate limit).`;
    const gapResult = await registry.chat([{ role: 'user', content: gapPrompt }], { service: 'auto', maxTokens: 200 });
    const gap = parseProbeJson(gapResult.text)?.knowledgeGap;
    if (typeof gap !== 'string' || !gap.trim()) return;
    const topic = gap.trim().slice(0, 200);

    const treePrompt =
      `Respond with STRICT JSON ONLY, matching exactly: {"topic": string, ` +
      `"prerequisites": [{"topic": string, "reason": string}], "resources": [string]}. ` +
      `Build a short (2-5 item) learning dependency tree for the topic "${topic}" — what an ` +
      `AI assistant would need to learn first, in order, and 1-3 real resource names/URLs.`;
    const treeResult = await registry.chat([{ role: 'user', content: treePrompt }], { service: 'auto', maxTokens: 500 });
    const tree = parseProbeJson(treeResult.text);
    if (!tree || typeof tree !== 'object' || !Array.isArray(tree.prerequisites)) return;

    await postInternal('/internal/learning-path', { subagent_id: SUBAGENT_ID, topic, tree });
  } catch (err) {
    console.error('run-subagent-task: learn-anything fallback failed (non-fatal):', safe(err instanceof Error ? err.message : err));
  }
}

async function main() {
  if (!SUBAGENT_ID) {
    console.error('run-subagent-task: no id in the dispatch payload — nothing to do.');
    process.exitCode = 1;
    return;
  }
  if (!BRIEF.trim()) {
    await reportStatus({ status: 'failed', result_summary: 'empty brief — nothing to run', run_url: RUN_URL });
    process.exitCode = 1;
    return;
  }

  await reportStatus({ status: 'running', run_url: RUN_URL });

  const review = await reviewAction({
    toolId: 'subagent-task',
    args: { task_type: RAW_TASK_TYPE },
    description: BRIEF,
    effect: 'external',
  });
  if (review.verdict === 'block') {
    const summary = `Blocked by the Reviewer Gate: ${safe(review.reason ?? 'no reason given')}`;
    console.error(`run-subagent-task: ${summary}`);
    await reportStatus({ status: 'failed', result_summary: summary.slice(0, 1800), run_url: RUN_URL });
    process.exitCode = 1;
    return;
  }

  const service = RAW_TASK_TYPE === 'any' || !RAW_TASK_TYPE || SPECIAL_TASK_TYPES.includes(RAW_TASK_TYPE) ? 'auto' : RAW_TASK_TYPE;
  if (service !== 'auto' && !FAILOVER_ORDER.includes(service)) {
    const summary = `no adapter for task_type "${safe(RAW_TASK_TYPE)}" — this cluster only reuses this repo's existing adapters: ${FAILOVER_ORDER.join(', ')}, or "auto"`;
    console.error(`run-subagent-task: ${summary}`);
    await reportStatus({ status: 'failed', result_summary: summary, run_url: RUN_URL });
    process.exitCode = 1;
    return;
  }

  const systemMemoryPrefix = await fetchSystemMemoryPrefix();
  const messages = systemMemoryPrefix
    ? [{ role: 'system', content: systemMemoryPrefix }, { role: 'user', content: BRIEF }]
    : [{ role: 'user', content: BRIEF }];

  try {
    const result = await registry.chat(messages, { service });
    const summary = safe(result.text).replace(/\s+/g, ' ').trim().slice(0, 1800);
    console.log(`run-subagent-task: completed via ${result.service}/${result.model} in ${result.latencyMs}ms`);
    await reportStatus({
      status: 'done',
      provider: result.service,
      result_summary: summary,
      run_url: RUN_URL,
      tokens_used: result.tokensUsed ?? undefined,
    });
    // Raw (unredacted-of-structure) text, not `summary` — scrubForState's
    // pattern scan can only blank credential-shaped substrings, not reshape
    // JSON, so the location parse needs the model's actual response body.
    await maybeReportGeospatialEvent(RAW_TASK_TYPE, result.text);
    await maybeRecordSystemMemory(RAW_TASK_TYPE, result.text);
  } catch (err) {
    const message = safe(err instanceof Error ? err.message : err).slice(0, 1800);
    console.error('run-subagent-task: task failed:', message);
    await reportStatus({ status: 'failed', result_summary: message, run_url: RUN_URL });
    await maybeBuildLearningPath(BRIEF);
    process.exitCode = 1;
  }
}

await main();
