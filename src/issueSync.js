/**
 * @file Task intake — GitHub Issues as the queue (task instructions, section
 * D). An issue labeled `titan-task` is picked up by the next pulse; an issue
 * additionally labeled `titan-self-improve` is routed to the self-improve PR
 * flow (`src/selfImprove.js`) instead of an ordinary orchestration run.
 *
 * Issue title/body are sanitized (`lib/redact.js`) before they ever reach
 * `state/tasks.json` — this repo is public, and Shreyas may paste something
 * careless into an issue without thinking about it.
 */
import { listOpenTaskIssues, listIssueComments, commentOnIssue, repoOwnerLogin, addLabels } from './github.js';
import { redactString } from './lib/redact.js';
import { scrubForState } from './lib/secretScrub.js';
import { parseTaskYaml } from './lib/taskYaml.js';
import { createLogger } from './lib/logger.js';

/** Terminal-ish statuses `/titan cancel` can still meaningfully pre-empt —
 *  deliberately broader than PREEMPTABLE_STATUSES below (issue-close
 *  cancel), since a comment command can also cancel a task that is
 *  actively `running`/`review`/`pr-open` right this pulse, not just one
 *  still queued. */
const CANCELLABLE_BY_COMMAND = new Set(['pending', 'claimed', 'running', 'review', 'pr-open']);

const log = createLogger('issueSync');

/**
 * Pull open `titan-task` issues and add any not already tracked in
 * `tasksState.tasks` as new pending entries. Mutates and returns the state.
 * @param {object} tasksState
 * @returns {Promise<{ state: object, added: number }>}
 */
export async function syncIssuesIntoTasks(tasksState) {
  const issues = await listOpenTaskIssues('titan-task');
  const known = new Set(tasksState.tasks.map((t) => t.id));
  let added = 0;

  for (const issue of issues) {
    const id = `issue-${issue.number}`;
    if (known.has(id)) continue;

    const isSelfImprove = (issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'titan-self-improve');

    // Task instructions, section 1: a task filed through the dashboard's
    // modal carries a machine-readable YAML block, and the pulse must parse
    // ONLY that — never scrape prose out of the body. An issue with no such
    // block (anything filed via the original GitHub issue template, or
    // directly on github.com, before this feature existed) falls back to
    // the pre-existing whole-body-as-prompt behavior, unchanged.
    const structured = parseTaskYaml(issue.body ?? '');
    const title = structured?.title ?? issue.title ?? '';
    const prompt = structured?.description ?? issue.body ?? '';

    tasksState.tasks.push(
      scrubForState({
        id,
        type: isSelfImprove ? 'self-improve' : 'task',
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        title: redactString(title).slice(0, 200),
        prompt: redactString(prompt).slice(0, 8000),
        priority: structured?.priority ?? null,
        routingHint: structured?.routingHint ?? null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        runId: null,
        prNumber: null,
        prUrl: null,
        error: null,
      }),
    );
    added += 1;
    log.info('picked up new issue as a task', { id, title: issue.title, selfImprove: isSelfImprove });
  }

  return { state: tasksState, added, issues };
}

/** Task states before any subtask work has actually started — the only
 *  ones a user's "cancel" (closing the issue) can meaningfully pre-empt.
 *  `state`/`running` never survive to a committed `state/tasks.json` (see
 *  `reconcileIssueState`'s header) but are included for defensiveness. */
const PREEMPTABLE_STATUSES = new Set(['pending', 'claimed']);
/** Task states a reopened + updated issue can restart from. */
const RETRIABLE_STATUSES = new Set(['complete', 'failed', 'blocked', 'cancelled']);

