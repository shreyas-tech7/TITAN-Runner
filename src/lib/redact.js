/**
 * @file Redaction — the last line of defence before anything reaches a sink.
 *
 * Two independent mechanisms, deliberately overlapping:
 *
 *   1. **Value scanning** (`SECRET_PATTERNS`) catches credentials wherever they
 *      appear — inside a free-text error message, a stack trace, a URL. This is
 *      the net for things we did not anticipate.
 *   2. **Key-name blanking** (`REDACTED_FIELDS` + the sensitive-key regex)
 *      removes whole fields by name regardless of content. This is what keeps
 *      prompt and completion text off disk: a prompt is not pattern-matchable,
 *      so the only safe rule is "never write a field called `prompt`".
 *
 * Everything here returns a NEW value. Mutating a caller's object during
 * logging would be a spectacular way to corrupt a live request.
 */

/** Replacement token. Single constant so tests can assert on it. */
const MASK = '[REDACTED]';

/**
 * Patterns for credential-shaped substrings.
 *
 * Ordering is not significant for correctness (every match becomes the same
 * mask) but specific issuers come first so the intent stays readable. The
 * trailing generic rules exist because an unrecognised provider's key is still
 * a key: any sufficiently long hex or base64 run in a log line is treated as
 * secret. Over-redaction is an acceptable cost; under-redaction is not.
 *
 * All patterns are anchored on cheap literal prefixes or bounded character
 * classes — no nested quantifiers, so none of them can backtrack pathologically
 * on hostile input.
 *
 * @type {RegExp[]}
 */
export const SECRET_PATTERNS = [
  // GitHub classic tokens: ghp_ (personal), gho_ (oauth), ghs_ (server),
  // ghu_ (user-to-server), ghr_ (refresh).
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // GitHub fine-grained PAT.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Groq.
  /\bgsk_[A-Za-z0-9]{20,}/g,
  // HuggingFace.
  /\bhf_[A-Za-z0-9]{16,}/g,
  // OpenRouter / Anthropic / OpenAI family. The `sk-` branch subsumes the
  // longer prefixes, but they are spelled out so the intent survives review.
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Google API keys, and the AQ.* form used by some Google AI consoles.
  /\bAIza[A-Za-z0-9_-]{16,}/g,
  /\bAQ\.[A-Za-z0-9_-]{20,}/g,
  // Slack / Stripe-shaped tokens, cheap to include.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // Authorization headers, in header form and in object/JSON form.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bauthorization["']?\s*[:=]\s*["']?[^"'\s,}]{8,}/gi,
  // `?token=…` / `&api_key=…` in a URL.
  /\b(?:api[_-]?key|access[_-]?token|token|secret)=[^&\s"']{8,}/gi,
  // Email addresses. Not a credential, but PII the Gmail adapter's own
  // fixtures and live path both carry (senders, recipients, thread
  // participants) — the brief names this alongside keys and tokens
  // explicitly, and a from:/to: header or an error message quoting an
  // address is exactly the kind of "we did not anticipate this sink"
  // case value-scanning exists for.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // Generic: long base64-ish or hex runs. Deliberately last and deliberately
  // broad — this is the catch-all for a provider we have never heard of.
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
  /\b[a-fA-F0-9]{32,}\b/g,
];

/**
 * Field names whose *value* is never safe to persist, whatever it contains.
 * This is the prompt/response privacy guarantee in list form.
 * @type {string[]}
 */
export const REDACTED_FIELDS = [
  'prompt',
  'messages',
  'response',
  'text',
  'body',
  'content',
  'completion',
  'choices',
  'input',
  'output',
];

/** Lower-cased lookup so the field check is O(1) and case-insensitive. */
const REDACTED_FIELD_SET = new Set(REDACTED_FIELDS.map((f) => f.toLowerCase()));

/**
 * Key names that carry credentials. Separate from REDACTED_FIELDS because this
 * one is a substring match: `githubToken`, `x-api-key` and `authorization` must
 * all hit. `pat\b` is bounded so it does not swallow `path`.
 */
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|authorization|credential|pat\b/i;

/** Depth ceiling. A hostile or accidentally cyclic-ish structure must not blow the stack. */
const MAX_DEPTH = 8;

/**
 * Scrub credential-shaped substrings out of a string.
 * @param {unknown} str Anything; non-strings are returned untouched.
 * @returns {unknown} The redacted string, or the original non-string value.
 */
export function redactString(str) {
  if (typeof str !== 'string') return str;
  if (str.length === 0) return str;
  let out = str;
  for (const pattern of SECRET_PATTERNS) {
    // Global regexes carry lastIndex state; String#replace resets it, but an
    // explicit reset makes this safe even if a caller has .test()ed a pattern.
    pattern.lastIndex = 0;
    out = out.replace(pattern, MASK);
  }
  return out;
}

/**
 * Should this key's value be blanked purely because of its name?
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return REDACTED_FIELD_SET.has(lower) || SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Deep-redact any value for logging.
 *
 * Handles strings, numbers, arrays, plain objects, `Error`s, `Map`/`Set`, and
 * cycles. Unknown class instances are NOT walked — an ORM row or a socket can
 * carry live handles and getters with side effects, so they collapse to a
 * placeholder naming the class. Never mutates the input.
 *
 * @param {unknown} value
 * @returns {unknown} A new, safe-to-serialise value.
 */
export function redact(value) {
  return walk(value, 0, new WeakSet());
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen Objects on the current path; catches cycles.
 * @returns {unknown}
 */
function walk(value, depth, seen) {
  // Primitives.
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return redactString(value);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return `${value}n`;
  if (type === 'symbol') return '[Symbol]';
  if (type === 'function') return '[Function]';

  const obj = /** @type {object} */ (value);

  // Cycles. A WeakSet of the objects already emitted is enough: re-entering one
  // means we are going round a loop, so we stop and say so.
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  seen.add(obj);
  try {
    if (value instanceof Error) return redactError(value, depth, seen);
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);

    if (value instanceof Map) {
      // Emitted as pair-arrays: a Map may key on non-strings, which an object
      // cannot represent faithfully.
      return [...value.entries()].map(([k, v]) => {
        const keyOut = walk(k, depth + 1, seen);
        const sensitive = typeof k === 'string' && isSensitiveKey(k);
        return [keyOut, sensitive ? MASK : walk(v, depth + 1, seen)];
      });
    }
    if (value instanceof Set) {
      return [...value.values()].map((v) => walk(v, depth + 1, seen));
    }

    if (isPlainObject(value)) {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = isSensitiveKey(k) ? MASK : walk(v, depth + 1, seen);
      }
      return out;
    }

    // Unknown class instance: do not walk it.
    const name = obj.constructor?.name ?? 'Object';
    return `[Object ${name}]`;
  } finally {
    // Leaving the node: a value that legitimately appears twice side by side is
    // not a cycle, and should not be reported as one.
    seen.delete(obj);
  }
}

