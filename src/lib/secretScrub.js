/**
 * @file The last line of defence before anything lands in `state/` — which,
 * because this repo is PUBLIC, means anything the internet can read
 * forever, cached and indexed regardless of a later revert.
 *
 * This is deliberately NOT `lib/redact.js`'s `redact()`: that function also
 * blanks whole fields by name (`prompt`, `output`, `content`, …), which is
 * exactly right for a log line that must never carry prompt/completion text
 * at all, but wrong here — a task's prompt and a model's output ARE the
 * deliverable this repo exists to store and post back to the originating
 * issue. `scrubForState()` instead walks every string value, wherever it
 * is, and applies only `redactString()`'s pattern-based scan (credential-
 * shaped substrings, email addresses) — content survives, secrets don't.
 */
import { redactString } from './redact.js';

const MAX_DEPTH = 12;

function walk(value, depth, seen) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return redactString(value);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return `${value}n`;
  if (type === 'function' || type === 'symbol') return undefined;

  const obj = value;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  seen.add(obj);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, depth + 1, seen);
      return out;
    }
    return value;
  } finally {
    seen.delete(obj);
  }
}

/**
 * @template T
 * @param {T} value Any JSON-serializable value about to be written under state/.
 * @returns {T}
 */
export function scrubForState(value) {
  return /** @type {T} */ (walk(value, 0, new WeakSet()));
}

export default scrubForState;
