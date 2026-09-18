/**
 * @file Task intake — GitHub Issues as the queue (task instructions, section
 * D). An issue labeled `titan-task` is picked up by the next pulse; an issue
 * additionally labeled `titan-self-improve` is routed to the self-improve PR
 * flow (`src/selfImprove.js`) instead of an ordinary orchestration run.
 *
 * Issue title/body are sanitized (`lib/redact.js`) before they ever reach
 * `state/tasks.json` — this repo is public, and Shreyas may paste something
 * careless into an issue without thinking about it.
 *
 * Authorization (docs/runner-upgrade/THREAT_MODEL.md): a label is not
 * authorization. The task template applies `titan-task` for any GitHub user,
 * so every issue is checked against `security/authorization.js` before it
 * can become a task, and every retry/cancel is checked the same way. An
 * unauthorized issue is ignored at zero model calls and zero comments.
 */
import { listOpenTaskIssues, listIssueComments } from './github.js';
import { config } from './config.js';
import { authorizeActor, authorizationContextFrom } from './security/authorization.js';
import { parseTitanCommand } from './control/commands.js';
import { redactString } from './lib/redact.js';
import { scrubForState } from './lib/secretScrub.js';
import { parseTaskYaml } from './lib/taskYaml.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('issueSync');

/**
 * @typedef {object} IntakeDeps
 * @property {(label?: string) => Promise<object[]>} [listIssues]
 * @property {(number: number, opts?: {since?: string|null}) => Promise<object[]>} [listComments]
 * @property {import('./security/authorization.js').AuthorizationContext} [authz]
 * @property {() => Date} [now]
 */

function defaultAuthz() {
  return authorizationContextFrom({
    taskAuthors: config.authorization.taskAuthors,
    repository: config.github.repository,
    trustCollaborators: config.authorization.trustCollaborators,
  });
}

/**
 * Pull open `titan-task` issues and add any not already tracked in
 * `tasksState.tasks` as new pending entries. Mutates and returns the state.
 * Issues whose author is not authorized are ignored — counted, never
 * commented on, never handed to a model.
 * @param {object} tasksState
 * @param {IntakeDeps} [deps]
 * @returns {Promise<{ state: object, added: number, ignored: number, ignoredIssues: number[], issues: object[] }>}
 */
