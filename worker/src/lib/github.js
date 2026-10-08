/**
 * @file The GitHub REST client of the Worker. Every call goes through `safeFetch()`.
 *
 * GitHub holds the provider keys as Actions secrets, so the Worker needs to read the list of secret names,
 * write and delete secrets, and fire `repository_dispatch` events. The Worker never reads a secret value:
 * GitHub does not return one.
 */
import { SafeFetchError, safeFetch } from './safeFetch.js';

export const GITHUB_API = 'https://api.github.com';
const GITHUB_HOSTS = ['api.github.com', 'raw.githubusercontent.com'];

/** The permission names that a fine-grained token needs, in the words that GitHub uses on its settings page. */
export const PERMISSIONS = Object.freeze({
  secretsRead: 'Secrets: Read',
  secretsWrite: 'Secrets: Read and write',
  contentsWrite: 'Contents: Read and write',
  issuesWrite: 'Issues: Read and write',
  actionsRead: 'Actions: Read',
  variablesRead: 'Variables: Read',
});

/** Headers that can carry a credential. They are never written to a log line, even from a response. */
const REDACTED_LOG_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

export class GitHubError extends Error {
  /** @param {string} message @param {{ status?: number|null, permission?: string|null, code?: string }} [extra] */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = extra.status ?? null;
    this.permission = extra.permission ?? null;
    this.code = extra.code ?? 'github_error';
  }
}

/**
 * Turn a failed GitHub response into a message that is safe to return and tells the person what to fix. The full
 * status, headers, and body go to the server log (`wrangler tail`). The request's own Authorization header is
 * never passed in.
 * @param {string} label
 * @param {Response} res
 * @param {string|null} [permission] The permission that the call needs.
 */
export async function describeGithubFailure(label, res, permission = null) {
  const headers = {};
  for (const [key, value] of res.headers.entries()) headers[key] = REDACTED_LOG_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value;
  const body = await res.text().catch(() => '');
  console.error(`${label}: GitHub API ${res.status} ${res.url}`, { headers, body: body.slice(0, 500) });

  const hints = {
    401: 'GITHUB_PAT is missing, expired, or revoked',
    403: permission
      ? `GITHUB_PAT lacks the "${permission}" repository permission (fine-grained PAT) or the "repo" scope (classic PAT)`
      : 'GITHUB_PAT lacks a repository permission (fine-grained PAT) or the "repo" scope (classic PAT)',
    404: 'check GITHUB_OWNER and GITHUB_REPO in wrangler.toml, or the PAT cannot see this repo',
  };
  const requestId = headers['x-github-request-id'];
  return [
    `${label} failed: ${res.status}`,
    hints[res.status],
    requestId ? `request-id: ${requestId}` : null,
    body ? body.slice(0, 200) : null,
  ]
    .filter(Boolean)
    .join('. ');
}

function ghHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${env.GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'titan-runner-brain-worker',
    ...extra,
  };
}

