/**
 * @file Reviewer Gate, GitHub write policy (RT3). Pure and synchronous. No network, no files, no clock.
 *
 * Every write to GitHub passes through this policy before it leaves the process. A write is a comment, a label,
 * a new Issue, a pull request, a repository dispatch, an Actions secret, a commit, or a push. The policy:
 *
 *   1. names each kind of write. A request that fits no kind is blocked.
 *   2. limits each kind to this repository and to a fixed set of values (event types, label names, secret names).
 *   3. removes secret-shaped text and email addresses from every text field. The write still goes on.
 *   4. blocks a destructive git command, a force push, and a delete of a branch.
 *
 * `src/reviewer/githubGate.js` runs the runner side. `worker/src/lib/githubGate.js` runs the Worker side. Both use
 * this file, so the two cannot drift apart.
 */
import { SECRET_PATTERNS } from '../lib/redact.js';
import { classifyAction } from './policy.js';

/** The specific patterns. The two generic catch-alls are left out, because they match every commit hash. */
const TEXT_PATTERNS = SECRET_PATTERNS.slice(0, -2);

/** `repository_dispatch` event types that a workflow in this repo listens to. */
export const ALLOWED_DISPATCH_EVENTS = Object.freeze([
  'titan-pulse', 'spawn-subagent', 'provision-vm', 'provider-selftest', 'callback-ping',
]);

/** Labels that Runner may add. Names start with `titan-` or equal `host-alert`. */
export const LABEL_PATTERN = /^(?:titan-[a-z][a-z0-9-]{0,40}|host-alert)$/;

/** Labels that Runner may remove from an Issue. */
export const REMOVABLE_LABELS = Object.freeze(['titan-task']);

/** The only Actions secret names that a write may touch, besides the provider secrets of the catalog. */
export const EXTRA_SECRET_NAMES = Object.freeze(['TITAN_CALLBACK_TOKEN', 'TITAN_DIAG_PROBE']);

export const MAX_TEXT_CHARS = 60_000;
export const MAX_TITLE_CHARS = 256;

/**
 * @typedef {object} GateVerdict
 * @property {boolean} ok
 * @property {string} kind
 * @property {string|null} reason Why the write was blocked. Null when it is allowed.
 * @property {object|undefined} body The body to send. Text fields are cleaned.
 * @property {number} redactions How many secret-shaped or email-shaped strings were removed.
 */

/** Replace secret-shaped strings and email addresses. Returns the clean text and the count. */
export function cleanText(text) {
  let out = String(text ?? '');
  let redactions = 0;
  for (const pattern of TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      redactions += 1;
      return '[REDACTED]';
    });
  }
  return { text: out, redactions };
}

function blocked(kind, reason) {
  return { ok: false, kind, reason, body: undefined, redactions: 0 };
}

function cleanField(value, max, field) {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  if (value.length > max) return { error: `${field} is longer than ${max} characters` };
  const cleaned = cleanText(value);
  return { text: cleaned.text, redactions: cleaned.redactions };
}

/**
 * Check one REST write. `path` is the API path, such as `/repos/owner/repo/issues/12/comments`.
 * @param {{ method: string, path: string, body?: any }} request
 * @param {{ repository: string, secretNames?: Iterable<string> }} ctx `repository` is `owner/name`.
 * @returns {GateVerdict}
 */
