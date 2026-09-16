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

const WORKER_URL = process.env.TITAN_WORKER_URL;
const ADMIN_TOKEN = process.env.TITAN_ADMIN_TOKEN;
const SUBAGENT_ID = process.env.TITAN_SUBAGENT_ID;
const RAW_TASK_TYPE = (process.env.TITAN_SUBAGENT_TASK_TYPE || 'auto').trim();
const BRIEF = process.env.TITAN_SUBAGENT_BRIEF || '';
const RUN_URL = process.env.GITHUB_RUN_URL || '';

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

  const service = RAW_TASK_TYPE === 'any' || !RAW_TASK_TYPE ? 'auto' : RAW_TASK_TYPE;
  if (service !== 'auto' && !FAILOVER_ORDER.includes(service)) {
    const summary = `no adapter for task_type "${safe(RAW_TASK_TYPE)}" — this cluster only reuses this repo's existing adapters: ${FAILOVER_ORDER.join(', ')}, or "auto"`;
    console.error(`run-subagent-task: ${summary}`);
    await reportStatus({ status: 'failed', result_summary: summary, run_url: RUN_URL });
    process.exitCode = 1;
    return;
  }

  try {
    const result = await registry.chat([{ role: 'user', content: BRIEF }], { service });
    const summary = safe(result.text).replace(/\s+/g, ' ').trim().slice(0, 1800);
    console.log(`run-subagent-task: completed via ${result.service}/${result.model} in ${result.latencyMs}ms`);
    await reportStatus({ status: 'done', provider: result.service, result_summary: summary, run_url: RUN_URL });
  } catch (err) {
    const message = safe(err instanceof Error ? err.message : err).slice(0, 1800);
    console.error('run-subagent-task: task failed:', message);
    await reportStatus({ status: 'failed', result_summary: message, run_url: RUN_URL });
    process.exitCode = 1;
  }
}

await main();
