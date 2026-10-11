/**
 * @file Reviewer Gate for the Worker (RT3). Every write that the Worker sends to GitHub passes through here.
 *
 * Two paths write to GitHub:
 *   1. The Worker's own client (`lib/github.js`): secrets, repository dispatch, and Issue comments on this repo.
 *   2. The connector broker (`connectors/broker.js`): the `github` connector actions that a person approved.
 *
 * Both use the pure policy in `src/reviewer/githubGatePolicy.js`, the same file the runner uses.
 * `test/github-gate.test.mjs` fails if a write path skips the gate.
 */
import { checkRestWrite, cleanText } from '../../../src/reviewer/githubGatePolicy.js';
import { SECRET_INDEX } from './catalog.js';

export class WorkerGateError extends Error {
  /** @param {string} kind @param {string} reason */
  constructor(kind, reason) {
    super(`The Reviewer Gate blocked this ${kind} write: ${reason}`);
    this.name = 'WorkerGateError';
    this.code = 'gate_blocked';
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * Check a write that goes to this repository.
 * @param {Record<string, any>} env
 * @param {{ method: string, path: string, body?: any }} request
 * @returns {{ body: any, kind: string, redactions: number }}
 */
export function gateOwnRepoWrite(env, request) {
  const verdict = checkRestWrite(request, { repository: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, secretNames: SECRET_INDEX.keys() });
  if (!verdict.ok) {
    console.error(`titan-runner-brain: gate blocked a ${verdict.kind} write: ${verdict.reason}`);
    throw new WorkerGateError(verdict.kind, verdict.reason);
  }
  return { body: verdict.body, kind: verdict.kind, redactions: verdict.redactions };
}

const GITHUB_HOSTS = new Set(['api.github.com', 'uploads.github.com']);

/** True when a request goes to GitHub and changes something. */
export function isGithubWrite(method, url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return GITHUB_HOSTS.has(host) && !['GET', 'HEAD'].includes(String(method).toUpperCase());
}

/**
 * Check a connector write to GitHub. The connection may point at any repository that the person owns, so the check
 * allows two shapes only: a new Issue and a comment. It removes secret-shaped text from the body.
 * @param {{ method: string, url: string, body?: string }} req
 * @returns {{ body: string|undefined }}
 */
export function gateConnectorWrite(req) {
  const url = new URL(req.url);
  const method = String(req.method).toUpperCase();
  const issue = method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname);
  const comment = method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url.pathname);
  if (!issue && !comment) throw new WorkerGateError('connector', `no rule allows ${method} ${url.pathname.replace(/\d+/g, 'N').slice(0, 80)}`);
  let parsed;
  try {
    parsed = JSON.parse(req.body ?? '{}');
  } catch {
    throw new WorkerGateError('connector', 'the body is not JSON');
  }
  const allowed = issue ? ['title', 'body', 'labels'] : ['body'];
  if (Object.keys(parsed).some((k) => !allowed.includes(k))) throw new WorkerGateError('connector', 'unknown field in the body');
  for (const field of ['title', 'body']) if (typeof parsed[field] === 'string') parsed[field] = cleanText(parsed[field]).text;
  return { body: JSON.stringify(parsed) };
}

export default { gateOwnRepoWrite, gateConnectorWrite, isGithubWrite, WorkerGateError };
