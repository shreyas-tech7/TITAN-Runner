/**
 * @file Reviewer Gate — the persona prompt and the message builder for
 * Layer 2's model round trip. Text lives here, not inlined in reviewer.js,
 * so it can be unit-tested (does it always ask for JSON? does it always
 * include the classification?) without touching the network logic.
 */

/** Verbatim from the Wave 7 brief. */
export const REVIEWER_PERSONA_PROMPT =
  "You are TITAN. Evaluate the user's proposed execution plan against the current system state. " +
  'If the plan is destructive, inefficient, or likely to fail given current test status, block it and say why. ' +
  'Answer in the polite, dry, competent tone of a British butler. Be brief. Never use emojis. ' +
  'Return JSON with keys verdict, reason, suggestion.';

/**
 * @param {{
 *   toolId: string,
 *   args: Record<string, unknown>,
 *   classification: import('./policy.js').Classification,
 *   matchedRules: string[],
 *   reasons: string[],
 * }} action
 * @param {import('./systemState.js').SystemStateSnapshot} systemState
 * @returns {Array<{ role: 'system'|'user', content: string }>}
 */
export function buildReviewMessages(action, systemState) {
  let argsPreview;
  try {
    argsPreview = JSON.stringify(action.args ?? {});
  } catch {
    argsPreview = String(action.args);
  }
  // Arguments can be arbitrarily large (a vault write's `content`, say) —
  // the model only needs enough to judge intent, not the full payload.
  if (argsPreview.length > 600) argsPreview = `${argsPreview.slice(0, 600)}…`;

  const lines = [
    `Proposed action: tool "${action.toolId}" with arguments ${argsPreview}`,
    `Layer 1 (deterministic) classification: ${action.classification}` +
      (action.matchedRules.length > 0 ? ` (matched: ${action.matchedRules.join(', ')} — ${action.reasons.join('; ')})` : ''),
    `Current branch: ${systemState.branch ?? 'unknown'}`,
    `Working tree dirty: ${systemState.dirty === null ? 'unknown' : systemState.dirty ? 'yes' : 'no'}`,
    'Decide whether this action should proceed. Respond with ONLY a JSON object: ' +
      '{"verdict": "allow"|"block", "reason": "one or two sentences", "suggestion": "a safer alternative, or null"}.',
  ];

  return [
    { role: 'system', content: REVIEWER_PERSONA_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

export default { REVIEWER_PERSONA_PROMPT, buildReviewMessages };