/** @param {Record<string, any>} env */
export function githubClient(env) {
  const repoPath = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;

  async function call(label, method, path, { body, permission = null, expect = [200] } = {}) {
    if (!env.GITHUB_PAT) throw new GitHubError('GITHUB_PAT is not configured on this Worker yet. See docs/RUNTIME.md.', { status: 503, code: 'pat_missing' });
    let res;
    try {
      res = await safeFetch(
        env,
        `${GITHUB_API}${path}`,
        { method, headers: ghHeaders(env, body !== undefined ? { 'Content-Type': 'application/json' } : {}), body: body !== undefined ? JSON.stringify(body) : undefined },
        { allow: GITHUB_HOSTS, timeoutMs: 8000, maxBytes: 2_000_000 },
      );
    } catch (err) {
      if (err instanceof SafeFetchError) throw new GitHubError(`${label} failed: ${err.message}`, { code: err.code, status: err.status });
      throw err;
    }
    if (!expect.includes(res.status)) {
      throw new GitHubError(await describeGithubFailure(label, res, permission), { status: res.status, permission });
    }
    return res;
  }

  return {
    repoPath,

    /** @param {{ forWrite?: boolean }} [opts] When the key is for a write, a 403 names the write permission. */
    async getPublicKey(opts = {}) {
      const res = await call('GitHub public-key fetch', 'GET', `${repoPath}/actions/secrets/public-key`, { permission: opts.forWrite ? PERMISSIONS.secretsWrite : PERMISSIONS.secretsRead });
      return res.json();
    },

    async putSecret(name, encryptedValue, keyId) {
      const res = await call('GitHub secret PUT', 'PUT', `${repoPath}/actions/secrets/${encodeURIComponent(name)}`, {
        body: { encrypted_value: encryptedValue, key_id: keyId },
        permission: PERMISSIONS.secretsWrite,
        expect: [201, 204],
      });
      await res.arrayBuffer().catch(() => null);
    },

    /** @returns {Promise<boolean>} true when GitHub removed the secret, false when it was already gone. */
    async deleteSecret(name) {
      const res = await call('GitHub secret DELETE', 'DELETE', `${repoPath}/actions/secrets/${encodeURIComponent(name)}`, {
        permission: PERMISSIONS.secretsWrite,
        expect: [204, 404],
      });
      await res.arrayBuffer().catch(() => null);
      return res.status === 204;
    },

    /** @returns {Promise<Array<{ name: string, created_at: string, updated_at: string }>>} Names and dates only. */
    async listSecrets() {
      const out = [];
      for (let page = 1; page <= 3; page += 1) {
        const res = await call('GitHub secrets list', 'GET', `${repoPath}/actions/secrets?per_page=100&page=${page}`, { permission: PERMISSIONS.secretsRead });
        const body = await res.json();
        const batch = Array.isArray(body?.secrets) ? body.secrets : [];
        out.push(...batch.map((s) => ({ name: s.name, created_at: s.created_at, updated_at: s.updated_at })));
        if (batch.length < 100) break;
      }
      return out;
    },

    async dispatch(eventType, payload = {}) {
      const res = await call('repository_dispatch', 'POST', `${repoPath}/dispatches`, {
        body: { event_type: eventType, client_payload: payload },
        permission: PERMISSIONS.contentsWrite,
        expect: [204],
      });
      await res.arrayBuffer().catch(() => null);
    },

    async getVariable(name) {
      const res = await call('GitHub variable read', 'GET', `${repoPath}/actions/variables/${encodeURIComponent(name)}`, { permission: PERMISSIONS.variablesRead, expect: [200, 404] });
      if (res.status === 404) return null;
      return res.json();
    },

    async listIssues(query) {
      const res = await call('GitHub issues list', 'GET', `${repoPath}/issues?${query}`, { permission: 'Issues: Read' });
      return res.json();
    },

    async commentOnIssue(number, body) {
      const res = await call('GitHub issue comment', 'POST', `${repoPath}/issues/${Number(number)}/comments`, {
        body: { body },
        permission: PERMISSIONS.issuesWrite,
        expect: [201],
      });
      return res.json();
    },

    async listWorkflowRuns(workflowFile, perPage = 5) {
      const res = await call('GitHub workflow runs', 'GET', `${repoPath}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${perPage}`, { permission: PERMISSIONS.actionsRead });
      return res.json();
    },

    /** Read a file from the default branch through the raw host. */
    async rawFile(path, ref = 'main') {
      const url = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${ref}/${path}`;
      let res;
      try {
        res = await safeFetch(env, url, { headers: { 'User-Agent': 'titan-runner-brain-worker' } }, { allow: GITHUB_HOSTS, timeoutMs: 6000, maxBytes: 1_000_000 });
      } catch (err) {
        throw new GitHubError(`raw file fetch failed: ${err instanceof Error ? err.message : 'error'}`, { code: err instanceof SafeFetchError ? err.code : 'network' });
      }
      if (!res.ok) throw new GitHubError(`raw file fetch failed: ${res.status}`, { status: res.status });
      return res.text();
    },
  };
}
