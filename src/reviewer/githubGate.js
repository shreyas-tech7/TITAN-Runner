/**
 * @file Reviewer Gate, GitHub write executor (RT3).
 *
 * This is the ONLY module in `src/`, `scripts/`, and `bin/` that sends a write to GitHub. A write is a REST call
 * with a POST, PUT, PATCH, or DELETE method, a `git commit`, or a `git push`. `test/github-write-boundary.test.js`
 * fails when any other file does one. Each function here checks the write with `githubGatePolicy.js` first. A write
 * that fails the check throws `GateBlockedError` and nothing leaves the machine.
 *
 * The gate also covers a command sent to a VM (`gateVmCommand`). The VM script calls it before `ssh`.
 *
 * The deterministic checks have no off switch. `TITAN_REVIEWER=0` turns off only the model layer of
 * `reviewAction()`, as before.
 */
import { execFileSync } from 'node:child_process';
import { reviewAction } from './reviewer.js';
import {
  checkChangedPaths, checkGitPush, checkRestWrite, checkVmCommand, cleanText, findSecretsInDiff,
} from './githubGatePolicy.js';
import { allSecretNames } from '../providers/catalog.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('github-gate');
const API_BASE = 'https://api.github.com';

export class GateBlockedError extends Error {
  /** @param {string} kind @param {string} reason */
  constructor(kind, reason) {
    super(`The Reviewer Gate blocked this ${kind} write: ${reason}`);
    this.name = 'GateBlockedError';
    this.code = 'GATE_BLOCKED';
    this.kind = kind;
    this.reason = reason;
  }
}

function record(events, type, fields) {
  try {
    events?.append(type, { ...fields, audit: true });
  } catch {
    // The event log never blocks a write decision.
  }
}

/**
 * Build the one function that sends REST writes.
 * @param {{ token: string, repository: string, fetchImpl?: typeof fetch, events?: { append: Function }|null, secretNames?: Iterable<string> }} opts
 * @returns {(method: string, path: string, body?: object) => Promise<any>}
 */
export function createRestWriter(opts) {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const secretNames = opts.secretNames ?? allSecretNames();
  return async function write(method, path, body) {
    const verdict = checkRestWrite({ method, path, body }, { repository: opts.repository, secretNames });
    if (!verdict.ok) {
      record(opts.events, 'gate.blocked', { kind: verdict.kind, reason: verdict.reason, outcome: 'blocked' });
      log.warn('write blocked', { kind: verdict.kind, reason: verdict.reason });
      throw new GateBlockedError(verdict.kind, verdict.reason);
    }
    if (verdict.redactions > 0) record(opts.events, 'gate.redacted', { kind: verdict.kind, count: verdict.redactions, outcome: 'cleaned' });
    const res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: verdict.body === undefined ? undefined : JSON.stringify(verdict.body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  };
}

// ---------------------------------------------------------------------
// git
// ---------------------------------------------------------------------

const IDENTITY = ['-c', 'user.name=titan-runner-bot', '-c', 'user.email=titan-runner@users.noreply.github.com'];

function defaultGit(cwd) {
  return (args, o = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...o }).trim();
}

/**
 * Commit what is staged. The staged files must sit under `roots`, and no added line may look like a secret.
 * @param {{ message: string, roots: string[]|null, cwd?: string, git?: (args: string[], o?: object) => string, events?: { append: Function }|null, identity?: string[] }} opts
 */
export function gatedCommit(opts) {
  const git = opts.git ?? defaultGit(opts.cwd ?? process.cwd());
  const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (staged.length === 0) throw new GateBlockedError('commit', 'nothing is staged');
  if (opts.roots) {
    const paths = checkChangedPaths(staged, { roots: opts.roots });
    if (!paths.ok) {
      record(opts.events, 'gate.blocked', { kind: 'commit', reason: paths.reason, outcome: 'blocked' });
      throw new GateBlockedError('commit', paths.reason);
    }
  }
  const secrets = findSecretsInDiff(git(['diff', '--cached', '-U0', '--no-color']));
  if (secrets.length > 0) {
    const reason = `an added line looks like a secret (${secrets.length} pattern${secrets.length === 1 ? '' : 's'} matched)`;
    record(opts.events, 'gate.blocked', { kind: 'commit', reason, outcome: 'blocked' });
    throw new GateBlockedError('commit', reason);
  }
  const message = cleanText(opts.message).text.slice(0, 500);
  return git([...(opts.identity ?? IDENTITY), 'commit', '-q', '-m', message]);
}

/**
 * Push `from` to `ref` on origin. Never forced. When `roots` is set, every file that differs from the remote branch
 * must sit under `roots`, and no added line may look like a secret.
 * @param {{ ref: string, from?: string, roots?: string[]|null, currentRef?: string, cwd?: string, git?: (args: string[], o?: object) => string, events?: { append: Function }|null }} opts
 */
