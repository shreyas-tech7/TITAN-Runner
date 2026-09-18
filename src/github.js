/**
 * @file Minimal GitHub REST client — just the handful of calls the pulse
 * needs (list/comment/close issues, open a PR, check a PR's CI status).
 * Deliberately dependency-free (Node 20's global `fetch`, nothing else):
 * this repo's "zero maintenance" premise extends to its own dependency
 * tree, so it does not carry an SDK for a handful of REST calls.
 *
 * Every call is a no-op (returns an empty/neutral result) when no token is
 * configured or `dryRun` is set — the pulse must be fully exercisable with
 * zero GitHub credentials, same as the provider layer.
 *
 * `createGitHubClient()` builds a client from explicit settings; the
 * module-level functions are the default client built from `config.js`,
 * kept so every existing import keeps working. `runPulse()` takes a client
 * object, which is how the harness swaps in `fakes/fakeGitHub.js`.
 */
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('github');
const API_BASE = 'https://api.github.com';

/**
 * @param {{ token?: string, repository?: string, dryRun?: boolean, fetchImpl?: typeof fetch }} [opts]
 */
export function createGitHubClient(opts = {}) {
  const token = opts.token ?? '';
  const repository = opts.repository ?? '';
  const dryRun = opts.dryRun ?? false;
  const fetchImpl = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const [owner, repo] = repository.split('/');

  function ready() {
    return Boolean(token && owner && repo) && !dryRun;
  }

  async function call(method, path, body) {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /** @returns {Promise<Array<{number:number, title:string, body:string, html_url:string, updated_at:string, labels: Array<{name:string}>, user?: {login: string, type?: string}, author_association?: string, pull_request?: object}>>} */
  async function listOpenTaskIssues(label = 'titan-task') {
    if (!ready()) return [];
    try {
      return await call('GET', `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`);
    } catch (err) {
      log.warn('listOpenTaskIssues failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Comments on one issue, oldest first, optionally only those updated at or
   * after `since` (ISO 8601). Used to find authorized `/titan …` control
   * commands — every comment payload carries GitHub-computed `user.login` and
   * `author_association`, which is what `security/authorization.js` checks.
   * @param {number} number
   * @param {{ since?: string|null }} [o]
   * @returns {Promise<Array<{id:number, body:string, created_at:string, user?:{login:string,type?:string}, author_association?:string}>>}
   */
  async function listIssueComments(number, o = {}) {
    if (!ready()) return [];
    const since = o.since ? `&since=${encodeURIComponent(o.since)}` : '';
    try {
      return await call('GET', `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100${since}`);
    } catch (err) {
      log.warn('listIssueComments failed', { number, error: String(err) });
      return [];
    }
  }

  async function commentOnIssue(number, body) {
    if (!ready()) {
      log.info('dry-run/no-token: would comment on issue', { number, preview: body.slice(0, 120) });
      return null;
    }
    return call('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  async function closeIssue(number) {
    if (!ready()) {
      log.info('dry-run/no-token: would close issue', { number });
      return null;
    }
    return call('PATCH', `/repos/${owner}/${repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
  }

  async function createPullRequest({ title, head, base = 'main', body, draft = false }) {
    if (!ready()) {
      log.info('dry-run/no-token: would open PR', { title, head, base });
      return null;
    }
    return call('POST', `/repos/${owner}/${repo}/pulls`, { title, head, base, body, draft });
  }

  async function closePullRequest(number) {
    if (!ready()) return null;
    return call('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { state: 'closed' });
  }

  async function getPullRequest(number) {
    if (!ready()) return null;
    return call('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  }

  /** @returns {Promise<'success'|'failure'|'pending'|'unknown'>} */
  async function getCombinedStatus(ref) {
    if (!ready()) return 'unknown';
    try {
      const runs = await call('GET', `/repos/${owner}/${repo}/commits/${ref}/check-runs`);
      const conclusions = (runs?.check_runs ?? []).map((r) => r.conclusion);
      if (conclusions.length === 0) return 'pending';
      if (conclusions.some((c) => c === 'failure' || c === 'timed_out' || c === 'cancelled')) return 'failure';
      if (conclusions.every((c) => c === 'success' || c === 'skipped' || c === 'neutral')) return 'success';
      return 'pending';
    } catch (err) {
      log.warn('getCombinedStatus failed', { error: String(err) });
      return 'unknown';
    }
  }

  /** @param {string} title @param {string} body @param {string[]} labels */
  async function createIssue(title, body, labels) {
    if (!ready()) return null;
    return call('POST', `/repos/${owner}/${repo}/issues`, { title, body, labels });
  }

  async function createIssueForDeadman(title, body, label = 'titan-alert') {
    return createIssue(title, body, [label]);
  }

  return {
    ready,
    listOpenTaskIssues, listIssueComments, commentOnIssue, closeIssue, createPullRequest, closePullRequest,
    getPullRequest, getCombinedStatus, createIssue, createIssueForDeadman,
  };
}

/** The default client, built from config.js exactly as before. */
export const defaultGitHubClient = createGitHubClient({
  token: config.github.token,
  repository: config.github.repository,
  dryRun: config.dryRun,
});

export const listOpenTaskIssues = (...args) => defaultGitHubClient.listOpenTaskIssues(...args);
export const listIssueComments = (...args) => defaultGitHubClient.listIssueComments(...args);
export const commentOnIssue = (...args) => defaultGitHubClient.commentOnIssue(...args);
export const closeIssue = (...args) => defaultGitHubClient.closeIssue(...args);
export const createPullRequest = (...args) => defaultGitHubClient.createPullRequest(...args);
export const closePullRequest = (...args) => defaultGitHubClient.closePullRequest(...args);
export const getPullRequest = (...args) => defaultGitHubClient.getPullRequest(...args);
export const getCombinedStatus = (...args) => defaultGitHubClient.getCombinedStatus(...args);
export const createIssue = (...args) => defaultGitHubClient.createIssue(...args);
export const createIssueForDeadman = (...args) => defaultGitHubClient.createIssueForDeadman(...args);

export default {
  createGitHubClient, defaultGitHubClient,
  listOpenTaskIssues, listIssueComments, commentOnIssue, closeIssue, createPullRequest, closePullRequest,
  getPullRequest, getCombinedStatus, createIssue, createIssueForDeadman,
};