export async function syncIssuesIntoTasks(tasksState, deps = {}) {
  const listIssues = deps.listIssues ?? listOpenTaskIssues;
  const authz = deps.authz ?? defaultAuthz();
  const now = deps.now ?? (() => new Date());
  const issues = await listIssues('titan-task');
  const known = new Set(tasksState.tasks.map((t) => t.id));
  let added = 0;
  const ignoredIssues = [];

  for (const issue of issues) {
    // The issues endpoint also returns pull requests carrying the label;
    // a PR is never a task.
    if (issue.pull_request) continue;
    const id = `issue-${issue.number}`;
    if (known.has(id)) continue;

    const auth = authorizeActor(issue, authz);
    if (!auth.ok) {
      ignoredIssues.push(issue.number);
      continue;
    }

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
        author: auth.login,
        title: redactString(title).slice(0, 200),
        prompt: redactString(prompt).slice(0, 8000),
        priority: structured?.priority ?? null,
        routingHint: structured?.routingHint ?? null,
        status: 'pending',
        createdAt: now().toISOString(),
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
    log.info('picked up new issue as a task', { id, title: issue.title, selfImprove: isSelfImprove, authorizedBy: auth.reason });
  }

  if (ignoredIssues.length > 0) {
    // Issue numbers only — never the title, body, or login of an unauthorized
    // filer, which would let a stranger put text into this repo's logs.
    log.warn('ignored issues from unauthorized authors (no model call, no comment)', { count: ignoredIssues.length, issues: ignoredIssues });
  }

  return { state: tasksState, added, ignored: ignoredIssues.length, ignoredIssues, issues };
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
 *     Only the issue's author or a collaborator can close an issue, and the
 *     author was authorized at intake, so no further check is needed.
 *   - **Retry** used to be "the issue was updated after the task finished".
 *     Anyone can comment on a public issue, so that was a way for a stranger
 *     to re-run a finished task at the owner's expense. Now a retry needs an
 *     explicit command (`/titan retry`, or the dashboard's own marker
 *     comment) posted after `completedAt` by an authorized author. The
 *     `updated_at` bump is only the cheap hint that says "worth fetching the
 *     comments"; `issueUpdatedAtSeen` remembers the last bump examined so a
 *     stranger's chatter does not cost a comments fetch on every pulse.
 *
 * @param {object} tasksState
 * @param {Array<{number:number, updated_at?:string}>} openIssues Exactly
 *   what `listOpenTaskIssues()` already fetched this pulse — no second
 *   GitHub API call needed for the cancel half.
 * @param {IntakeDeps} [deps]
 * @returns {Promise<{ cancelled: number, retried: number, commentsFetched: number, rejectedCommands: number }>}
 */
export async function reconcileIssueState(tasksState, openIssues, deps = {}) {
  const listComments = deps.listComments ?? listIssueComments;
  const authz = deps.authz ?? defaultAuthz();
  const now = deps.now ?? (() => new Date());
  const open = new Map(openIssues.map((i) => [i.number, i]));
  let cancelled = 0;
  let retried = 0;
  let commentsFetched = 0;
  let rejectedCommands = 0;

  for (const task of tasksState.tasks) {
    if (task.issueNumber == null) continue;
    const openIssue = open.get(task.issueNumber);

    if (!openIssue && PREEMPTABLE_STATUSES.has(task.status)) {
      task.status = 'cancelled';
      task.completedAt = now().toISOString();
      task.error = 'Cancelled from the dashboard — the originating issue was closed before this task ran.';
      cancelled += 1;
      continue;
    }

    if (openIssue && RETRIABLE_STATUSES.has(task.status) && task.completedAt) {
      const updatedAt = Date.parse(openIssue.updated_at ?? '');
      const completedAt = Date.parse(task.completedAt);
      const seenAt = Date.parse(task.issueUpdatedAtSeen ?? '');
      if (!Number.isFinite(updatedAt) || !Number.isFinite(completedAt) || updatedAt <= completedAt) continue;
      if (Number.isFinite(seenAt) && updatedAt <= seenAt) continue; // already examined this bump

      const comments = await listComments(task.issueNumber, { since: task.completedAt });
      commentsFetched += 1;
      task.issueUpdatedAtSeen = openIssue.updated_at;

      let authorizedRetry = null;
      for (const comment of comments) {
        const command = parseTitanCommand(comment?.body);
        if (!command || command.verb !== 'retry') continue;
        if (Date.parse(comment?.created_at ?? '') <= completedAt) continue;
        const auth = authorizeActor(comment, authz);
        if (!auth.ok) {
          rejectedCommands += 1;
          continue;
        }
        authorizedRetry = { login: auth.login, reason: auth.reason };
      }
      if (!authorizedRetry) continue;

      task.status = 'pending';
      task.claimedAt = null;
      task.startedAt = null;
      task.completedAt = null;
      task.runId = null;
      task.error = null;
      task.retriedBy = authorizedRetry.login;
      retried += 1;
      log.info('retry command accepted', { taskId: task.id, by: authorizedRetry.login, because: authorizedRetry.reason });
    }
  }

  if (rejectedCommands > 0) {
    log.warn('ignored retry commands from unauthorized commenters', { count: rejectedCommands });
  }

  return { cancelled, retried, commentsFetched, rejectedCommands };
}

/**
 * Adds a manually-dispatched task (workflow_dispatch's `task-text` input) —
 * not tied to any GitHub issue, so there is nothing to comment on or close.
 * Only a user with write access can dispatch a workflow, so this path is
 * authorized by GitHub itself.
 * @param {object} tasksState
 * @param {string} text
 * @param {{ now?: () => Date }} [deps]
 */
export function addManualTask(tasksState, text, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const id = `manual-${now().getTime()}`;
  tasksState.tasks.push(
    scrubForState({
      id,
      type: 'task',
      issueNumber: null,
      issueUrl: null,
      author: null,
      title: redactString(text).slice(0, 120),
      prompt: redactString(text).slice(0, 8000),
      priority: null,
      routingHint: null,
      status: 'pending',
      createdAt: now().toISOString(),
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