export function gatedPush(opts) {
  const git = opts.git ?? defaultGit(opts.cwd ?? process.cwd());
  const from = opts.from ?? 'HEAD';
  const currentRef = opts.currentRef ?? process.env.GITHUB_REF_NAME ?? 'main';
  const args = ['--quiet', 'origin', `${from}:${opts.ref}`];
  const verdict = checkGitPush(args, { currentRef });
  if (!verdict.ok) {
    record(opts.events, 'gate.blocked', { kind: 'push', reason: verdict.reason, outcome: 'blocked' });
    throw new GateBlockedError('push', verdict.reason);
  }
  if (opts.roots) {
    let base = null;
    try {
      git(['fetch', '--quiet', 'origin', opts.ref]);
      base = `origin/${opts.ref}`;
    } catch {
      base = null; // a new branch: nothing to compare with, so the range check below is skipped
    }
    if (base) {
      const changed = git(['diff', '--name-only', `${base}..${from}`]).split('\n').filter(Boolean);
      const paths = checkChangedPaths(changed, { roots: opts.roots });
      if (!paths.ok) {
        record(opts.events, 'gate.blocked', { kind: 'push', reason: paths.reason, outcome: 'blocked' });
        throw new GateBlockedError('push', paths.reason);
      }
      const secrets = findSecretsInDiff(git(['diff', '-U0', '--no-color', `${base}..${from}`]));
      if (secrets.length > 0) {
        const reason = `a pushed line looks like a secret (${secrets.length} pattern${secrets.length === 1 ? '' : 's'} matched)`;
        record(opts.events, 'gate.blocked', { kind: 'push', reason, outcome: 'blocked' });
        throw new GateBlockedError('push', reason);
      }
    }
  }
  return git(['push', ...args]);
}

/**
 * Make a commit object from a tree and a parent, with plumbing. It does not move a branch. The files that the tree
 * holds are checked when the commit is pushed, by `gatedPush`.
 * @param {{ tree: string, parent: string, message: string, cwd?: string, git?: (args: string[], o?: object) => string, identity?: string[] }} opts
 */
export function gatedCommitTree(opts) {
  const git = opts.git ?? defaultGit(opts.cwd ?? process.cwd());
  const message = cleanText(opts.message).text.slice(0, 500);
  return git([...(opts.identity ?? IDENTITY), 'commit-tree', opts.tree, '-p', opts.parent, '-m', message]);
}

/**
 * Check out a new local branch. Local only, but the name must be a branch that `gatedPush` accepts.
 * @param {{ branch: string, cwd?: string, git?: (args: string[], o?: object) => string, currentRef?: string }} opts
 */
export function gatedCreateBranch(opts) {
  const git = opts.git ?? defaultGit(opts.cwd ?? process.cwd());
  const verdict = checkGitPush(['origin', `HEAD:${opts.branch}`], { currentRef: opts.currentRef ?? process.env.GITHUB_REF_NAME ?? 'main' });
  if (!verdict.ok) throw new GateBlockedError('branch', verdict.reason);
  return git(['checkout', '-b', opts.branch]);
}

// ---------------------------------------------------------------------
// VM commands
// ---------------------------------------------------------------------

export const VM_HOSTS = Object.freeze(['railway.new']);

/**
 * Put a command for a VM past the gate. Layer 1 (patterns, host allowlist, no secret-shaped text) always runs.
 * Layer 2 (the model) runs through `reviewAction` when the brief is not obviously safe.
 * @param {{ host: string, command: string, brief?: string }} request
 * @param {{ reviewerOpts?: object, events?: { append: Function }|null, hosts?: string[] }} [opts]
 * @returns {Promise<{ ok: boolean, reason: string|null }>}
 */
export async function gateVmCommand(request, opts = {}) {
  const layer1 = checkVmCommand(request, { allowedHosts: opts.hosts ?? [...VM_HOSTS, process.env.TITAN_RAILWAY_SSH_HOST].filter(Boolean) });
  if (!layer1.ok) {
    record(opts.events, 'gate.blocked', { kind: 'vm_command', reason: layer1.reason, outcome: 'blocked' });
    return { ok: false, reason: layer1.reason };
  }
  const review = await reviewAction({
    toolId: 'railway-vm',
    args: { host: request.host, command: request.command },
    description: request.brief || request.command,
    effect: 'external',
  }, opts.reviewerOpts ?? {});
  if (review.verdict === 'block') {
    record(opts.events, 'gate.blocked', { kind: 'vm_command', reason: review.reason ?? 'blocked by the reviewer', outcome: 'blocked' });
    return { ok: false, reason: review.reason ?? 'Reviewer Gate blocked this command.' };
  }
  return { ok: true, reason: null };
}

export default { createRestWriter, gatedCommit, gatedCommitTree, gatedPush, gatedCreateBranch, gateVmCommand, GateBlockedError };
