/**
 * @file Hermes self-improvement loop (task brief, phase 5). Runs on its
 * own 6-hour cron trigger (see wrangler.toml's second `crons` entry and
 * index.js's `scheduled()` branching on `event.cron`) — much less frequent
 * than the 1-minute dispatch tick, since this is reflection over history,
 * not routing.
 *
 * Stays inside the Workers free-plan CPU budget the same way the rest of
 * this Worker does: it never calls an LLM itself, and it never writes
 * system_memory directly either. It only reads D1 for failed/inefficient
 * `subagents` rows not yet analyzed, and for each one, inserts a normal
 * `queued` subagents row with `task_type='meta-lesson'` — the existing
 * 1-minute `dispatchQueuedTasks()` tick then dispatches it exactly like
 * any other task, `spawn-subagent.yml` runs it on a real Node runtime,
 * and `scripts/run-subagent-task.mjs` (which has the provider registry)
 * does the actual analysis and posts the result to
 * `POST /internal/system-memory` — the only place that ever writes
 * `system_memory` or its audit trail. This file adds no new privileged
 * write path; it just decides *when* an analysis task is worth queuing.
 */

/** Longer than the 6h cron period, so a slightly late tick never skips a
 * task that finished right after the previous one ran. */
const LOOKBACK_HOURS = 8;
/** Never dispatch a storm of analysis tasks off one tick. */
const MAX_PER_RUN = 5;

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * A candidate is 'failed', or 'done' but took over 60s — a real outlier
 * against docs/RUNTIME.md's measured 1-5s-per-completion baseline for a
 * real provider call. Excludes rows already analyzed (a system_memory_audit
 * row already names them as the triggering task) and meta-lesson rows
 * themselves, so this never analyzes its own analysis tasks.
 * @param {object} env
 * @returns {Promise<object[]>}
 */
export async function findUnanalyzedCandidates(env) {
  const since = isoHoursAgo(LOOKBACK_HOURS);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.task_type, s.brief, s.status, s.result_summary, s.started_at, s.finished_at
     FROM subagents s
     WHERE s.finished_at IS NOT NULL AND s.finished_at > ?
       AND s.task_type != 'meta-lesson'
       AND (
         s.status = 'failed'
         OR (s.status = 'done' AND s.started_at IS NOT NULL
             AND (julianday(s.finished_at) - julianday(s.started_at)) * 86400 > 60)
       )
       AND NOT EXISTS (SELECT 1 FROM system_memory_audit a WHERE a.triggering_task_id = s.id)
     ORDER BY s.finished_at DESC
     LIMIT ?`,
  )
    .bind(since, MAX_PER_RUN)
    .all();
  return results;
}

/**
 * @param {{id:string, status:string, brief:string, result_summary:string|null}} row
 * @returns {string} The meta-lesson task's own brief — instructs
 *   run-subagent-task.mjs's registry.chat call to analyze the failure and
 *   respond in the strict JSON shape POST /internal/system-memory expects.
 */
function buildAnalysisBrief(row) {
  const outcome = row.status === 'failed' ? 'failed' : 'succeeded but was inefficient (took over 60 seconds)';
  return (
    `META-ANALYSIS. A sub-agent task ${outcome}. ` +
    `Original brief: "${String(row.brief ?? '').slice(0, 800)}". ` +
    `Outcome/result summary: "${String(row.result_summary ?? '').slice(0, 800)}". ` +
    `Respond with STRICT JSON ONLY, matching exactly: {"category": string, "lesson": string, ` +
    `"promptInjection": string}. "category" is a short tag (e.g. "rate-limits", ` +
    `"reviewer-gate", "prompt-clarity", "timeout"). "lesson" is one sentence describing what ` +
    `went wrong and why. "promptInjection" is a short (1-3 sentence) instruction future tasks ` +
    `should be given up front to avoid the same outcome.`
  );
}

/**
 * @param {object} env
 * @returns {Promise<{queued: number}>}
 */
export async function runMetaAgent(env) {
  const candidates = await findUnanalyzedCandidates(env);
  const now = new Date().toISOString();
  let queued = 0;
  for (const row of candidates) {
    try {
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO subagents (id, task_type, brief, status, source, queued_at) VALUES (?, 'meta-lesson', ?, 'queued', 'meta-agent', ?)`,
      )
        .bind(`meta-${row.id}`, buildAnalysisBrief(row), now)
        .run();
      if (result.meta.changes > 0) queued += 1;
    } catch (err) {
      console.error('meta-agent: failed to queue analysis for', row.id, err instanceof Error ? err.message : err);
    }
  }
  if (queued > 0) console.log(`meta-agent: queued ${queued} analysis task(s) of ${candidates.length} candidate(s).`);
  return { queued };
}

export default { runMetaAgent, findUnanalyzedCandidates };
