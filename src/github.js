/**
 * @file Minimal GitHub REST client — just the handful of calls the pulse
 * needs (list/comment/close issues, open a PR, check a PR's CI status).
 * Deliberately dependency-free (Node 20's global `fetch`, nothing else):
 * this repo's "zero maintenance" premise extends to its own dependency
 * tree, so it does not carry an SDK for a handful of REST calls.
 *
 * Every call is a no-op (returns an empty/neutral result) when no token is
 * configured or `config.dryRun` is set — the pulse must be fully
 * exercisable with zero GitHub credentials, same as the provider layer.
 */
import { config } from './config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('github');
const API_BASE = 'https://api.github.com';

function repoParts() {
  const [owner, repo] = (config.github.repository || '').split('/');
  return { owner, repo };
}

function ready() {
  const { owner, repo } = repoParts();
  return Boolean(config.github.token && owner && repo) && !config.dryRun;
}

async function call(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.github.token}`,
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

/** @returns {Promise<Array<{number:number, title:string, body:string, html_url:string, updated_at:string, labels: Array<{name:string}>}>>} */
export async function listOpenTaskIssues(label = 'titan-task') {
  if (!ready()) return [];
  const { owner, repo } = repoParts();
  try {
    return await call('GET', `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`);
  } catch (err) {
    log.warn('listOpenTaskIssues failed', { error: String(err) });
    return [];
  }
}

export async function commentOnIssue(number, body) {
  if (!ready()) {
    log.info('dry-run/no-token: would comment on issue', { number, preview: body.slice(0, 120) });
    return null;
  }
  const { owner, repo } = repoParts();
  return call('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
}

export async function closeIssue(number) {
  if (!ready()) {
    log.info('dry-run/no-token: would close issue', { number });
    return null;
  }
  const { owner, repo } = repoParts();
  return call('PATCH', `/repos/${owner}/${repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
}

export async function createPullRequest({ title, head, base = 'main', body, draft = false }) {
  if (!ready()) {
    log.info('dry-run/no-token: would open PR', { title, head, base });
    return null;
  }
  const { owner, repo } = repoParts();
  return call('POST', `/repos/${owner}/${repo}/pulls`, { title, head, base, body, draft });
}

export async function closePullRequest(number) {
  if (!ready()) return null;
  const { owner, repo } = repoParts();
  return call('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { state: 'closed' });
}

export async function getPullRequest(number) {
  if (!ready()) return null;
  const { owner, repo } = repoParts();
  return call('GET', `/repos/${owner}/${repo}/pulls/${number}`);
}

/** @returns {Promise<'success'|'failure'|'pending'|'unknown'>} */
export async function getCombinedStatus(ref) {
  if (!ready()) return 'unknown';
  const { owner, repo } = repoParts();
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
export async function createIssue(title, body, labels) {
  if (!ready()) return null;
  const { owner, repo } = repoParts();
  return call('POST', `/repos/${owner}/${repo}/issues`, { title, body, labels });
}

export async function createIssueForDeadman(title, body, label = 'titan-alert') {
  return createIssue(title, body, [label]);
}

export default {
  listOpenTaskIssues, commentOnIssue, closeIssue, createPullRequest, closePullRequest,
  getPullRequest, getCombinedStatus, createIssue, createIssueForDeadman,
};
