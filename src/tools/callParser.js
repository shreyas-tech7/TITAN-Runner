/**
 * @file Recognises a tool call in a model's answer. The contract given to
 * the model (`AgentAdapter._buildTaskPrompt`) is one fenced JSON block:
 *
 *   ```json
 *   {"tool": "<id>", "args": {...}}
 *   ```
 *
 * and nothing else. A bare JSON object of that shape is accepted too. An
 * answer that also contains a files envelope, prose, or more than one call
 * is *not* a tool call — the model must do one thing per turn — so the
 * output is treated as the step's answer instead.
 */

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;
const MAX_ARGS_CHARS = 8000;

/**
 * @param {string|null|undefined} text
 * @returns {{ tool: string, args: Record<string, unknown> } | null}
 */
export function parseToolCall(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ARGS_CHARS + 200) return null;

  const fences = [...trimmed.matchAll(FENCE)];
  let candidate = null;
  if (fences.length === 1) {
    const before = trimmed.slice(0, fences[0].index).trim();
    const after = trimmed.slice(fences[0].index + fences[0][0].length).trim();
    if (before.length > 0 || after.length > 0) return null; // prose around it: an answer, not a call
    candidate = fences[0][1].trim();
  } else if (fences.length === 0 && trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidate = trimmed;
  } else {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.tool !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(parsed.tool)) return null;
  if ('files' in parsed) return null;
  const args = parsed.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (JSON.stringify(args).length > MAX_ARGS_CHARS) return null;
  return { tool: parsed.tool, args };
}

export default parseToolCall;
