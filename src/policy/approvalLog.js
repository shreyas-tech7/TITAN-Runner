/**
 * @file The append-only record of real approve/deny decisions —
 * `state/approval-log.jsonl`, one JSON object per line, written whenever an
 * authorized human answers a `/titan approve|deny` (issue comment or the
 * TITAN Control workflow). It exists so `config/safety-rules.yml` can be
 * tuned from what people actually approved and refused, instead of from
 * guesses: a category that is approved every single time is a candidate for
 * auto_approve; one that is often denied is not.
 *
 * Append-only by construction: there is no rewrite, update, or delete here,
 * and a line that cannot be parsed back is skipped on read, never repaired.
 * Entries are passed through the same scrubber as everything else under
 * `state/` (this repo is public). The log holds no task text — only the
 * task id, the approval key, its category, the decision, and who made it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrubForState } from '../lib/secretScrub.js';

export const APPROVAL_LOG_VERSION = 1;

/**
 * @typedef {object} ApprovalEntry
 * @property {number} v
 * @property {string} at ISO timestamp.
 * @property {string} taskId
 * @property {number|null} issueNumber
 * @property {string} key The approval key the human named (`tool:…`, `deliver:…`, `self-improve:…`, `all`).
 * @property {string} category One of the safety-rules categories, `all`, or `unknown`.
 * @property {'approved'|'denied'} decision
 * @property {string} by GitHub login (or the dispatching actor).
 * @property {'issue-comment'|'control-workflow'} via
 */

export class ApprovalLog {
  /** @param {{ path: string, now?: () => Date }} init */
  constructor({ path, now = () => new Date() }) {
    this.path = path;
    this.now = now;
  }

  /**
   * @param {Omit<ApprovalEntry, 'v'|'at'>} entry
   * @returns {ApprovalEntry} The entry as written.
   */
  append(entry) {
    const line = scrubForState({ v: APPROVAL_LOG_VERSION, at: this.now().toISOString(), ...entry });
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, 'utf8');
    return line;
  }

  /**
   * The most recent entries, oldest first. Unparseable lines are skipped.
   * @param {{ limit?: number }} [opts]
   * @returns {ApprovalEntry[]}
   */
  read({ limit = 500 } = {}) {
    if (!existsSync(this.path)) return [];
    const entries = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && (parsed.decision === 'approved' || parsed.decision === 'denied')) entries.push(parsed);
      } catch {
        // a torn or hand-edited line: skip, never repair an append-only log
      }
    }
    return entries.slice(-limit);
  }
}

/**
 * Summary for the dashboard's safety panel and for tuning the rules.
 * @param {ApprovalEntry[]} entries
 */
export function summarizeApprovals(entries) {
  const byCategory = {};
  let approved = 0;
  let denied = 0;
  for (const e of entries) {
    const c = (byCategory[e.category ?? 'unknown'] ??= { approved: 0, denied: 0 });
    if (e.decision === 'approved') {
      approved += 1;
      c.approved += 1;
    } else {
      denied += 1;
      c.denied += 1;
    }
  }
  return { total: entries.length, approved, denied, byCategory, recent: entries.slice(-10).reverse() };
}

export default { ApprovalLog, summarizeApprovals };
