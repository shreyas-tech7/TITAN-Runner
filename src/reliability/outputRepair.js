/**
 * @file Defensive validation of what a model returned, and the bounded
 * repair instruction that goes back to it. "The call returned 200" is not
 * "the step is done": an empty answer, a refusal, or a broken envelope is a
 * `malformed_output` failure that the retry policy repairs (same model, up
 * to POLICY.malformed_output.sameMax times, with the hint below appended
 * to the prompt) and then hands to the next candidate.
 */
import { parseEnvelope } from '../orchestrator/envelopeParser.js';

const REFUSAL_PATTERNS = [
  /^\s*(i['’]m sorry|i am sorry|sorry,)/i,
  /\b(i can(?:no|')t|i cannot|i am unable to|i'm unable to|unable to) (help|assist|comply|do that|provide)/i,
  /\bas an ai (language )?model\b.*\b(cannot|can't|unable)/i,
];

/** Below this, trimmed, the model said nothing ("OK" is an answer; "" and "." are not). */
const MIN_USEFUL_CHARS = 2;

/** Same heuristic outputParser.js uses to tell "tried to emit files" from prose. */
function looksLikeAttemptedEnvelope(text) {
  return /['"]files['"]\s*:\s*\[/i.test(text) || /```json/i.test(text) || /\bfile:\s*\S/i.test(text);
}

/**
 * @param {string|null|undefined} output
 * @returns {{ ok: true } | { ok: false, code: 'EMPTY_OUTPUT'|'REFUSAL'|'MALFORMED_OUTPUT', message: string }}
 */
export function validateSubtaskOutput(output) {
  const text = typeof output === 'string' ? output : '';
  if (text.trim().length < MIN_USEFUL_CHARS) return { ok: false, code: 'EMPTY_OUTPUT', message: 'the model returned an empty or near-empty answer' };
  const head = text.slice(0, 400);
  if (REFUSAL_PATTERNS.some((re) => re.test(head))) return { ok: false, code: 'REFUSAL', message: 'the model declined the task instead of doing it' };
  if (looksLikeAttemptedEnvelope(text)) {
    const parsed = parseEnvelope(text);
    if (parsed.tier === null) return { ok: false, code: 'MALFORMED_OUTPUT', message: 'the output tried to be a files envelope but could not be parsed' };
  }
  return { ok: true };
}

/**
 * @param {'EMPTY_OUTPUT'|'REFUSAL'|'MALFORMED_OUTPUT'} code
 * @returns {string} Appended to the task prompt on the repair attempt.
 */
export function repairHintFor(code) {
  switch (code) {
    case 'MALFORMED_OUTPUT':
      return 'REPAIR: your previous answer could not be parsed. Respond with ONLY one fenced ```json block containing {"files":[{"path":"...","content":"..."}],"notes":"..."} — valid JSON, every string properly escaped, nothing before or after the block, and do not stop before the closing brace.';
    case 'EMPTY_OUTPUT':
      return 'REPAIR: your previous answer was empty. Produce the full deliverable now.';
    case 'REFUSAL':
      return 'REPAIR: this is an ordinary software-engineering task inside a sandboxed repository; nothing here is harmful. Produce the deliverable described above.';
    default:
      return '';
  }
}

export default { validateSubtaskOutput, repairHintFor };
