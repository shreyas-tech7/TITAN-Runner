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
    tasksState.tasks.push(
      scrubForState({
        id,
        type: isSelfImprove ? 'self-improve' : 'task',
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        title: redactString(issue.title ?? '').slice(0, 200),
        prompt: redactString(issue.body ?? '').slice(0, 8000),
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

  return { state: tasksState, added };
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

export default { syncIssuesIntoTasks, addManualTask };
