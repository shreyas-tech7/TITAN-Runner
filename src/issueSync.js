/**
 * @file Task intake and issue-driven control — GitHub Issues as the queue
 * and as the authenticated control surface.
 *
 * Intake: an open issue labeled `titan-task` becomes a pending task; one
 * additionally labeled `titan-self-improve` routes to the self-improve PR
 * flow. Issue title/body are sanitized (`lib/redact.js`) before they reach
 * `state/tasks.json` — this repo is public.
 *
 * Authorization (docs/runner-upgrade/THREAT_MODEL.md): a label is not
 * authorization. Every issue is checked against `security/authorization.js`
 * before it can become a task, and every control command is checked the
 * same way. An unauthorized issue is ignored at zero model calls and zero
 * comments.
 *
 * Idempotency: a task carries a key derived from its type and normalised
 * text. A second submission with the same key while the first is live (or
 * finished within `duplicateWindowMs`) is cancelled as a duplicate instead
 * of running twice; the filer is told once, on the duplicate.
 *
 * Control: `/titan retry | cancel | pause | resume | priority <p> |
 * approve <step> | deny <step>` in an issue comment by an authorized
 * author, applied in order, each one audited as a `control.command` event.
 * The dashboard's own Retry marker comment is an alias for `/titan retry`.
 * `issueUpdatedAtSeen` remembers the last `updated_at` examined so a
 * stranger's chatter costs one comments fetch, not one per pulse.
 */
import { createHash } from 'node:crypto';
import { listOpenTaskIssues, listIssueComments } from './github.js';
import { config } from './config.js';
import { authorizeActor, authorizationContextFrom } from './security/authorization.js';
import { parseTitanCommand } from './control/commands.js';
import { transition, isTerminal, PRIORITIES } from './task/lifecycle.js';
import { taskDefaults } from './state/schema.js';
import { redactString } from './lib/redact.js';
import { scrubForState } from './lib/secretScrub.js';
import { parseTaskYaml } from './lib/taskYaml.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('issueSync');

const DEFAULT_DUPLICATE_WINDOW_MS = 24 * 3_600_000;

/**
 * @typedef {object} IntakeDeps
 * @property {(label?: string) => Promise<object[]>} [listIssues]
 * @property {(number: number, opts?: {since?: string|null}) => Promise<object[]>} [listComments]
 * @property {import('./security/authorization.js').AuthorizationContext} [authz]
 * @property {() => Date} [now]
 * @property {{ append: Function } | null} [events]
 * @property {number} [maxAttempts]
 * @property {number} [duplicateWindowMs]
 */

function defaultAuthz() {
  return authorizationContextFrom({
    taskAuthors: config.authorization.taskAuthors,
    repository: config.github.repository,
    trustCollaborators: config.authorization.trustCollaborators,
  });
}

/** sha256 of the normalised task text, truncated — stable across whitespace
 *  and case. Kept under 32 hex chars with a prefix so the redaction layer's
 *  generic "long hex run" pattern never mistakes it for a credential. */
export function idempotencyKeyFor(type, title, prompt) {
  const normalised = `${type}\n${String(title).trim().toLowerCase()}\n${String(prompt).replace(/\s+/g, ' ').trim().toLowerCase()}`;
  return `idem-${createHash('sha256').update(normalised).digest('hex').slice(0, 20)}`;
}

/**
 * @param {object[]} tasks
 * @param {string} key
 * @param {number} nowMs
 * @param {number} windowMs
 * @returns {object|null} A live or recently finished task with the same key.
 */
function findDuplicate(tasks, key, nowMs, windowMs) {
  for (const t of tasks) {
    if (t.idempotencyKey !== key || t.status === 'cancelled') continue;
    if (!isTerminal(t.status)) return t;
    const done = Date.parse(t.completedAt ?? '');
    if (Number.isFinite(done) && nowMs - done <= windowMs) return t;
  }
  return null;
}

/**
 * Pull open `titan-task` issues and add any not already tracked as new
 * pending entries. Mutates and returns the state. Issues whose author is
 * not authorized are ignored — counted, never commented on, never handed
 * to a model.
 * @param {object} tasksState
 * @param {IntakeDeps} [deps]
 * @returns {Promise<{ state: object, added: number, ignored: number, ignoredIssues: number[], duplicates: string[], issues: object[] }>}
 */
