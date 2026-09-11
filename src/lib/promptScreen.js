/**
 * @file Deterministic, Layer-1 prompt-injection & output-hygiene screening
 * (roadmap aspect D1).
 *
 * A cheap, warn-only first line of defence that runs on INCOMING task text
 * (issue title/prompt, before it is stored or dispatched) and on OUTGOING
 * produced content (file contents + summary, before they are persisted or
 * posted to an issue). It is deliberately NOT the Reviewer Gate and not a
 * replacement for `lib/redact.js`: it flags *intent* and *hygiene* patterns
 * by deterministic keyword/character rules, and it always only WARNS — it
 * never blocks, mutates, or throws. The Reviewer Gate (which can block) and
 * redaction (which scrubs secrets) remain the enforcement layers; this
 * module just makes the suspicious stuff visible in state and logs.
 *
 * Kept free of any dependency on `lib/redact.js` so the two layers can
 * evolve independently, and free of network/config access so it is trivially
 * unit-testable and can never throw on hostile input.
 */

/**
 * @typedef {object} ScreeningResult
 * @property {boolean} suspicious True when at least one warning fired.
 * @property {string[]} warnings Short, human-readable, stable descriptions.
 */

/* -------------------------------------------------------------------------- */
/* Rule tables                                                                */
/* -------------------------------------------------------------------------- */

/** Keyword/phrase rules applied to incoming task text. `id` is stable and
 *  used in tests; `re` is case-insensitive; `why` is the human-readable note. */
const PROMPT_RULES = [
  { id: 'ignore-instructions', re: /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above|earlier|your)\s+(instructions|rules|prompt|system)/i, why: 'prompt asks the model to ignore its instructions' },
  { id: 'role-override', re: /\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\s+to\s+be\b|\byou\s+must\s+obey\b|\bno\s+limits\b|\bdo\s+anything\b/i, why: 'prompt attempts a role/behaviour override' },
  { id: 'system-prompt-exfil', re: /\b(reveal|repeat|print|show|tell\s+me|leak)\b.{0,40}\b(system\s+prompt|instructions|internal\s+prompt|developer\s+message|hidden\s+prompt)\b/i, why: 'prompt tries to exfiltrate the system prompt' },
  { id: 'credential-exfil', re: /\b(reveal|print|list|show|dump|exfiltrate)\b.{0,40}\b(api[_-]?keys?|tokens?|secrets?|credentials?|passwords?)\b/i, why: 'prompt tries to extract credentials' },
  { id: 'jailbreak-marker', re: /\b(jailbreak|dan\s*mode|developer\s*mode|god\s*mode)\b/i, why: 'prompt uses a known jailbreak marker' },
  { id: 'destructive-command', re: /\b(rm\s+-rf|del\s+\/f|\bshred\b|format\s+[c-z]:|mkfs\b|git\s+push\s+(--force|-f)|git\s+reset\s+--hard|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i, why: 'prompt contains a destructive command' },
  { id: 'remote-exec', re: /\b(curl|wget)\b.{0,80}\|\s*(sh|bash|python|perl|ruby)\b|\beval\s*\(|\bexec\s*\(|os\.system\s*\(|subprocess\.(call|Popen)\s*\(/i, why: 'prompt asks to fetch-and-execute remote code' },
  { id: 'exfiltration-channel', re: /\b(send|post|upload|forward|curl|webhook|discord|slack|telegram|ngrok)\b.{0,60}\b(env|environment|\.env|tokens?|secrets?|credentials?|\.git\/config|\.ssh)\b/i, why: 'prompt suggests exfiltrating environment or credentials' },
];

/** Character-level hygiene rules applied to outgoing produced content. */
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BASE64_BLOB_RE = /[A-Za-z0-9+/]{64,}={0,2}/;

const MAX_SANE_LINE_LENGTH = 200_000;
const MAX_SANE_CONTENT_LENGTH = 4_000_000;

/**
 * @param {string} text
 * @returns {ScreeningResult}
 */
export function screenPrompt(text) {
  const warnings = [];
  if (typeof text !== 'string' || text.trim().length === 0) return { suspicious: false, warnings };

  const capped = text.slice(0, 200_000);
  for (const rule of PROMPT_RULES) {
    if (rule.re.test(capped)) warnings.push(rule.why);
    if (warnings.length >= 20) break;
  }
  return { suspicious: warnings.length > 0, warnings };
}

/**
 * Hygiene screening for produced file content / summaries. Flags structural
 * danger signs (NUL/control characters that would corrupt a text sink,
 * extremely long lines, oversized blobs, and long base64 runs that might be
 * encoded data) — all warn-only; nothing is mutated here.
 * @param {string} content
 * @returns {ScreeningResult}
 */
export function screenFileContent(content) {
  const warnings = [];
  if (typeof content !== 'string' || content.length === 0) return { suspicious: false, warnings };

  if (CONTROL_CHAR_RE.test(content)) {
    warnings.push('content contains control/NUL characters');
  }
  const length = content.length;
  if (length > MAX_SANE_CONTENT_LENGTH) {
    warnings.push(`content is ${length} characters — unusually large`);
  }
  // Long-line check: scan for a line (or, if no newline at all, the whole
  // string) longer than the sane limit. Bounded single pass.
  const firstLongLine = content.split('\n').find((l) => l.length > MAX_SANE_LINE_LENGTH);
  if (firstLongLine !== undefined) {
    warnings.push('content contains an extremely long single line');
  }
  if (BASE64_BLOB_RE.test(content)) {
    warnings.push('content contains a long base64-like run (possible embedded binary or encoded data)');
  }

  return { suspicious: warnings.length > 0, warnings: warnings.slice(0, 20) };
}

export default { screenPrompt, screenFileContent };
