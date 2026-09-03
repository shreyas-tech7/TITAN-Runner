/**
 * @file One heuristic, shared by every provider's model discovery
 * (`modelDiscovery.js`, `agents/opencodeAgent.js`), for "is this catalog
 * entry actually free". Every provider that mixes free and paid models in
 * one `/models` response (OpenRouter, Together, OpenCode Zen) describes
 * "free" a little differently — a `:free`/`-free` id suffix, a `pricing`
 * object with zeroed fields under one of a few field-name conventions, or an
 * explicit boolean — so this checks all of them rather than assuming one
 * provider's shape is universal. Deliberately permissive: a provider this
 * cannot classify either way is left to the caller's own fallback, never
 * silently treated as free.
 */

const FREE_ID_SUFFIX = /(?::free|-free)$/i;

/**
 * @param {unknown} raw A price-shaped field: a number, a numeric string, or
 *   undefined/null/other (unrecognised).
 * @returns {boolean|null} true/false when confidently zero/non-zero, null
 *   when this field could not be read as a price at all.
 */
function isZeroPrice(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n === 0 : null;
}

/**
 * @param {{id?:string, modelId?: string, name?:string, free?: boolean,
 *   pricing?: Record<string, unknown>}} model One catalog entry, in
 *   whatever shape the provider's own `/models` response uses.
 * @returns {boolean}
 */
export function isFreePriced(model) {
  if (!model || typeof model !== 'object') return false;
  if (model.free === true) return true;

  const id = typeof model.id === 'string' ? model.id : typeof model.modelId === 'string' ? model.modelId : '';
  if (FREE_ID_SUFFIX.test(id)) return true;

  const pricing = model.pricing;
  if (pricing && typeof pricing === 'object') {
    // OpenRouter: pricing.prompt / pricing.completion (strings, USD per token).
    // Together / OpenCode Zen and others: pricing.input / pricing.output.
    const pairs = [
      [pricing.prompt, pricing.completion],
      [pricing.input, pricing.output],
    ];
    for (const [a, b] of pairs) {
      const za = isZeroPrice(a);
      const zb = isZeroPrice(b);
      if (za !== null || zb !== null) return (za ?? true) && (zb ?? true);
    }
  }
  return false;
}

export default isFreePriced;