export function checkRestWrite(request, ctx) {
  const method = String(request?.method ?? '').toUpperCase();
  const path = String(request?.path ?? '').split('?')[0];
  const body = request?.body && typeof request.body === 'object' ? request.body : {};
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return blocked('none', `${method || 'a request'} is not a write method`);

  const base = `/repos/${ctx.repository}`;
  if (!path.startsWith(`${base}/`)) return blocked('foreign', 'a write may target only this repository');
  const rest = path.slice(base.length);
  const secretNames = new Set([...(ctx.secretNames ?? []), ...EXTRA_SECRET_NAMES]);

  let m;
  // Comment on an Issue or pull request.
  if (method === 'POST' && (m = rest.match(/^\/issues\/(\d+)\/comments$/))) {
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'body')) return blocked('comment', 'a comment may carry only a body');
    const f = cleanField(body.body, MAX_TEXT_CHARS, 'body');
    if (f.error) return blocked('comment', f.error);
    return { ok: true, kind: 'comment', reason: null, body: { body: f.text }, redactions: f.redactions };
  }

  // Open an Issue.
  if (method === 'POST' && rest === '/issues') {
    if (Object.keys(body).some((k) => !['title', 'body', 'labels'].includes(k))) return blocked('create_issue', 'unknown field in the Issue');
    const title = cleanField(body.title, MAX_TITLE_CHARS, 'title');
    if (title.error) return blocked('create_issue', title.error);
    const text = cleanField(body.body ?? '', MAX_TEXT_CHARS, 'body');
    if (text.error) return blocked('create_issue', text.error);
    const labels = body.labels ?? [];
    if (!Array.isArray(labels) || labels.length > 5 || !labels.every((l) => typeof l === 'string' && LABEL_PATTERN.test(l))) {
      return blocked('create_issue', 'labels must be titan-* names or host-alert, five at most');
    }
    return { ok: true, kind: 'create_issue', reason: null, body: { title: title.text, body: text.text, labels }, redactions: title.redactions + text.redactions };
  }

  // Close or reopen an Issue.
  if (method === 'PATCH' && (m = rest.match(/^\/issues\/(\d+)$/))) {
    if (Object.keys(body).some((k) => !['state', 'state_reason'].includes(k))) return blocked('update_issue', 'an Issue update may set only the state');
    if (!['open', 'closed'].includes(body.state)) return blocked('update_issue', 'state must be open or closed');
    if (body.state_reason !== undefined && !['completed', 'not_planned', 'reopened'].includes(body.state_reason)) return blocked('update_issue', 'unknown state_reason');
    return { ok: true, kind: 'update_issue', reason: null, body: { ...body }, redactions: 0 };
  }

  // Add labels.
  if (method === 'POST' && (m = rest.match(/^\/issues\/(\d+)\/labels$/))) {
    const labels = body.labels;
    if (!Array.isArray(labels) || labels.length === 0 || labels.length > 5 || !labels.every((l) => typeof l === 'string' && LABEL_PATTERN.test(l))) {
      return blocked('add_labels', 'labels must be titan-* names or host-alert, five at most');
    }
    return { ok: true, kind: 'add_labels', reason: null, body: { labels }, redactions: 0 };
  }

  // Remove one label.
  if (method === 'DELETE' && (m = rest.match(/^\/issues\/(\d+)\/labels\/([^/]+)$/))) {
    const name = decodeURIComponent(m[2]);
    if (!REMOVABLE_LABELS.includes(name)) return blocked('remove_label', `the label ${name} may not be removed`);
    return { ok: true, kind: 'remove_label', reason: null, body: undefined, redactions: 0 };
  }

  // Open a pull request. Only a draft from a self-improve branch into main.
  if (method === 'POST' && rest === '/pulls') {
    if (Object.keys(body).some((k) => !['title', 'head', 'base', 'body', 'draft'].includes(k))) return blocked('create_pr', 'unknown field in the pull request');
    if (body.draft !== true) return blocked('create_pr', 'a pull request from Runner must be a draft');
    if (typeof body.head !== 'string' || !/^self-improve\/[A-Za-z0-9._-]+$/.test(body.head)) return blocked('create_pr', 'the head branch must start with self-improve/');
    if (body.base !== 'main') return blocked('create_pr', 'the base branch must be main');
    const title = cleanField(body.title, MAX_TITLE_CHARS, 'title');
    if (title.error) return blocked('create_pr', title.error);
    const text = cleanField(body.body ?? '', MAX_TEXT_CHARS, 'body');
    if (text.error) return blocked('create_pr', text.error);
    const verdict = classifyAction({ toolId: 'github-create-pr', args: { head: body.head, base: body.base, title: body.title }, effect: 'external' });
    if (verdict.classification === 'destructive') return blocked('create_pr', `the pull request text looks destructive: ${verdict.reasons.join('; ')}`);
    return { ok: true, kind: 'create_pr', reason: null, body: { title: title.text, head: body.head, base: 'main', body: text.text, draft: true }, redactions: title.redactions + text.redactions };
  }

  // Close a pull request.
  if (method === 'PATCH' && (m = rest.match(/^\/pulls\/(\d+)$/))) {
    if (Object.keys(body).some((k) => k !== 'state') || body.state !== 'closed') return blocked('close_pr', 'a pull request may only be closed');
    return { ok: true, kind: 'close_pr', reason: null, body: { state: 'closed' }, redactions: 0 };
  }

  // Repository dispatch.
  if (method === 'POST' && rest === '/dispatches') {
    if (Object.keys(body).some((k) => !['event_type', 'client_payload'].includes(k))) return blocked('dispatch', 'unknown field in the dispatch');
    if (!ALLOWED_DISPATCH_EVENTS.includes(body.event_type)) return blocked('dispatch', `the event type ${String(body.event_type).slice(0, 40)} is not on the allowlist`);
    const payload = body.client_payload ?? {};
    if (typeof payload !== 'object' || Array.isArray(payload)) return blocked('dispatch', 'client_payload must be an object');
    const json = JSON.stringify(payload);
    if (json.length > 20_000) return blocked('dispatch', 'client_payload is too large');
    const cleaned = cleanText(json);
    let clean;
    try {
      clean = JSON.parse(cleaned.text);
    } catch {
      return blocked('dispatch', 'client_payload holds a secret-shaped string that could not be removed safely');
    }
    return { ok: true, kind: 'dispatch', reason: null, body: { event_type: body.event_type, client_payload: clean }, redactions: cleaned.redactions };
  }

  // Actions secrets.
  if ((method === 'PUT' || method === 'DELETE') && (m = rest.match(/^\/actions\/secrets\/([^/]+)$/))) {
    const name = decodeURIComponent(m[1]);
    if (!secretNames.has(name)) return blocked(method === 'PUT' ? 'put_secret' : 'delete_secret', `${name} is not a secret that Runner manages`);
    if (method === 'PUT' && (typeof body.encrypted_value !== 'string' || typeof body.key_id !== 'string' || Object.keys(body).some((k) => !['encrypted_value', 'key_id'].includes(k)))) {
      return blocked('put_secret', 'a secret write must carry only an encrypted value and a key id');
    }
    return { ok: true, kind: method === 'PUT' ? 'put_secret' : 'delete_secret', reason: null, body: method === 'PUT' ? { ...body } : undefined, redactions: 0 };
  }

  return blocked('unknown', `no rule allows ${method} ${rest.replace(/\d+/g, 'N').slice(0, 80)}`);
}

