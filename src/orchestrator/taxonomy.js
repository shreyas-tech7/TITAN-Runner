/**
 * @file Fixed vocabularies the whole orchestrator routes against.
 *
 * Every other orchestrator module — the decomposer's task graph, the
 * capability registry's strengths/weaknesses lists, the router's scoring,
 * the scheduler's state machine, the dashboard's node styling — reads these
 * lists rather than inlining string literals, so adding or renaming a
 * category is a one-file change instead of a grep-and-pray.
 */

/**
 * The task-graph aspect categories. A decomposed task's `aspect` field must
 * be one of these; the router matches it against a model's `strengths`.
 * @type {readonly string[]}
 */
export const ASPECT_CATEGORIES = Object.freeze([
  'architecture',
  'code-generation',
  'refactoring',
  'testing',
  'debugging',
  'documentation',
  'security-review',
  'performance',
  'data-modeling',
  'devops',
  'ui-implementation',
  'research',
]);

/** @param {string} value @returns {boolean} */
export function isAspectCategory(value) {
  return typeof value === 'string' && ASPECT_CATEGORIES.includes(value);
}

/**
 * Task lifecycle. A task starts `pending`, moves to `queued` once the
 * scheduler has picked a candidate model for it, `running` while an adapter
 * call is in flight, then one of the terminal-ish states. `blocked` is
 * distinct from `failed`: it means "never attempted because a dependency
 * failed", not "attempted and lost". `malformed_output` is distinct from
 * both: the model call itself succeeded (unlike `failed`), but
 * `orchestrator/outputParser.js`'s three-tier parser could not extract a
 * files-envelope from output that looked like it was trying to produce one
 * — set only when that parser's own `malformed` flag is true, never for
 * genuinely freeform prose output (see its `looksLikeAttemptedEnvelope`
 * heuristic).
 * @type {readonly string[]}
 */
export const TASK_STATES = Object.freeze([
  'pending',
  'queued',
  'running',
  'complete',
  'failed',
  'blocked',
  'cancelled',
  'malformed_output',
]);

/** @param {string} value @returns {boolean} */
export function isTaskState(value) {
  return typeof value === 'string' && TASK_STATES.includes(value);
}

/** @type {readonly string[]} */
export const COMPLEXITY_LEVELS = Object.freeze(['low', 'medium', 'high']);

/** @param {string} value @returns {boolean} */
export function isComplexityLevel(value) {
  return typeof value === 'string' && COMPLEXITY_LEVELS.includes(value);
}

/**
 * The three agent pools. `phase2` wraps the five existing AI providers
 * (`providers/registry.js`) behind the same adapter interface as the two
 * other pools, so the router treats all three uniformly.
 * @type {readonly string[]}
 */
export const AGENT_POOLS = Object.freeze(['freebuff', 'opencode', 'phase2']);

/** @param {string} value @returns {boolean} */
export function isAgentPool(value) {
  return typeof value === 'string' && AGENT_POOLS.includes(value);
}

/** @type {readonly string[]} */
export const LATENCY_CLASSES = Object.freeze(['fast', 'medium', 'slow']);

/** Run lifecycle, mirrors TASK_STATES but at the whole-run level. */
export const RUN_STATES = Object.freeze([
  'pending',
  'running',
  'complete',
  'failed',
  'cancelled',
]);

/** @param {string} value @returns {boolean} */
export function isRunState(value) {
  return typeof value === 'string' && RUN_STATES.includes(value);
}

/**
 * The subset of RUN_STATES a run never leaves once reached. Previously
 * inlined as `['complete', 'failed', 'cancelled']` at each call site —
 * pulled out here so callers share one list instead of a grep-and-pray,
 * matching this file's own charter.
 * @type {readonly string[]}
 */
export const TERMINAL_RUN_STATES = Object.freeze(['complete', 'failed', 'cancelled']);

export default {
  ASPECT_CATEGORIES,
  isAspectCategory,
  TASK_STATES,
  isTaskState,
  COMPLEXITY_LEVELS,
  isComplexityLevel,
  AGENT_POOLS,
  isAgentPool,
  LATENCY_CLASSES,
  RUN_STATES,
  isRunState,
  TERMINAL_RUN_STATES,
};
