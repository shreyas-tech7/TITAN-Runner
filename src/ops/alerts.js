/**
 * @file Open and close alert Issues through the gated GitHub client (RT3, RO5).
 *
 * An alert Issue has a label and a fixed title. `ensureAlert()` opens the Issue, or finds the open one and leaves it
 * alone, so a failing host never opens a second Issue. `resolveAlert()` closes it with one comment when the host is
 * back. GitHub notifies the owner of an Issue for free. The text carries host names only. It never carries a URL,
 * a key, or personal data: the gate removes secret-shaped text and email addresses from every body.
 */

/** @param {any} issue @param {string} title */
const sameTitle = (issue, title) => String(issue?.title ?? '') === title && !issue?.pull_request;

/**
 * @param {{ listIssuesByLabel: Function, createIssue: Function }} github
 * @param {{ label: string, title: string, body: string }} alert
 * @returns {Promise<{ action: 'opened'|'exists'|'skipped', number: number|null }>}
 */
export async function ensureAlert(github, alert) {
  const open = (await github.listIssuesByLabel(alert.label, 'open')) ?? [];
  const found = open.find((i) => sameTitle(i, alert.title));
  if (found) return { action: 'exists', number: found.number };
  const created = await github.createIssue(alert.title, alert.body, [alert.label]);
  if (!created) return { action: 'skipped', number: null }; // dry run, or no token
  return { action: 'opened', number: created.number ?? null };
}

/**
 * @param {{ listIssuesByLabel: Function, commentOnIssue: Function, closeIssue: Function }} github
 * @param {{ label: string, title: string, comment: string }} alert
 * @returns {Promise<{ action: 'closed'|'none', number: number|null }>}
 */
export async function resolveAlert(github, alert) {
  const open = (await github.listIssuesByLabel(alert.label, 'open')) ?? [];
  const found = open.find((i) => sameTitle(i, alert.title));
  if (!found) return { action: 'none', number: null };
  await github.commentOnIssue(found.number, alert.comment);
  await github.closeIssue(found.number);
  return { action: 'closed', number: found.number };
}

export default { ensureAlert, resolveAlert };