/**
 * Reconciles the dashboard's cancel/retry actions (task instructions,
 * section 1) — both of which act on the GitHub issue directly from the
 * browser, not on `state/tasks.json` (a static export has no way to write
 * that file itself). This is what makes those actions actually take effect
 * on the next pulse rather than being purely cosmetic:
 *
 *   - **Cancel** closes the issue. A task still `pending` whose issue is no
 *     longer in the open set is marked `cancelled` here — otherwise the
 *     next pulse would claim and run it anyway, oblivious to the close.
 *   - **Retry** reopens the issue and posts a comment (which bumps the
 *     issue's `updated_at`). A task already in a terminal state whose issue
 *     is open again AND was updated after the task's own `completedAt` is
 *     reset to `pending` for the next pulse to claim fresh — no special
 *     marker to parse, just "this finished task's issue changed after it
 *     finished."
 *
 * @param {object} tasksState
 * @param {Array<{number:number, updated_at?:string}>} openIssues Exactly
 *   what `listOpenTaskIssues()` already fetched this pulse — no second
 *   GitHub API call needed.
 * @returns {{ cancelled: number, retried: number }}
 */
export function reconcileIssueState(tasksState, openIssues) {
  const open = new Map(openIssues.map((i) => [i.number, i]));
  let cancelled = 0;
  let retried = 0;
  let approved = 0;

  for (const task of tasksState.tasks) {
    if (task.issueNumber == null) continue;
    const openIssue = open.get(task.issueNumber);

    if (!openIssue && PREEMPTABLE_STATUSES.has(task.status)) {
      task.status = 'cancelled';
      task.completedAt = new Date().toISOString();
      task.error = 'Cancelled from the dashboard — the originating issue was closed before this task ran.';
      cancelled += 1;
      continue;
    }

    // Human approval gate (task brief, Track D): a task the Reviewer Gate
    // parked with verdict `needs-human` (status `review`, issue labeled
    // `titan-review` — see pulse.js#processTask) sits here until a human
    // adds `titan-approved` to the issue. Nothing about this loop resets it
    // automatically otherwise — an ordinary reopen/comment (the RETRIABLE
    // branch below) never restarts a `review`-status task; only this label
    // does.
    if (openIssue && task.status === 'review' && hasLabel(openIssue, 'titan-approved')) {
      task.status = 'pending';
      task.claimedAt = null;
      task.startedAt = null;
      task.completedAt = null;
      task.error = null;
      approved += 1;
      continue;
    }

    if (openIssue && RETRIABLE_STATUSES.has(task.status) && task.completedAt) {
      const updatedAt = Date.parse(openIssue.updated_at ?? '');
      const completedAt = Date.parse(task.completedAt);
      if (Number.isFinite(updatedAt) && Number.isFinite(completedAt) && updatedAt > completedAt) {
        task.status = 'pending';
        task.claimedAt = null;
        task.startedAt = null;
        task.completedAt = null;
        task.runId = null;
        task.error = null;
        retried += 1;
      }
    }
  }

  return { cancelled, retried, approved };
}

/** @param {{labels?: Array<string|{name:string}>}} issue @param {string} name @returns {boolean} */
function hasLabel(issue, name) {
  return (issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === name);
}

/**
 * Adds a manually-dispatched task (workflow_dispatch's `task-text` input) —
 * not tied to any GitHub issue, so there is nothing to comment on or close.
 * @param {object} tasksState
 * @param {string} text
 */
export function addManualTask(tasksState, text) {
  const id = `manual-${Date.now()}`;
  tasksState.tasks.push(
    scrubForState({
      id,
      type: 'task',
      issueNumber: null,
      issueUrl: null,
      title: redactString(text).slice(0, 120),
      prompt: redactString(text).slice(0, 8000),
      priority: null,
      routingHint: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      claimedAt: null,
      startedAt: null,
      completedAt: null,
      runId: null,
      prNumber: null,
      prUrl: null,
      error: null,
    }),
  );
  return id;
}

/** Matches `/titan cancel`, `/titan retry`, `/titan status`, case-insensitive,
 *  allowing trailing whitespace/punctuation but nothing else on the line —
 *  a comment that merely mentions "/titan cancel" mid-sentence does not
 *  match (must be the whole first line). */