/**
 * Errors need their own handling: `message` and `stack` are the two places a
 * provider SDK is most likely to have interpolated a key or a signed URL.
 * @param {Error} err
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {Record<string, unknown>}
 */
function redactError(err, depth, seen) {
  /** @type {Record<string, unknown>} */
  const out = {
    name: err.name,
    message: /** @type {string} */ (redactString(err.message ?? '')),
    stack: typeof err.stack === 'string' ? redactString(err.stack) : undefined,
  };
  // Own enumerable extras (status, code, retryAfterMs, provider payloads…).
  for (const [k, v] of Object.entries(err)) {
    if (k === 'name' || k === 'message' || k === 'stack') continue;
    out[k] = isSensitiveKey(k) ? MASK : walk(v, depth + 1, seen);
  }
  if (err.cause !== undefined && out.cause === undefined) {
    out.cause = walk(err.cause, depth + 1, seen);
  }
  return out;
}

/**
 * A plain `{}` or `Object.create(null)` object — something we can safely
 * enumerate without triggering exotic getters.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * First `max` characters of a prompt, for `TaskRecord.promptPreview`.
 *
 * Redacted first, then truncated — truncation alone is not a safety measure,
 * since a pasted key inside the first 80 characters would survive it. Newlines
 * are collapsed so a preview can never forge a second line in a log file.
 *
 * @param {unknown} str
 * @param {number} [max=80]
 * @returns {string}
 */
export function previewPrompt(str, max = 80) {
  if (typeof str !== 'string' || str.length === 0) return '';
  const cleaned = String(redactString(str)).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}...`;
}

export default redact;