export async function syncIssuesIntoTasks(tasksState, deps = {}) {
  const listIssues = deps.listIssues ?? listOpenTaskIssues;
  const authz = deps.authz ?? defaultAuthz();
  const now = deps.now ?? (() => new Date());
  const events = deps.events ?? null;
  const windowMs = deps.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
  const issues = await listIssues('titan-task');
  const known = new Set(tasksState.tasks.map((t) => t.id));
  let added = 0;
  const ignoredIssues = [];
  const duplicates = [];

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
    const type = isSelfImprove ? 'self-improve' : 'task';

    // Task instructions, section 1: a task filed through the dashboard's
    // modal carries a machine-readable YAML block, and the pulse must parse
    // ONLY that — never scrape prose out of the body. An issue with no such
    // block falls back to the whole-body-as-prompt behavior, unchanged.
    const structured = parseTaskYaml(issue.body ?? '');
    const title = redactString(structured?.title ?? issue.title ?? '').slice(0, 200);
    const prompt = redactString(structured?.description ?? issue.body ?? '').slice(0, 8000);
    const createdAt = now().toISOString();
    const key = idempotencyKeyFor(type, title, prompt);

    const task = scrubForState({
      ...taskDefaults({ maxAttempts: deps.maxAttempts }),
      id,
      type,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      author: auth.login,
      title,
      prompt,
      priority: structured?.priority ?? 'normal',
      routingHint: structured?.routingHint ?? null,
      status: 'pending',
      createdAt,
      dependsOn: structured?.dependsOn ?? [],
      deadline: structured?.deadline ?? null,
      expiresAt: structured?.ttlHours ? new Date(now().getTime() + structured.ttlHours * 3_600_000).toISOString() : null,
      idempotencyKey: key,
      // Start the control cursor at the issue's creation so a command posted
      // between filing and the first pulse is still examined once.
      issueUpdatedAtSeen: issue.created_at ?? null,
    });

    const duplicateOf = findDuplicate(tasksState.tasks, key, now().getTime(), windowMs);
    if (duplicateOf) {
      task.status = 'pending';
      tasksState.tasks.push(task);
      transition(task, 'cancelled', { now, events, by: 'intake', reason: `duplicate of ${duplicateOf.id}`, error: `Duplicate submission: identical to ${duplicateOf.id}${duplicateOf.issueUrl ? ` (${duplicateOf.issueUrl})` : ''}.` });
      task.duplicateOf = duplicateOf.id;
      duplicates.push(id);
      events?.append('intake.duplicate', { taskId: id, duplicateOf: duplicateOf.id, outcome: 'cancelled' });
      continue;
    }

    tasksState.tasks.push(task);
    added += 1;
    events?.append('intake.accepted', { taskId: id, taskType: type, priority: task.priority, dependsOn: task.dependsOn, authorizedBy: auth.reason });
    log.info('picked up new issue as a task', { id, title: issue.title, selfImprove: isSelfImprove, authorizedBy: auth.reason });
  }

  if (ignoredIssues.length > 0) {
    // Issue numbers only — never the title, body, or login of an unauthorized
    // filer, which would let a stranger put text into this repo's logs.
    log.warn('ignored issues from unauthorized authors (no model call, no comment)', { count: ignoredIssues.length, issues: ignoredIssues });
    events?.append('intake.ignored', { count: ignoredIssues.length, issues: ignoredIssues, outcome: 'unauthorized' });
  }

  return { state: tasksState, added, ignored: ignoredIssues.length, ignoredIssues, duplicates, issues };
}

/** States a closed issue can pre-empt. */
const PREEMPTABLE = new Set(['pending', 'waiting', 'paused']);

/**
 * Apply issue-driven control: cancel-by-close, and `/titan …` commands from
 * authorized commenters. Replaces the old "any updated_at bump is a retry".
 *
 * @param {object} tasksState
 * @param {Array<{number:number, updated_at?:string}>} openIssues
 * @param {IntakeDeps} [deps]
 * @returns {Promise<{ cancelled: number, retried: number, commands: number, rejectedCommands: number, commentsFetched: number, approvals: number }>}
 */
export async function reconcileIssueState(tasksState, openIssues, deps = {}) {
  const listComments = deps.listComments ?? listIssueComments;
  const authz = deps.authz ?? defaultAuthz();
  const now = deps.now ?? (() => new Date());
  const events = deps.events ?? null;
  const open = new Map(openIssues.map((i) => [i.number, i]));
  const counts = { cancelled: 0, retried: 0, commands: 0, rejectedCommands: 0, commentsFetched: 0, approvals: 0 };

  for (const task of tasksState.tasks) {
    if (task.issueNumber == null) continue;
    const openIssue = open.get(task.issueNumber);

    if (!openIssue && PREEMPTABLE.has(task.status)) {
      transition(task, 'cancelled', { now, events, by: 'issue-closed', reason: 'issue closed before the task ran', error: 'Cancelled from the dashboard — the originating issue was closed before this task ran.' });
      counts.cancelled += 1;
      continue;
    }
    if (!openIssue) continue;

    const updatedAt = Date.parse(openIssue.updated_at ?? '');
    // A task without a cursor (migrated from v1, or seeded) starts from the
    // moment it last finished — or was created — so old chatter is never
    // replayed as commands.
    const seenAt = Date.parse(task.issueUpdatedAtSeen ?? task.completedAt ?? task.createdAt ?? '');
    if (!Number.isFinite(updatedAt)) continue;
    if (Number.isFinite(seenAt) && updatedAt <= seenAt) continue; // already examined this bump

    const since = Number.isFinite(seenAt) ? new Date(seenAt).toISOString() : task.createdAt;
    const comments = await listComments(task.issueNumber, { since });
    counts.commentsFetched += 1;
    task.issueUpdatedAtSeen = openIssue.updated_at;

    const sinceMs = Date.parse(since);
    const completedMs = Date.parse(task.completedAt ?? '');
    for (const comment of comments) {
      const command = parseTitanCommand(comment?.body);
      if (!command) continue;
      const createdMs = Date.parse(comment?.created_at ?? '');
      if (Number.isFinite(sinceMs) && Number.isFinite(createdMs) && createdMs <= sinceMs) continue;
      // A retry refers to a finished run: one posted before the task
      // finished is about an earlier life and is not honoured now.
      if (command.verb === 'retry' && Number.isFinite(completedMs) && createdMs <= completedMs) continue;
      const auth = authorizeActor(comment, authz);
      if (!auth.ok) {
        counts.rejectedCommands += 1;
        events?.append('control.rejected', { taskId: task.id, verb: command.verb, outcome: 'unauthorized' });
        continue;
      }
      const outcome = applyCommand(task, command, { now, events, by: auth.login });
      counts.commands += 1;
      if (outcome === 'retried') counts.retried += 1;
      if (outcome === 'approval-recorded') counts.approvals += 1;
      events?.append('control.command', { taskId: task.id, verb: command.verb, args: command.args, by: auth.login, outcome, audit: true });
    }
  }

  if (counts.rejectedCommands > 0) {
    log.warn('ignored control commands from unauthorized commenters', { count: counts.rejectedCommands });
  }
  return counts;
}

