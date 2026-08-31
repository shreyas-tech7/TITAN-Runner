/**
 * @file Three-tier parser for a task's raw model output into the file set
 * `synthesizer.js` merges into the run's deliverable — Wave 0.4.
 *
 * The system depended entirely on models emitting a `// file: <path>`
 * comment as the first line of every fenced code block (`AgentAdapter#
 * _buildTaskPrompt`'s instruction). That convention is exactly as fragile
 * as it sounds: no schema, no error signal when a model paraphrases the
 * instruction instead of following it, and no way to tell "no files in
 * this output" apart from "the convention silently failed."
 *
 * Replaced with a real contract — a fenced JSON envelope,
 * `{"files":[{"path":"...","content":"..."}],"notes":"..."}` — parsed in
 * three tiers, each one attempted only after the one before it fails:
 *
 *   1. strict  — the fenced JSON envelope, parsed directly.
 *   2. lenient — local repair: unfenced JSON, prose wrapped around the
 *      object, trailing commas, or (as a legacy fallback, not removed)
 *      the old `// file:` convention.
 *   3. repair pass — sends the malformed output back to a cheap fast model
 *      with a reformat-only instruction. Lives in `engine.js`, not here:
 *      it needs network/pool access, and this file stays pure and
 *      synchronous so tiers 1–2 remain trivially unit-testable and
 *      reusable without a run in progress. `engine.js` calls `parseEnvelope`
 *      again on the repaired text — tier 3 "succeeding" just means tier 1
 *      or 2 now succeeds on different input.
 *
 * `tier: null` means all of what this file can do failed; the caller
 * (engine.js) is the one that decides whether to attempt tier 3 or give up
 * and mark the task `malformed_output`.
 */

/** Matches a fenced code block, capturing an optional language tag and the body. */
const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * The first line of a legacy file-attributed block, in any of the comment
 * styles `_buildTaskPrompt` used to ask for: `//`, `#`, `--`, `;`, `%`, or
 * an HTML/XML `<!-- -->` comment.
 */
const FILE_COMMENT_RE =
  /^\s*(?:\/\/|#|--|;|%)\s*file:\s*(.+?)\s*$|^\s*<!--\s*file:\s*(.+?)\s*-->\s*$/i;

/**
 * @typedef {object} ExtractedFile
 * @property {string} path Normalised, traversal-safe relative path.
 * @property {string} content
 */

/**
 * @typedef {object} EnvelopeResult
 * @property {1|2|null} tier `null` means both local tiers failed.
 * @property {ExtractedFile[]} files
 * @property {string} notes
 */

/**
 * Traversal-safe path normalisation: backslashes to forward slashes, no
 * leading `/` or `./`, and every `.`/`..` segment dropped outright — a
 * `../../etc/passwd`-shaped path from a model's output must never escape
 * the run's own file tree or the eventual zip.
 * @param {string} raw
 * @returns {string} Never empty — falls back to a placeholder name.
 */
export function normalizePath(raw) {
  const clean = String(raw).replace(/\\/g, '/');
  const parts = clean.split('/').filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  return parts.length > 0 ? parts.join('/') : 'untitled-file.txt';
}

/**
 * Legacy convention: pull every `// file: <path>`-attributed fenced block
 * out of raw text. Blocks without a recognisable file comment are skipped.
 * Kept as tier 2's last-resort fallback, not removed — plenty of already-
 * recorded fixtures and any model that still emits this shape both keep
 * working.
 * @param {string} text
 * @returns {ExtractedFile[]}
 */
export function extractFileBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const blocks = [];
  FENCE_RE.lastIndex = 0;
  let match;
  while ((match = FENCE_RE.exec(text))) {
    const body = match[2];
    const newlineIdx = body.indexOf('\n');
    const firstLine = newlineIdx === -1 ? body : body.slice(0, newlineIdx);
    const rest = newlineIdx === -1 ? '' : body.slice(newlineIdx + 1);

    const fileMatch = firstLine.match(FILE_COMMENT_RE);
    if (!fileMatch) continue;

    const rawPath = (fileMatch[1] ?? fileMatch[2] ?? '').trim();
    const path = normalizePath(rawPath);
    if (path) blocks.push({ path, content: rest });
  }
  return blocks;
}

