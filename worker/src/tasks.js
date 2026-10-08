/**
 * @file Sub-agent tasks: intake, the dashboard list, the 1-minute dispatch, the stuck task reaper, and retry (Wave 12, K9).
 *
 * The Worker holds no long process. Each tick reads and writes a few D1 rows, then hands real work to a GitHub Actions
 * runner through `repository_dispatch`. This file keeps the old behavior of the dispatch loop. It adds `dispatched_at`,
 * the reaper, and the retry route.
 */
import { githubClient } from './lib/github.js';
import { json, jsonError, nowIso, readJson } from './lib/util.js';
import { emitEvent } from './notify.js';

/** A task that stays `dispatched` or `running` longer than this is marked `failed`. */
export const STUCK_AFTER_MINUTES = 25;

/** Task types that the dashboard route may never create. `osint` comes only from /osint/investigate. `meta-lesson` comes only from the meta-agent. */
export const RESERVED_TASK_TYPES = Object.freeze(['osint', 'meta-lesson']);

/** A task type is a short routing word. It becomes a workflow input, so it is checked and not passed through. */
export function parseTaskType(raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return { value: 'auto' };
  if (typeof raw !== 'string') return { error: 'task_type must be a string' };
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) return { error: 'task_type must be 1 to 40 characters: letters, digits, "-" or "_"' };
  if (RESERVED_TASK_TYPES.includes(value)) return { error: `task_type "${value}" is reserved` };
  return { value };
}

export async function handleStatus(env) {
  const subagents = await env.DB.prepare(
    `SELECT id, task_type, brief, status, source, provider, queued_at, dispatched_at, started_at, finished_at, result_summary, run_url, tokens_used, retry_count
     FROM subagents ORDER BY queued_at DESC LIMIT 100`,
  ).all();
  const providers = await env.DB.prepare('SELECT provider, configured, updated_at FROM provider_keys_meta ORDER BY provider ASC').all();
  const learningPaths = await env.DB.prepare('SELECT id, subagent_id, topic, tree, created_at FROM learning_paths ORDER BY created_at DESC LIMIT 50').all();
  return json({
    subagents: subagents.results,
    providers: providers.results,
    learningPaths: learningPaths.results,
    stuckAfterMinutes: STUCK_AFTER_MINUTES,
    generatedAt: nowIso(),
  });
}

