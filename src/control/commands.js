/**
 * @file The `/titan …` command grammar — the authenticated control surface.
 *
 * A control action reaches Runner as an issue comment. GitHub authenticates
 * the commenter; `security/authorization.js` decides whether that commenter
 * may steer Runner; this file only parses. It is deliberately strict: a
 * command must be the first non-blank line of the comment, must start with
 * `/titan`, and must name a verb from the fixed table below. Anything else
 * (prose that happens to contain the word "retry", a quoted command inside a
 * code fence, a stranger's attempt at `/titan approve`) parses to `null` or
 * an unknown verb and changes nothing.
 *
 * The dashboard's own Retry button posts a marker comment ("**Retry
 * requested** from the TITAN-Runner dashboard …"); it is recognised as an
 * alias for `/titan retry` so the existing UI keeps working — still subject
 * to the same author check, since the dashboard posts with the visitor's own
 * PAT and GitHub records that visitor as the comment's author.
 */

/** @type {Readonly<Record<string, { args: number, description: string }>>} */
export const COMMANDS = Object.freeze({
  retry: { args: 0, description: 'Re-queue a finished, failed, blocked, cancelled, expired, or dead-lettered task.' },
  cancel: { args: 0, description: 'Cancel the task at the next step boundary (children included).' },
  pause: { args: 0, description: 'Pause the task at the next step boundary.' },
  resume: { args: 0, description: 'Resume a paused task.' },
  priority: { args: 1, description: 'Set priority: low | normal | high | urgent.' },
  approve: { args: 1, description: 'Approve a gated step by id (or "all").' },
  deny: { args: 1, description: 'Deny a gated step by id (or "all").' },
});

const DASHBOARD_RETRY_MARKER = /^\*\*Retry requested\*\* from the TITAN-Runner dashboard/;

/**
 * @param {unknown} body Raw comment body.
 * @returns {{ verb: string, args: string[], raw: string } | null}
 */
export function parseTitanCommand(body) {
  if (typeof body !== 'string') return null;
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (DASHBOARD_RETRY_MARKER.test(firstLine)) return { verb: 'retry', args: [], raw: firstLine };
  const match = firstLine.match(/^\/titan\s+([a-z]+)(?:\s+(.*))?$/i);
  if (!match) return null;
  const verb = match[1].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, verb)) return null;
  const args = (match[2] ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 4).map((a) => a.slice(0, 64));
  if (args.length < COMMANDS[verb].args) return null;
  return { verb, args, raw: firstLine.slice(0, 200) };
}

export default { parseTitanCommand, COMMANDS };