// ---------------------------------------------------------------------
// git
// ---------------------------------------------------------------------

/** A branch name that Runner may push to: the branch of the run, or a self-improve branch. */
export function isPushableRef(ref, currentRef) {
  if (typeof ref !== 'string' || ref.length === 0) return false;
  if (ref === currentRef && /^[A-Za-z0-9._/-]+$/.test(ref)) return true;
  return /^self-improve\/[A-Za-z0-9._-]+$/.test(ref);
}

/**
 * Check the arguments of a `git push`.
 * @param {string[]} args The arguments after `git push`, such as `['--quiet', 'origin', 'HEAD:main']`.
 * @param {{ currentRef: string }} ctx
 * @returns {GateVerdict}
 */
export function checkGitPush(args, ctx) {
  const list = args.map(String);
  const text = ['git', 'push', ...list].join(' ');
  const verdict = classifyAction({ toolId: 'git-push', args: { argv: list }, description: text, effect: 'external' });
  if (verdict.classification === 'destructive') return blocked('push', `blocked: ${verdict.reasons.join('; ')}`);
  const flags = list.filter((a) => a.startsWith('-'));
  const allowedFlags = new Set(['-q', '--quiet', '-u', '--set-upstream']);
  for (const f of flags) if (!allowedFlags.has(f)) return blocked('push', `the flag ${f} is not allowed on a push`);
  const positional = list.filter((a) => !a.startsWith('-'));
  if (positional[0] !== 'origin') return blocked('push', 'a push must go to origin');
  const refspec = positional[1];
  if (!refspec || positional.length > 2) return blocked('push', 'a push must name one refspec');
  if (refspec.startsWith(':') || refspec.startsWith('+')) return blocked('push', 'a delete or a forced refspec is not allowed');
  const target = refspec.includes(':') ? refspec.split(':')[1] : refspec;
  if (!isPushableRef(target, ctx.currentRef)) return blocked('push', `the branch ${String(target).slice(0, 60)} is not allowed`);
  return { ok: true, kind: 'push', reason: null, body: undefined, redactions: 0 };
}

