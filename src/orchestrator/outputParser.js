/**
 * @file Three-tier parser for a task's raw model output into a file list.
 *
 * Replaces the old single-tier convention (`// file: <path>` as a fenced
 * block's first line — still supported, now as tier 2's legacy fallback)
 * with a real contract: `_buildTaskPrompt` (agents/AgentAdapter.js) now
 * asks every model for a fenced JSON envelope,
 * `{"files":[{"path":"...","content":"..."}],"notes":"..."}`. Models don't
 * reliably comply, so this module never assumes tier 1 succeeds — it tries
 * progressively more forgiving strategies and records which one actually
 * worked, because "which tier" is itself useful signal (surfaced per-task
 * in TaskDetailDrawer): a task pool that's constantly falling to tier 2/3
 * is a model that isn't following the envelope instruction, worth knowing
 * independent of whether the run still succeeded.
 *
 * Deliberately pure aside from the injected `repair` callback (tier 3) —
 * same reasoning as synthesizer.js's own file header: no I/O of its own,
 * trivial to unit test, reusable outside the orchestrator's own plumbing.
 *
 * Tiers 1-2's actual JSON-repair mechanics (balanced-brace scanning,
 * trailing-comma stripping) live in `lib/jsonRepair.js`, shared with
 * `envelopeParser.js` (which re-exports this module's own functions for
 * backward compatibility) — "parsed by the same three-tier parser" applies
 * to the repair primitives themselves, not just the strict/lenient/repair
 * *shape*.
 */

import { tryStrictJson, tryLenientJson } from '../lib/jsonRepair.js';

/** Matches a fenced code block, capturing the language tag and the body. */
const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * The first line of a legacy file-attributed block, in any of the comment
 * styles `_buildTaskPrompt` used to ask for: `//`, `#`, `--`, `;`, `%`, or
 * an HTML/XML `<!-- -->` comment. Kept byte-identical to the pattern
 * synthesizer.js used before this module existed, since tier 2's legacy
 * fallback exists specifically to keep reading output shaped that way.
 */
const FILE_COMMENT_RE =
  /^\s*(?:\/\/|#|--|;|%)\s*file:\s*(.+?)\s*$|^\s*<!--\s*file:\s*(.+?)\s*-->\s*$/i;

/**
 * @typedef {object} ExtractedFile
 * @property {string} path Normalised, traversal-safe relative path.
 * @property {string} content
 */

/**
 * @typedef {object} ParseResult
 * @property {1|2|3|null} tier Which tier actually produced the file list.
 *   `null` when nothing was extracted — either genuinely freeform output
 *   (no files were ever attempted, `malformed` false) or a broken
 *   structured-output attempt that survived all three tiers (`malformed`
 *   true).
 * @property {ExtractedFile[]} files
 * @property {string|null} notes The envelope's own `notes` field, tier 1/3 only.
 * @property {boolean} malformed True only when the output *looked like* an
 *   attempted files-envelope or legacy file block and every tier still
 *   failed to extract anything from it — never true for plain prose.
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
 * @param {any} candidate A value that has already been through
 *   `JSON.parse` successfully — untyped rather than `unknown` because this
 *   function's entire job is runtime-validating an untrusted shape; every
 *   property read below is guarded before use.
 * @returns {{files: ExtractedFile[], notes: string|null}|null} `null` if
 *   `candidate` doesn't match the envelope shape at all.
 */
function coerceEnvelope(candidate) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.files)) return null;
  /** @type {ExtractedFile[]} */
  const files = [];
  for (const entry of candidate.files) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string') continue;
    const path = normalizePath(entry.path);
    if (path) files.push({ path, content: entry.content });
  }
  // A `files: []` envelope is a deliberate, valid "no files for this task"
  // response (e.g. an analysis task, with the explanation in `notes`) —
  // not a failure to fall through on. Only the absence of a `files` array
  // at all (checked above) means "this wasn't an envelope."
  const notes = typeof candidate.notes === 'string' ? candidate.notes : null;
  return { files, notes };
}

/**
 * Tier 1 — strict. Every fenced block (`json`-tagged or not) and the raw
 * text itself, tried as pure `JSON.parse` with zero repair. The first one
 * that parses AND matches the envelope shape wins.
 * @param {string} text
 * @returns {{files: ExtractedFile[], notes: string|null}|null}
 */
