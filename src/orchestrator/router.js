/**
 * @file Assigns one task to one model. Pure scoring — no I/O, no adapter
 * calls, no state. `scheduler.js` is the only caller and owns everything
 * this module doesn't: dispatch, retries, and Freebuff's reservation policy
 * (see the note on `excludePools` below).
 *
 * Scoring, in the exact order of weight the brief specifies:
 *   1. Category match against the model's `strengths`/`weaknesses`.
 *   2. Observed success rate for that category, if there is history.
 *   3. Availability — a model at its concurrency cap scores 0, full stop,
 *      overriding whatever category/observed score it would otherwise have.
 *   4. Latency class, tiebreaker only (fast > medium > slow).
 */

import { LATENCY_CLASSES } from './taxonomy.js';

/** Category strength/weakness weight dominates every other factor. */
const CATEGORY_MATCH_SCORE = 100;
const CATEGORY_WEAKNESS_SCORE = -50;

/** Observed success rate contributes at most this many points — enough to
 *  break ties between two equally-strong candidates, never enough to
 *  overcome a real category mismatch (weight 2 stays below weight 1). */
const OBSERVED_MAX_SCORE = 20;

/** @type {Record<string, number>} Tiebreaker only — see LATENCY_CLASSES. */
const LATENCY_RANK = { fast: 2, medium: 1, slow: 0 };

/**
 * A task's optional routing hint (task filing modal, "fast / cheap /
 * careful / any" — task instructions, section 1 and 6) nudges scoring
 * without ever overriding a real category match: `'fast'`'s latency bonus
 * (max 15) and `'careful'`'s observed-success multiplier both stay below
 * `CATEGORY_MATCH_SCORE` (100), so a strength/weakness match still decides
 * routing first — the hint only breaks ties among otherwise-similar
 * candidates. `'cheap'` is a documented no-op: every pool in this repo is
 * already free-tier, so there is no real cost signal to route on yet.
 * `'any'`/missing/unrecognised all resolve to the same zero-bonus baseline,
 * which is exactly the pre-routing-hint scoring behaviour — existing
 * callers that never set `task.routingHint` see no change at all.
 */
const ROUTING_HINT_LATENCY_BONUS = Object.freeze({ fast: 15, careful: 0, cheap: 0, any: 0 });
const ROUTING_HINT_OBSERVED_MULTIPLIER = Object.freeze({ fast: 1, careful: 1.5, cheap: 1, any: 1 });

/** @param {string|undefined} hint @returns {'fast'|'careful'|'cheap'|'any'} */
function normalizeHint(hint) {
  return hint && Object.prototype.hasOwnProperty.call(ROUTING_HINT_LATENCY_BONUS, hint) ? hint : 'any';
}

/**
 * @typedef {object} RankedCandidate
 * @property {string} modelId
 * @property {string} pool
 * @property {number} score
 * @property {boolean} available
 * @property {string} latencyClass
 * @property {number} latencyTiebreak Internal sort key derived from latencyClass; not meant for display.
 * @property {string} reason Human-readable explanation, shown in the dashboard's task detail drawer.
 */

/**
 * @param {import('../../agents/AgentAdapter.js').AdapterTask} task
 * @param {object} record A capabilityRegistry.js record for one model.
 * @param {boolean} available
 * @returns {RankedCandidate}
 */