/**
 * Check the files of a commit or a push. Every changed path must sit under an allowed root.
 * @param {string[]} paths
 * @param {{ roots: string[] }} ctx
 * @returns {GateVerdict}
 */
export function checkChangedPaths(paths, ctx) {
  const roots = ctx.roots.map((r) => (r.endsWith('/') ? r : `${r}/`));
  const bad = paths.filter((p) => {
    const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm.includes('..')) return true;
    return !roots.some((r) => norm.startsWith(r) || `${norm}/` === r);
  });
  if (bad.length > 0) return blocked('commit', `these paths are outside the allowed roots (${roots.join(', ')}): ${bad.slice(0, 5).join(', ')}`);
  return { ok: true, kind: 'commit', reason: null, body: undefined, redactions: 0 };
}

/**
 * Find secret-shaped strings in the added lines of a diff. Returns the pattern sources, never the values.
 * @param {string} diffText Output of `git diff -U0`.
 * @returns {string[]}
 */
export function findSecretsInDiff(diffText) {
  const hits = new Set();
  for (const line of String(diffText).split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const candidate = line.replace(/[A-Za-z0-9._%+-]+@users\.noreply\.github\.com/g, 'noreply-address');
    for (const pattern of TEXT_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(candidate)) hits.add(String(pattern));
    }
  }
  return [...hits];
}

/**
 * Check a command that runs on a remote machine, such as a railway.new VM.
 * @param {{ host: string, command: string, brief?: string }} request
 * @param {{ allowedHosts: string[] }} ctx
 * @returns {GateVerdict}
 */
export function checkVmCommand(request, ctx) {
  if (!ctx.allowedHosts.includes(request.host)) return blocked('vm_command', `the host ${String(request.host).slice(0, 60)} is not on the allowlist`);
  if (typeof request.command !== 'string' || request.command.length > 500) return blocked('vm_command', 'the command must be a string of 500 characters or less');
  const verdict = classifyAction({ toolId: 'railway-vm', args: { host: request.host, command: request.command }, description: `${request.command}\n${request.brief ?? ''}`, effect: 'external' });
  if (verdict.classification === 'destructive') return blocked('vm_command', `blocked: ${verdict.reasons.join('; ')}`);
  const cleaned = cleanText(`${request.command}\n${request.brief ?? ''}`);
  if (cleaned.redactions > 0) return blocked('vm_command', 'the command or brief holds a secret-shaped string, and a VM is untrusted');
  return { ok: true, kind: 'vm_command', reason: null, body: undefined, redactions: 0 };
}

export default { checkRestWrite, checkGitPush, checkChangedPaths, findSecretsInDiff, checkVmCommand, cleanText };
