/**
 * @file Shared, envelope-agnostic JSON-repair primitives.
 *
 * Extracted (v4.0 Wave 2) from `services/orchestrator/outputParser.js`,
 * which needed these to recover a `{"files":[...]}` envelope from messy
 * model output, and `services/assistant/toolCallParser.js`, which needs
 * the exact same recovery for a `{"tool":"...","args":{...}}` envelope —
 * "parsed by the same three-tier parser" (the brief's own phrasing for
 * both) means sharing the actual repair mechanics, not maintaining two
 * copies of a balanced-brace scanner. Neither caller's envelope shape is
 * known to this file; it only finds and repairs JSON *syntax*, never
 * validates *semantics* — that stays the caller's job.
 */

/**
 * Scans for the first balanced `{...}` substring starting at or after
 * `fromIndex`, honouring string literals so a `}` inside a quoted value
 * doesn't end the object early. Returns `null` if no complete, balanced
 * object is found.
 * @param {string} text
 * @param {number} fromIndex
 * @returns {string|null}
 */
export function extractBalancedObject(text, fromIndex = 0) {
  const start = text.indexOf('{', fromIndex);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Strips trailing commas before a closing `}`/`]` — the single most common
 * way a model-emitted JSON object goes invalid.
 * @param {string} json
 * @returns {string}
 */
export function stripTrailingCommas(json) {
  return json.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Try every fenced code block in `text` (any language tag) plus the raw
 * text itself, each strictly `JSON.parse`d with zero repair, passing each
 * successfully-parsed value through `coerce`. Returns the first value
 * `coerce` accepts (i.e. doesn't return `null`/`undefined` for).
 * @template T
 * @param {string} text
 * @param {(parsed: any) => T|null} coerce
 * @returns {T|null}
 */
export function tryStrictJson(text, coerce) {
  const candidates = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(text))) candidates.push(match[2]);
  candidates.push(text);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const result = coerce(JSON.parse(trimmed));
      if (result != null) return result;
    } catch {
      // Not valid JSON as-is — the caller's lenient pass will try harder.
    }
  }
  return null;
}

/**
 * Scan `text` for every balanced `{...}` object (prose-wrapped, unfenced,
 * whatever), strip trailing commas, and pass each successful parse through
 * `coerce`. Returns the first value `coerce` accepts.
 * @template T
 * @param {string} text
 * @param {(parsed: any) => T|null} coerce
 * @returns {T|null}
 */
export function tryLenientJson(text, coerce) {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const raw = extractBalancedObject(text, searchFrom);
    if (!raw) break;
    try {
      const result = coerce(JSON.parse(stripTrailingCommas(raw)));
      if (result != null) return result;
    } catch {
      // Fall through and look for another balanced object later in the text.
    }
    searchFrom = text.indexOf('{', searchFrom) + 1;
  }
  return null;
}

export default { extractBalancedObject, stripTrailingCommas, tryStrictJson, tryLenientJson };
