/**
 * @file Self-improvement, with a leash (task instructions, section F).
 *
 * The agent may propose changes to its own code, but it opens a pull
 * request — it never pushes code straight to main. State files and run
 * logs push directly (see `src/pulse.js`); code never does.
 *
 * Flow for one `type: 'self-improve'` task:
 *   1. Run the same decompose -> schedule -> synthesize pipeline as an
 *      ordinary task, treating the issue body as the master prompt. The
 *      synthesis's file list IS the proposed diff.
 *   2. Refuse outright if any proposed path is denylisted
 *      (`src/denylist.js`) — `.github/workflows/`, the reviewer gate, the
 *      secret-handling code, or the denylist itself.
 *   3. Run the proposed change past the Reviewer Gate as a `destructive`-
 *      capable action; a block ends this here, no branch is ever created.
 *   4. Create a branch, write only the proposed files, commit, push, and
 *      open a PR against `main` via the GitHub API. Never merge — a human
 *      (or `.github/workflows/ci.yml`'s own test-suite + denylist gate)
 *      decides mergeability from here.
 *
 * A later pulse (`checkSelfImprovePrStatus`) revisits any PR this flow
 * opened: if its CI has concluded failure, the pulse closes its own PR and
 * records the failure on the originating task — it never leaves a red PR
 * open pretending to be done.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { findDenylistViolations } from './denylist.js';
import { reviewAction } from './reviewer/reviewer.js';
import { createPullRequest, closePullRequest, getPullRequest, getCombinedStatus } from './github.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('selfImprove');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim();
}

/**
 * @param {{ id: string, prompt: string, title: string }} task
 * @param {{ files: Array<{path: string, content: string}> }} synthesis
 * @returns {Promise<{ status: 'pr-open'|'refused'|'blocked'|'no-changes', prNumber?: number, prUrl?: string, reason?: string }>}
 */
export async function proposeSelfImprovement(task, synthesis) {
  const files = synthesis.files.filter((f) => !f.conflict);
  if (files.length === 0) {
    return { status: 'no-changes', reason: 'The model produced no file changes for this task.' };
  }

  const violations = findDenylistViolations(files.map((f) => f.path));
  if (violations.length > 0) {
    log.warn('self-improve proposal touched denylisted paths — refusing', { taskId: task.id, violations });
    return { status: 'refused', reason: `Proposed change touches protected paths: ${violations.join(', ')}` };
  }

  const review = await reviewAction({
    toolId: 'self-improve-pr',
    args: { paths: files.map((f) => f.path), preview: files.map((f) => f.content.slice(0, 500)).join('\n---\n') },
    effect: 'external',
    description: `Self-improvement PR proposing changes to: ${files.map((f) => f.path).join(', ')}`,
  });
  if (review.verdict === 'block') {
    log.warn('reviewer blocked self-improve proposal', { taskId: task.id, reason: review.reason });
    return { status: 'blocked', reason: review.reason ?? 'Reviewer Gate blocked this change.' };
  }

  const branch = `self-improve/${task.id}-${Date.now()}`;
  const originalRef = git(['rev-parse', '--abbrev-ref', 'HEAD']);

  try {
    git(['checkout', '-b', branch]);
    for (const file of files) {
      const fullPath = join(process.cwd(), file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, 'utf8');
    }
    git(['add', ...files.map((f) => f.path)]);
    git(['-c', 'user.email=titan-runner@users.noreply.github.com', '-c', 'user.name=TITAN Runner', 'commit', '-m', `self-improve: ${task.title || task.id}`]);
    git(['push', '-u', 'origin', branch]);

    const pr = await createPullRequest({
      title: `[self-improve] ${task.title || task.id}`,
      head: branch,
      base: 'main',
      draft: true,
      body:
        `Proposed by TITAN-Runner's self-improvement flow, from ${task.issueUrl ? `${task.issueUrl}` : `task \`${task.id}\``}.\n\n` +
        `**This PR was opened by an automated pulse. It is never auto-merged.**\n\n` +
        `Reviewer Gate verdict: \`${review.verdict}\` (layer ${review.layer}, classification \`${review.classification}\`).\n\n` +
        `Files changed:\n${files.map((f) => `- \`${f.path}\``).join('\n')}\n\n` +
        `CI must pass (full test suite + the denylist check) before this is mergeable — see ` +
        `\`.github/workflows/ci.yml\`. A later pulse checks this PR's status and closes it, with a ` +
        `comment on the record, if CI ends up red.`,
    });

    return { status: 'pr-open', prNumber: pr?.number, prUrl: pr?.html_url, branch };
  } finally {
    try {
      git(['checkout', originalRef]);
    } catch (err) {
      log.error('failed to return to original branch after self-improve attempt', { error: String(err) });
    }
  }
}

/**
 * Revisit a previously-opened self-improve PR and close it if CI concluded
 * failure. Never merges a green one — that decision stays with a human.
 * @param {{ prNumber: number }} task
 * @returns {Promise<{ status: 'still-open'|'closed-failed'|'unknown' }>}
 */
export async function checkSelfImprovePrStatus(task) {
  if (!task.prNumber) return { status: 'unknown' };
  const pr = await getPullRequest(task.prNumber);
  if (!pr) return { status: 'unknown' };
  if (pr.merged) return { status: 'merged' };
  if (pr.state !== 'open') return { status: 'unknown' };

  const combined = await getCombinedStatus(pr.head.sha);
  if (combined === 'failure') {
    await closePullRequest(task.prNumber);
    log.info('closed self-authored PR after CI failure', { prNumber: task.prNumber });
    return { status: 'closed-failed' };
  }
  return { status: 'still-open' };
}

export default { proposeSelfImprovement, checkSelfImprovePrStatus };