function tryStrict(text) {
  return tryStrictJson(text, coerceEnvelope);
}

/**
 * Tier 2 — lenient repair, two strategies in order:
 *   1. Find any balanced `{...}` object anywhere in the text (prose wrapped
 *      around it, or missing/mismatched fences), strip trailing commas,
 *      retry as an envelope.
 *   2. Fall back to the pre-v4.0 convention: fenced blocks whose first line
 *      is a `// file: <path>`-style comment.
 * @param {string} text
 * @returns {{files: ExtractedFile[], notes: string|null}|null}
 */
function tryLenient(text) {
  const fromBalancedScan = tryLenientJson(text, coerceEnvelope);
  if (fromBalancedScan) return fromBalancedScan;

  const legacy = extractFileBlocks(text);
  if (legacy.length > 0) return { files: legacy, notes: null };

  return null;
}

/**
 * The pre-v4.0 `// file: <path>` convention, kept verbatim as tier 2's
 * legacy fallback — see this file's header. Exported under this name so
 * `envelopeParser.js` can re-export it for backward compatibility (it is the
 * single implementation now; see `envelopeParser.js`'s header).
 * @param {string} text
 * @returns {ExtractedFile[]}
 */
export function extractFileBlocks(text) {
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
 * Heuristic: does this text look like it was TRYING to emit a
 * files-envelope or a legacy file block, as opposed to genuinely freeform
 * prose (a "write a design doc" task, say)? Only text that trips this
 * heuristic and still fails every tier gets `malformed: true` — plain
 * prose that never attempted structured output is a legitimate, successful
 * result, not a parser failure.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeAttemptedEnvelope(text) {
  return (
    /['"]files['"]\s*:\s*\[/i.test(text) || /```json/i.test(text) || /\bfile:\s*\S/i.test(text)
  );
}

/**
 * @param {string} text
 * @param {{ repair?: (text: string) => Promise<string> }} [options]
 *   `repair` is tier 3: an async, cheap-model reformat pass, injected
 *   rather than imported so this module stays provider-agnostic and
 *   trivially testable without a real model call. Called at most once.
 * @returns {Promise<ParseResult>}
 */
export async function parseTaskOutput(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { tier: null, files: [], notes: null, malformed: false };
  }

  const strict = tryStrict(text);
  if (strict) return { tier: 1, files: strict.files, notes: strict.notes, malformed: false };

  const lenient = tryLenient(text);
  if (lenient) return { tier: 2, files: lenient.files, notes: lenient.notes, malformed: false };

  const attempted = looksLikeAttemptedEnvelope(text);
  if (!attempted) {
    // Genuinely freeform output — nothing was ever extractable, and
    // nothing suggests the model was trying to emit files at all.
    return { tier: null, files: [], notes: null, malformed: false };
  }

  if (typeof options.repair === 'function') {
    try {
      const repaired = await options.repair(text);
      const fromRepair = tryStrict(repaired);
      if (fromRepair) return { tier: 3, files: fromRepair.files, notes: fromRepair.notes, malformed: false };
    } catch {
      // Repair pass itself failing is just another way to end up malformed.
    }
  }

  return { tier: null, files: [], notes: null, malformed: true };
}

/**
 * Synchronous, two-tier-only parse (strict fenced envelope, then lenient
 * local repair including the legacy `// file:` convention) — the subset of
 * `parseTaskOutput` that does not need a network-capable tier-3 repair pass.
 * Re-exported by `envelopeParser.js` for backward compatibility (its public
 * API was `parseEnvelope`/`extractFileBlocks`/`normalizePath`); behaviour
 * matches the original: an envelope that named zero usable files is not a
 * success, and genuine freeform prose yields `tier: null`.
 * @param {string} text
 * @returns {{tier: 1|2|null, files: ExtractedFile[], notes: string}}
 */
export function parseEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { tier: null, files: [], notes: '' };
  }
  const strict = tryStrict(text);
  if (strict && strict.files.length > 0) return { tier: 1, files: strict.files, notes: strict.notes ?? '' };
  const lenient = tryLenient(text);
  if (lenient && lenient.files.length > 0) return { tier: 2, files: lenient.files, notes: lenient.notes ?? '' };
  return { tier: null, files: [], notes: '' };
}

export default parseTaskOutput;
