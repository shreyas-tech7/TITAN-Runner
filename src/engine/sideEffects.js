/**
 * @file Idempotent side effects. The pulse model is at-least-once: a task
 * can be re-run after a crash, and a crash can land between "the comment
 * reached GitHub" and "the checkpoint recorded that it did". Every
 * outward-facing effect therefore carries a key, is recorded in the task's
 * checkpoint ledger the moment it succeeds, and — for the one effect whose
 * duplicate is visible to a human, the issue comment — is also checked
 * against GitHub itself before firing: each comment the engine posts ends
 * with an HTML marker `<!-- titan:<key> -->`, and a re-run lists the
 * issue's comments and skips a key it finds. One GET per effect on the
 * re-run path only; the happy path pays nothing extra.
 */

export const MARKER_PREFIX = 'titan:';

/** @param {string} key */
export function markerFor(key) {
  return `<!-- ${MARKER_PREFIX}${key} -->`;
}

export class SideEffectLedger {
  /**
   * @param {{ github: object, ledger: Record<string, string>, onRecord?: (key: string, at: string) => void|Promise<void>, now?: () => Date, events?: object|null, taskId?: string }} init
   */
  constructor(init) {
    this.github = init.github;
    this.ledger = init.ledger ?? {};
    this.onRecord = init.onRecord ?? (() => {});
    this.now = init.now ?? (() => new Date());
    this.events = init.events ?? null;
    this.taskId = init.taskId ?? null;
    this.skipped = 0;
    this.fired = 0;
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.ledger, key);
  }

  async #record(key) {
    const at = this.now().toISOString();
    this.ledger[key] = at;
    await this.onRecord(key, at);
  }

  /**
   * Post a comment exactly once per key.
   * @param {number} issueNumber
   * @param {string} key
   * @param {string} body
   * @returns {Promise<'posted'|'skipped-ledger'|'skipped-remote'|'noop'>}
   */
  async comment(issueNumber, key, body) {
    if (!issueNumber) return 'noop';
    if (this.has(key)) {
      this.skipped += 1;
      return 'skipped-ledger';
    }
    // Re-run path: the ledger may be behind GitHub by one crash window.
    if (Object.keys(this.ledger).length > 0 || this.forceRemoteCheck) {
      if (await this.#remoteHas(issueNumber, key)) {
        this.skipped += 1;
        await this.#record(key);
        this.events?.append('side-effect.skipped', { taskId: this.taskId, key, outcome: 'already-on-github' });
        return 'skipped-remote';
      }
    }
    await this.github.commentOnIssue(issueNumber, `${body}\n${markerFor(key)}`);
    this.fired += 1;
    await this.#record(key);
    this.events?.append('side-effect.fired', { taskId: this.taskId, key, kind: 'comment', outcome: 'ok' });
    return 'posted';
  }

  async #remoteHas(issueNumber, key) {
    try {
      const comments = await this.github.listIssueComments(issueNumber, {});
      const marker = markerFor(key);
      return comments.some((c) => typeof c?.body === 'string' && c.body.includes(marker));
    } catch {
      return false;
    }
  }

  /**
   * Close an issue once per key (closing twice is harmless, but the ledger
   * keeps the record honest and saves the call).
   */
  async closeIssue(issueNumber, key) {
    if (!issueNumber) return 'noop';
    if (this.has(key)) {
      this.skipped += 1;
      return 'skipped-ledger';
    }
    await this.github.closeIssue(issueNumber);
    this.fired += 1;
    await this.#record(key);
    this.events?.append('side-effect.fired', { taskId: this.taskId, key, kind: 'close-issue', outcome: 'ok' });
    return 'closed';
  }

  /**
   * Any other effect, run once per key.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<{ ran: boolean, result: T|null }>}
   */
  async once(key, fn) {
    if (this.has(key)) {
      this.skipped += 1;
      return { ran: false, result: null };
    }
    const result = await fn();
    this.fired += 1;
    await this.#record(key);
    this.events?.append('side-effect.fired', { taskId: this.taskId, key, kind: 'custom', outcome: 'ok' });
    return { ran: true, result };
  }
}

export default SideEffectLedger;