function scoreCandidate(task, record, available) {
  const isStrength = record.strengths.includes(task.aspect);
  const isWeakness = record.weaknesses.includes(task.aspect);
  const categoryScore = isStrength ? CATEGORY_MATCH_SCORE : isWeakness ? CATEGORY_WEAKNESS_SCORE : 0;

  const hint = normalizeHint(task.routingHint);
  const observed = record.observed?.[task.aspect];
  const observedScore =
    observed && observed.runs > 0
      ? observed.successRate * OBSERVED_MAX_SCORE * ROUTING_HINT_OBSERVED_MULTIPLIER[hint]
      : 0;

  const latencyRank = LATENCY_RANK[record.latencyClass] ?? LATENCY_RANK.medium;
  const latencyTiebreak = latencyRank;
  // 'fast' scales this into real score (max 15, at LATENCY_RANK.fast === 2);
  // every other hint keeps ROUTING_HINT_LATENCY_BONUS at 0, so this is a
  // no-op for 'any'/'cheap'/'careful'/unset.
  const latencyBonus = (latencyRank / LATENCY_RANK.fast) * ROUTING_HINT_LATENCY_BONUS[hint];

  // Hard rule 3: unavailable scores zero outright — category/observed scores
  // never rescue a model that is at its concurrency cap right now.
  const score = available ? categoryScore + observedScore + latencyBonus : 0;

  const reasonParts = [];
  if (isStrength) reasonParts.push(`strength match on "${task.aspect}"`);
  else if (isWeakness) reasonParts.push(`known weakness in "${task.aspect}"`);
  else reasonParts.push(`no recorded strength/weakness for "${task.aspect}"`);
  if (observed && observed.runs > 0) {
    reasonParts.push(`${Math.round(observed.successRate * 100)}% observed success (${observed.runs} runs)`);
  }
  if (hint !== 'any') reasonParts.push(`routing hint "${hint}" applied`);
  if (!available) reasonParts.push('pool at capacity — excluded');

  return {
    modelId: record.modelId,
    pool: record.pool,
    score,
    available,
    latencyClass: record.latencyClass,
    latencyTiebreak,
    reason: reasonParts.join('; '),
  };
}

/**
 * Score and rank every candidate model for one task, best first.
 *
 * @param {import('../../agents/AgentAdapter.js').AdapterTask} task
 * @param {Array<{modelId: string, pool: string}>} candidateModels Every
 *   known model across every pool — the caller (scheduler.js) resolves this
 *   once per run via each adapter's `listModels()`, not on every call here.
 * @param {{
 *   pools: Record<string, import('../../agents/AgentAdapter.js').AgentAdapter>,
 *   capabilityRegistry: import('./capabilityRegistry.js').CapabilityRegistry,
 *   excludePools?: string[],
 * }} ctx `excludePools` is how scheduler.js enforces "Freebuff is reserved
 *   for the highest-complexity ready task this tick" — every OTHER ready
 *   task is scored with `excludePools: ['freebuff']` so it cannot win the
 *   assignment even if it would otherwise score highest. This is a policy
 *   decision made by the caller, not something this pure scoring function
 *   knows about on its own.
 * @returns {RankedCandidate[]} Best first. Empty when no candidate exists
 *   (e.g. every pool excluded, or `candidateModels` is empty).
 */
export function rankModels(task, candidateModels, ctx) {
  const { pools, capabilityRegistry, excludePools = [] } = ctx;
  /** @type {RankedCandidate[]} */
  const ranked = [];

  for (const candidate of candidateModels ?? []) {
    if (excludePools.includes(candidate.pool)) continue;
    const adapter = pools?.[candidate.pool];
    if (!adapter) continue;

    const available = adapter.inFlight < adapter.maxConcurrency;
    const record = capabilityRegistry.get(candidate.modelId);
    ranked.push(scoreCandidate(task, record, available));
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.latencyTiebreak - a.latencyTiebreak;
  });

  return ranked;
}

/**
 * The single best candidate for a task, or `null` when there is none at all
 * (no pools configured, or every candidate excluded).
 * @param {import('../../agents/AgentAdapter.js').AdapterTask} task
 * @param {Array<{modelId: string, pool: string}>} candidateModels
 * @param {{ pools: object, capabilityRegistry: object, excludePools?: string[] }} ctx
 * @returns {RankedCandidate|null}
 */
export function selectModel(task, candidateModels, ctx) {
  const ranked = rankModels(task, candidateModels, ctx);
  return ranked[0] ?? null;
}

export default { rankModels, selectModel };

// Re-exported for tests that want to assert on the tiebreak table directly
// without hardcoding LATENCY_CLASSES' string values twice.
export { LATENCY_CLASSES };