export async function handleCreateTask(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const brief = typeof body?.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return json({ error: 'brief is required' }, 400);
  const parsedType = parseTaskType(body?.task_type);
  if ('error' in parsedType) return json({ error: parsedType.error }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO subagents (id, task_type, brief, status, source, queued_at) VALUES (?, ?, ?, 'queued', 'dashboard', ?)")
    .bind(id, parsedType.value, brief.slice(0, 4000), nowIso())
    .run();
  return json({ ok: true, id });
}

// ---------------------------------------------------------------------
// The scheduled tick: mirror issues, dispatch, reap
// ---------------------------------------------------------------------

/** GitHub-computed `author_association` values this Worker trusts. A label is not authorization on a public repo. */
export const TRUSTED_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function isTrustedIssueAuthor(issue, env) {
  const login = typeof issue?.user?.login === 'string' ? issue.user.login.toLowerCase() : '';
  if (!login || issue?.user?.type === 'Bot') return false;
  if (env?.GITHUB_OWNER && login === String(env.GITHUB_OWNER).toLowerCase()) return true;
  return TRUSTED_ASSOCIATIONS.includes(String(issue?.author_association ?? '').toUpperCase());
}

export async function mirrorGithubIssues(env) {
  if (!env.GITHUB_PAT) return { mirrored: 0 };
  let issues;
  try {
    issues = await githubClient(env).listIssues('labels=titan-task&state=open&per_page=20');
  } catch (err) {
    console.error('titan-runner-brain: issue mirror failed:', err instanceof Error ? err.message : err);
    return { mirrored: 0, error: true };
  }
  const now = nowIso();
  let mirrored = 0;
  for (const issue of issues) {
    if (issue.pull_request) continue; // the issues endpoint also returns pull requests with this label
    if (!isTrustedIssueAuthor(issue, env)) continue; // anyone can file a titan-task issue on a public repo
    const id = `gh-issue-${issue.number}`;
    const brief = `${issue.title ?? ''}\n\n${issue.body ?? ''}`.trim().slice(0, 4000);
    try {
      // task_type is fixed to 'auto' here and never comes from the issue text. That is why a public issue can never become an 'osint' task.
      const res = await env.DB.prepare("INSERT OR IGNORE INTO subagents (id, task_type, brief, status, source, queued_at) VALUES (?, 'auto', ?, 'queued', 'github-issue', ?)")
        .bind(id, brief, now)
        .run();
      mirrored += res.meta?.changes ?? 0;
    } catch (err) {
      console.error('titan-runner-brain: D1 insert failed for', id, err instanceof Error ? err.message : err);
    }
  }
  return { mirrored };
}

export async function dispatchQueuedTasks(env) {
  if (!env.GITHUB_PAT) return { dispatched: 0 };
  // The cap stays well under the 20 concurrent job ceiling of a GitHub account.
  const { results } = await env.DB.prepare("SELECT id, task_type, brief FROM subagents WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 5").all();
  const gh = githubClient(env);
  let dispatched = 0;
  for (const row of results) {
    try {
      await gh.dispatch('spawn-subagent', { id: row.id, task_type: row.task_type, brief: row.brief });
      await env.DB.prepare("UPDATE subagents SET status = 'dispatched', dispatched_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
      dispatched += 1;
    } catch (err) {
      // The row stays queued. The next tick, one minute away, tries again.
      console.error('titan-runner-brain: dispatch failed for', row.id, err instanceof Error ? err.message : err);
    }
  }
  return { dispatched };
}

const REASON_DISPATCHED =
  `The task was sent to GitHub Actions but did not report back in ${STUCK_AFTER_MINUTES} minutes. ` +
  'Probable causes: the callback was rejected because the token in the repo secrets does not match the Worker, the workflow did not start, or the run failed before it reported. ' +
  'Fix: open Settings and run Repair runner callbacks, check the spawn-subagent runs on the Actions tab, then use Retry.';

const REASON_RUNNING =
  `The task started but did not finish in ${STUCK_AFTER_MINUTES} minutes. ` +
  'Probable causes: the run reached its 10 minute limit, or the final callback was rejected. ' +
  'Fix: read the run log on the Actions tab, run Repair runner callbacks in Settings, then use Retry.';

/**
 * Mark tasks that stay `dispatched` or `running` for too long as `failed`, with a clear reason. The age counts from
 * the start time, then from the dispatch time, then from the queue time. An old row without `dispatched_at` still ages.
 * @param {{ DB: any }} env
 * @param {Date} [now]
 * @returns {Promise<{ failed: Array<{ id: string, was: string }> }>}
 */
export async function reapStuckTasks(env, now = new Date()) {
  const cutoff = nowIso(new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000));
  const finished = nowIso(now);
  const failed = [];
  for (const [status, reason] of [['dispatched', REASON_DISPATCHED], ['running', REASON_RUNNING]]) {
    const { results } = await env.DB.prepare(
      `UPDATE subagents SET status = 'failed', finished_at = ?, result_summary = ?
       WHERE status = ? AND COALESCE(started_at, dispatched_at, queued_at) < ?
       RETURNING id`,
    )
      .bind(finished, reason, status, cutoff)
      .all();
    for (const row of results ?? []) failed.push({ id: row.id, was: status });
  }
  for (const f of failed.slice(0, 3)) {
    await emitEvent(env, { type: 'task.failed', severity: 'warn', title: 'A task did not report back', body: `Task ${f.id.slice(0, 12)} was ${f.was} for more than ${STUCK_AFTER_MINUTES} minutes.`, source: 'reaper', dedupeKey: `stuck:${f.id}` }, now).catch(() => null);
  }
  return { failed };
}

/**
 * POST /tasks/:id/retry. A failed task, or one that is stuck, goes back to `queued` with the old result cleared.
 * @param {{ env: any, requestId: string }} c
 */
export async function handleRetryTask(c, id) {
  const { env } = c;
  const row = await env.DB.prepare('SELECT id, status, COALESCE(started_at, dispatched_at, queued_at) AS since FROM subagents WHERE id = ?').bind(id).first();
  if (!row) return jsonError(404, 'not_found', 'No task has this id.');
  const stuck = ['dispatched', 'running'].includes(row.status) && Date.parse(row.since) < Date.now() - STUCK_AFTER_MINUTES * 60_000;
  if (row.status !== 'failed' && !stuck) return jsonError(409, 'not_retryable', `A task with the status "${row.status}" cannot be retried.`);
  await env.DB.prepare(
    `UPDATE subagents SET status = 'queued', started_at = NULL, finished_at = NULL, result_summary = NULL, run_url = NULL, provider = NULL,
       tokens_used = NULL, dispatched_at = NULL, retry_count = retry_count + 1 WHERE id = ?`,
  )
    .bind(id)
    .run();
  return json({ ok: true, id, status: 'queued', requestId: c.requestId });
}

/** POST /internal/status: the callback of a workflow run. */
export async function handleInternalStatus(request, env) {
  const parsed = await readJson(request, 16_384);
  if (!parsed.ok) return parsed.response;
  const { id, status, provider, result_summary: resultSummary, run_url: runUrl, tokens_used: tokensUsed } = parsed.value;
  const allowed = ['running', 'done', 'failed'];
  if (!id || !allowed.includes(status)) return json({ error: `id is required and status must be one of: ${allowed.join(', ')}` }, 400);

  const now = nowIso();
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
  const result = await env.DB.prepare(`UPDATE subagents SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (result.meta.changes === 0) return json({ error: `no subagent row with id "${id}"` }, 404);
  if (status === 'done' || status === 'failed') {
    await emitEvent(env, { type: status === 'done' ? 'task.done' : 'task.failed', severity: status === 'done' ? 'info' : 'warn', title: `Task ${status}`, body: typeof resultSummary === 'string' ? resultSummary.slice(0, 200) : undefined, source: 'subagent', dedupeKey: `task:${id}:${status}` }).catch(() => null);
  }
  return json({ ok: true });
}
