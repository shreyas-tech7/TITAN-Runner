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
import { listOpenTaskIssues } from './github.js';
import { redactString } from './lib/redact.js';
import { scrubForState } from './lib/secretScrub.js';
import { parseTaskYaml } from './lib/taskYaml.js';
import { createLogger } from './lib/logger.js';

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

  return { cancelled, retried };
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

export default { syncIssuesIntoTasks, reconcileIssueState, addManualTask };