/**
 * @param {unknown} candidate Result of a JSON.parse attempt.
 * @returns {EnvelopeResult|null} `null` when the shape isn't a valid envelope.
 */
function coerceEnvelope(candidate) {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const obj = /** @type {{ files?: unknown, notes?: unknown }} */ (candidate);
  if (!Array.isArray(obj.files)) return null;

  /** @type {ExtractedFile[]} */
  const files = [];
  for (const entry of obj.files) {
    if (typeof entry !== 'object' || entry === null) continue;
    const fileEntry = /** @type {{ path?: unknown, content?: unknown }} */ (entry);
    if (typeof fileEntry.path !== 'string' || typeof fileEntry.content !== 'string') continue;
    if (fileEntry.path.trim().length === 0) continue;
    files.push({ path: normalizePath(fileEntry.path), content: fileEntry.content });
  }
  // An envelope that parsed but named zero usable files is not a success —
  // tier 2's legacy fallback (or tier 3) deserves the chance a genuinely
  // empty-but-valid envelope wouldn't need.
  if (files.length === 0) return null;
  return { tier: null, files, notes: typeof obj.notes === 'string' ? obj.notes : '' };
}

/**
 * Tier 1: the fenced JSON envelope, parsed directly. Tries every fenced
 * block in the text (not just the first) — a model that adds an
 * unrelated example block before the real envelope must not fail tier 1
 * outright.
 * @param {string} text
 * @returns {EnvelopeResult|null}
 */
function tryStrict(text) {
  FENCE_RE.lastIndex = 0;
  let match;
  while ((match = FENCE_RE.exec(text))) {
    const body = match[2].trim();
    if (body.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const envelope = coerceEnvelope(parsed);
    if (envelope) return { ...envelope, tier: 1 };
  }
  return null;
}

/**
 * Strips the one JSON malformation cheap enough to fix with a regex and
 * common enough to be worth it: a trailing comma before `}` or `]`.
 * Anything structurally worse than that is tier 3's problem, not this
 * function's — a full recursive-descent repairer is not worth building for
 * a fallback tier that already has two better options ahead of it.
 * @param {string} raw
 * @returns {string}
 */
function stripTrailingCommas(raw) {
  return raw.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Finds the first balanced `{...}` span in `text`, respecting string
 * literals so a `}` or `"` inside a file's `content` value never
 * mismatches the brace count. Returns `null` if the braces never balance
 * (truncated output, the common "model hit its token limit" case).
 * @param {string} text
 * @returns {string|null}
 */
function extractBalancedObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // Never balanced — truncated, not just malformed.
}

/**
 * Tier 2: local repair. Tries, in order — an unfenced (or prose-wrapped)
 * JSON object located by brace-matching, the same with trailing commas
 * stripped first, then the legacy `// file:` convention as a last resort.
 * @param {string} text
 * @returns {EnvelopeResult|null}
 */
function tryLenient(text) {
  const candidateSpan = extractBalancedObject(text);
  if (candidateSpan) {
    for (const attempt of [candidateSpan, stripTrailingCommas(candidateSpan)]) {
      try {
        const envelope = coerceEnvelope(JSON.parse(attempt));
        if (envelope) return { ...envelope, tier: 2 };
      } catch {
        // Try the next repair, or fall through to the legacy convention below.
      }
    }
  }

  const legacyFiles = extractFileBlocks(text);
  if (legacyFiles.length > 0) {
    return { tier: 2, files: legacyFiles, notes: '' };
  }

  return null;
}

/**
 * Parse one task's raw output into files, trying tier 1 then tier 2.
 * `tier: null` on total failure — the caller decides whether to attempt a
 * tier-3 repair pass (which needs network access this pure function
 * deliberately does not have).
 * @param {string} text
 * @returns {EnvelopeResult}
 */
export function parseEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { tier: null, files: [], notes: '' };
  }
  return tryStrict(text) ?? tryLenient(text) ?? { tier: null, files: [], notes: '' };
}