/**
 * One authorized command against one task. Pure state change through the
 * lifecycle; the engine reads approvals and cancel requests at step
 * boundaries.
 * @returns {string} outcome label for the audit event
 */
export function applyCommand(task, command, ctx) {
  const base = { now: ctx.now, events: ctx.events, by: ctx.by };
  switch (command.verb) {
    case 'retry':
      if (isTerminal(task.status)) {
        task.attempts = 0;
        transition(task, 'pending', { ...base, reason: `retry requested by ${ctx.by}` });
        task.retriedBy = ctx.by;
        return 'retried';
      }
      return 'ignored-not-terminal';
    case 'cancel':
      if (PREEMPTABLE.has(task.status)) {
        transition(task, 'cancelled', { ...base, reason: `cancelled by ${ctx.by}`, error: `Cancelled by ${ctx.by}.` });
        return 'cancelled';
      }
      if (task.status === 'running') {
        task.cancelRequested = true; // honoured at the next step boundary
        return 'cancel-requested';
      }
      return 'ignored';
    case 'pause':
      if (task.status === 'pending' || task.status === 'waiting') {
        transition(task, 'paused', { ...base, reason: `paused by ${ctx.by}` });
        return 'paused';
      }
      if (task.status === 'running') {
        task.pauseRequested = true;
        return 'pause-requested';
      }
      return 'ignored';
    case 'resume':
      if (task.status === 'paused') {
        transition(task, 'pending', { ...base, reason: `resumed by ${ctx.by}` });
        return 'resumed';
      }
      return 'ignored';
    case 'priority': {
      const p = String(command.args[0] ?? '').toLowerCase();
      if (!PRIORITIES.includes(p)) return 'ignored-bad-priority';
      task.priority = p;
      return `priority-${p}`;
    }
    case 'approve':
    case 'deny': {
      const step = String(command.args[0] ?? 'all').slice(0, 64);
      task.approvals = { ...(task.approvals ?? {}), [step]: { decision: command.verb === 'approve' ? 'approved' : 'denied', by: ctx.by, at: ctx.now().toISOString() } };
      if (task.status === 'waiting' && task.waitReason === 'approval') {
        transition(task, 'pending', { ...base, reason: `${command.verb} by ${ctx.by} for ${step}` });
      }
      return 'approval-recorded';
    }
    default:
      return 'ignored';
  }
}

/**
 * Adds a manually-dispatched task (workflow_dispatch's `task-text` input) —
 * not tied to any GitHub issue, so there is nothing to comment on or close.
 * Only a user with write access can dispatch a workflow, so this path is
 * authorized by GitHub itself.
 * @param {object} tasksState
 * @param {string} text
 * @param {{ now?: () => Date, events?: object|null, maxAttempts?: number }} [deps]
 */
export function addManualTask(tasksState, text, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const id = `manual-${now().getTime()}`;
  const title = redactString(text).slice(0, 120);
  const prompt = redactString(text).slice(0, 8000);
  tasksState.tasks.push(
    scrubForState({
      ...taskDefaults({ maxAttempts: deps.maxAttempts }),
      id,
      type: 'task',
      issueNumber: null,
      issueUrl: null,
      title,
      prompt,
      status: 'pending',
      createdAt: now().toISOString(),
      idempotencyKey: idempotencyKeyFor('task', title, prompt),
    }),
  );
  deps.events?.append('intake.accepted', { taskId: id, taskType: 'task', priority: 'normal', authorizedBy: 'workflow_dispatch' });
  return id;
}

export default { syncIssuesIntoTasks, reconcileIssueState, addManualTask, applyCommand, idempotencyKeyFor };