const COMMAND_PATTERN = /^\/titan\s+(cancel|retry|status)\s*[.!]?\s*$/i;

/**
 * `/titan cancel`, `/titan retry`, `/titan status` (task brief, Track D) —
 * restricted to the repo owner and validated against the actual comment
 * author, never trusted from the comment body/label alone. Processes at
 * most the single most recent unprocessed command comment on a task's
 * issue per call, and records `task.lastCommandProcessedAt` so the same
 * comment is never re-applied on a later pulse.
 * @param {object} task
 * @param {{ listIssueComments?: Function, commentOnIssue?: Function, addLabels?: Function,
 *   repoOwnerLogin?: Function }} [deps] Injectable for tests only —
 *   production uses the real github.js calls (which themselves no-op
 *   without a token/in dry-run — see github.js#ready()).
 * @returns {Promise<{ action: 'cancel'|'retry'|'status'|null }>}
 */
export async function processTitanCommands(task, deps = {}) {
  const _listIssueComments = deps.listIssueComments ?? listIssueComments;
  const _commentOnIssue = deps.commentOnIssue ?? commentOnIssue;
  const _addLabels = deps.addLabels ?? addLabels;
  const _repoOwnerLogin = deps.repoOwnerLogin ?? repoOwnerLogin;

  if (task.issueNumber == null) return { action: null };
  const owner = _repoOwnerLogin();
  if (!owner) return { action: null };

  const comments = await _listIssueComments(task.issueNumber);
  const since = task.lastCommandProcessedAt ?? task.createdAt ?? '1970-01-01T00:00:00.000Z';
  const sinceMs = Date.parse(since) || 0;

  const candidates = comments
    .filter((c) => c.user?.login?.toLowerCase() === owner.toLowerCase())
    .filter((c) => Date.parse(c.created_at ?? '') > sinceMs)
    .filter((c) => COMMAND_PATTERN.test((c.body ?? '').trim().split('\n')[0]))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  if (candidates.length === 0) return { action: null };

  const last = candidates[candidates.length - 1];
  const match = COMMAND_PATTERN.exec(last.body.trim().split('\n')[0]);
  const action = match[1].toLowerCase();
  task.lastCommandProcessedAt = last.created_at;

  if (action === 'cancel' && CANCELLABLE_BY_COMMAND.has(task.status)) {
    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    task.error = `Cancelled via /titan cancel by @${owner}.`;
    await _addLabels(task.issueNumber, ['titan-cancelled']);
    await _commentOnIssue(task.issueNumber, `Cancelled, as requested — this task will not be worked on further.`);
    return { action: 'cancel' };
  }

  if (action === 'retry' && (RETRIABLE_STATUSES.has(task.status) || task.status === 'review')) {
    task.status = 'pending';
    task.claimedAt = null;
    task.startedAt = null;
    task.completedAt = null;
    task.runId = null;
    task.error = null;
    await _commentOnIssue(task.issueNumber, `Queued for retry, as requested — the next pulse will pick this up fresh.`);
    return { action: 'retry' };
  }

  if (action === 'status') {
    await _commentOnIssue(
      task.issueNumber,
      [
        `**Status**: \`${task.status}\``,
        task.runId ? `**Last run**: \`${task.runId}\`` : null,
        task.error ? `**Last error**: ${redactString(task.error)}` : null,
      ].filter(Boolean).join('\n'),
    );
    return { action: 'status' };
  }

  // A valid command from the owner, but not applicable to this task's
  // current status (e.g. /titan retry on a task that's still pending) —
  // still consumed (lastCommandProcessedAt is already updated above) so it
  // is never silently retried forever against a status it can't apply to.
  return { action: null };
}

export default { syncIssuesIntoTasks, reconcileIssueState, addManualTask, processTitanCommands };
