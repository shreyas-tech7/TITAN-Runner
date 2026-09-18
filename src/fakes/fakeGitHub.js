/**
 * @file An in-memory GitHub standing in for `github.js`'s client: issues,
 * comments, pull requests, check status — persisted to one JSON file so a
 * sequence of separate pulse processes (the harness, `titan simulate`) sees
 * the same "GitHub" the way separate real pulses do, and every mutating call
 * appended to a log so a test can count side effects (a duplicate comment
 * after a crash is a bug this repo cares about).
 *
 * Fixture shape:
 *   { "issues": [ { "number": 1, "title": "…", "body": "…", "state": "open",
 *                   "labels": [{"name":"titan-task"}], "user": {"login":"…"},
 *                   "author_association": "OWNER", "updated_at": "…",
 *                   "comments": [ { "id": 1, "body": "…", "created_at": "…",
 *                                   "user": {…}, "author_association": "…" } ] } ],
 *     "pulls": [ { "number": 10, "state": "open", "merged": false,
 *                  "head": {"ref":"…","sha":"…"}, "checks": "success" } ] }
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { now as clockNow } from '../lib/clock.js';

export class FakeGitHub {
  /**
   * @param {{ fixturePath?: string|null, logPath?: string|null, fixture?: object, now?: () => Date, repository?: string }} [init]
   */
  constructor(init = {}) {
    this.fixturePath = init.fixturePath ?? null;
    this.logPath = init.logPath ?? null;
    this.now = init.now ?? clockNow;
    this.repository = init.repository ?? 'fake-owner/fake-repo';
    this.pulseIndex = init.pulseIndex ?? null;
    this.data = { issues: [], pulls: [] };
    /** @type {Array<{op: string, args: unknown, at: string}>} */
    this.calls = [];
    if (init.fixture) this.data = normalize(init.fixture);
    else if (this.fixturePath && existsSync(this.fixturePath)) this.data = normalize(JSON.parse(readFileSync(this.fixturePath, 'utf8')));
  }

  ready() {
    return true;
  }

  #persist() {
    if (this.fixturePath) writeFileSync(this.fixturePath, JSON.stringify(this.data, null, 2));
  }

  #log(op, args) {
    const entry = { op, pulse: this.pulseIndex, args, at: this.now().toISOString() };
    this.calls.push(entry);
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Crash simulator: the fixture's `_control.killAfter = { op, nth }` makes
   * this process die with SIGKILL right after the nth call of that mutating
   * op has been *persisted* — "the comment reached GitHub, then the runner
   * died before it could save state", the exact window where a naive engine
   * posts the comment again on the next pulse.
   */
  #maybeKillAfter(op) {
    const rule = this.data._control?.killAfter;
    if (!rule || rule.op !== op) return;
    const count = this.calls.filter((c) => c.op === op).length;
    if (count === (rule.nth ?? 1)) {
      this.data._control = { ...this.data._control, killAfter: null, killed: { op, nth: count, at: this.now().toISOString() } };
      this.#persist();
      process.kill(process.pid, 'SIGKILL');
    }
  }

  #issue(number) {
    return this.data.issues.find((i) => i.number === number) ?? null;
  }

  async listOpenTaskIssues(label = 'titan-task') {
    this.#log('listOpenTaskIssues', { label });
    return this.data.issues
      .filter((i) => i.state === 'open' && (i.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === label))
      .map((i) => ({ ...i, comments: undefined, html_url: i.html_url ?? `https://github.com/${this.repository}/issues/${i.number}` }));
  }

  async listIssueComments(number, opts = {}) {
    this.#log('listIssueComments', { number, since: opts.since ?? null });
    const issue = this.#issue(number);
    if (!issue) return [];
    const since = opts.since ? Date.parse(opts.since) : -Infinity;
    return (issue.comments ?? []).filter((c) => Date.parse(c.created_at) >= since);
  }

  async commentOnIssue(number, body) {
    this.#log('commentOnIssue', { number, body: String(body).slice(0, 4000) });
    const issue = this.#issue(number);
    if (!issue) return null;
    const comment = { id: (issue.comments?.length ?? 0) + 1, body, created_at: this.now().toISOString(), user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' };
    issue.comments = [...(issue.comments ?? []), comment];
    issue.updated_at = comment.created_at;
    this.#persist();
    this.#maybeKillAfter('commentOnIssue');
    return comment;
  }

  async closeIssue(number) {
    this.#log('closeIssue', { number });
    const issue = this.#issue(number);
    if (!issue) return null;
    issue.state = 'closed';
    issue.updated_at = this.now().toISOString();
    this.#persist();
    this.#maybeKillAfter('closeIssue');
    return issue;
  }

  async createPullRequest({ title, head, base = 'main', body, draft = false }) {
    this.#log('createPullRequest', { title, head, base, draft });
    const number = 100 + this.data.pulls.length + 1;
    const pr = { number, title, head: { ref: head, sha: `fake-sha-${number}` }, base, body, draft, state: 'open', merged: false, checks: 'pending', html_url: `https://github.com/${this.repository}/pull/${number}` };
    this.data.pulls.push(pr);
    this.#persist();
    return pr;
  }

  async closePullRequest(number) {
    this.#log('closePullRequest', { number });
    const pr = this.data.pulls.find((p) => p.number === number);
    if (pr) {
      pr.state = 'closed';
      this.#persist();
    }
    return pr ?? null;
  }

  async getPullRequest(number) {
    this.#log('getPullRequest', { number });
    return this.data.pulls.find((p) => p.number === number) ?? null;
  }

  async getCombinedStatus(ref) {
    this.#log('getCombinedStatus', { ref });
    const pr = this.data.pulls.find((p) => p.head?.sha === ref);
    return pr?.checks ?? 'unknown';
  }

  async createIssue(title, body, labels) {
    this.#log('createIssue', { title, labels });
    const number = this.data.issues.reduce((m, i) => Math.max(m, i.number), 0) + 1;
    const issue = { number, title, body, labels: (labels ?? []).map((name) => ({ name })), state: 'open', user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', created_at: this.now().toISOString(), updated_at: this.now().toISOString(), comments: [], html_url: `https://github.com/${this.repository}/issues/${number}` };
    this.data.issues.push(issue);
    this.#persist();
    return issue;
  }

  async createIssueForDeadman(title, body, label = 'titan-alert') {
    return this.createIssue(title, body, [label]);
  }

  /** Test helper: count mutating calls by op. */
  counts() {
    const out = {};
    for (const c of this.calls) out[c.op] = (out[c.op] ?? 0) + 1;
    return out;
  }
}

function normalize(raw) {
  return {
    issues: Array.isArray(raw?.issues) ? raw.issues.map((i) => ({ state: 'open', comments: [], labels: [{ name: 'titan-task' }], updated_at: i.created_at ?? new Date(0).toISOString(), ...i })) : [],
    pulls: Array.isArray(raw?.pulls) ? raw.pulls : [],
    _control: raw?._control && typeof raw._control === 'object' ? raw._control : {},
  };
}

/** Reads a mutating-call log written by `logPath` back into counts. */
export function readCallLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export default FakeGitHub;
