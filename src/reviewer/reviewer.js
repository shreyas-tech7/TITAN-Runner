/**
 * @file Reviewer Gate — orchestrates Layer 1 (deterministic policy) and
 * Layer 2 (model review), applies the fail-open/fail-closed rule, persists
 * every verdict. Ported from TITAN's original `backend/lib/reviewer/reviewer.js`
 * with the dashboard run-event emission removed (there is no live dashboard
 * process to notify — this repo's dashboard is static and polls committed
 * state instead) and the model call routed through the lean provider
 * registry rather than the original five-plus-two agent-pool registry.
 *
 * `TITAN_REVIEWER=0` short-circuits before any of Layer 1, Layer 2, or
 * persistence runs. Unlike the original backend, this repo defaults the
 * gate ON (see config.js) — every pulse writes to a public, world-readable
 * state store, so the safety net stays on unless a maintainer deliberately
 * disables it.
 */
import { config } from '../config.js';
import { registry as aiRegistry } from '../providers/registry.js';
import { classifyAction } from './policy.js';
import { buildReviewMessages } from './prompts.js';
import { getSystemStateSnapshot } from './systemState.js';
import { appendReview } from './store.js';
import { parseProbeJson } from '../orchestrator/capabilityRegistry.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('reviewer');

/**
 * @param {{ toolId: string, args?: Record<string, unknown>, riskLevel?: 'low'|'medium'|'high',
 *   effect?: 'read'|'local_write'|'external', description?: string }} action
 * @param {{ systemState?: object, chatFn?: Function, timeoutMs?: number, enabled?: boolean }} [opts]
 */
export async function reviewAction(action, opts = {}) {
  const enabled = opts.enabled ?? config.reviewer.enabled;
  if (!enabled) {
    return { verdict: 'allow', classification: 'safe', layer: 0, reason: null, suggestion: null, matchedRules: [] };
  }

  const { classification, matchedRules, reasons } = classifyAction(action);

  if (classification === 'safe') {
    const result = { verdict: 'allow', classification, layer: 1, reason: null, suggestion: null, matchedRules };
    persist(action, result);
    return result;
  }

  const systemState = opts.systemState ?? getSystemStateSnapshot();
  const chatFn = opts.chatFn ?? aiRegistry.chat.bind(aiRegistry);
  const timeoutMs = opts.timeoutMs ?? config.reviewer.timeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`reviewer deadline of ${timeoutMs}ms exceeded`)), timeoutMs);

  let modelVerdict = null;
  let layerError = null;

  try {
    const messages = buildReviewMessages(
      { toolId: action.toolId, args: action.args ?? {}, classification, matchedRules, reasons },
      systemState,
    );
    const raw = await chatFn(messages, { service: 'groq', signal: controller.signal, temperature: 0 });
    const parsed = parseProbeJson(raw?.text);
    if (parsed && (parsed.verdict === 'allow' || parsed.verdict === 'block')) {
      modelVerdict = {
        verdict: parsed.verdict,
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : null,
      };
    } else {
      layerError = new Error('reviewer: model response did not parse to a {verdict, reason, suggestion} object');
    }
  } catch (err) {
    layerError = err;
  } finally {
    clearTimeout(timer);
  }

  let result;
  if (modelVerdict) {
    result = { verdict: modelVerdict.verdict, classification, layer: 2, reason: modelVerdict.reason, suggestion: modelVerdict.suggestion, matchedRules };
  } else {
    const errMessage = layerError instanceof Error ? layerError.message : String(layerError);
    if (classification === 'destructive') {
      result = {
        verdict: 'block', classification, layer: 2,
        reason: `Reviewer was unable to consult (${errMessage}) — blocking a destructive-tier action out of caution.`,
        suggestion: null, matchedRules, failMode: 'closed',
      };
    } else {
      result = {
        verdict: 'allow', classification, layer: 2,
        reason: `Reviewer was unable to consult (${errMessage}) — allowing a caution-tier action; the gap is logged.`,
        suggestion: null, matchedRules, failMode: 'open',
      };
    }
  }

  log.info('reviewer verdict', {
    toolId: action.toolId, classification, layer: result.layer, verdict: result.verdict,
    rules: matchedRules.join(',') || undefined,
  });

  persist(action, result);
  return result;
}

function persist(action, result) {
  appendReview({
    ts: new Date().toISOString(),
    toolId: action.toolId,
    classification: result.classification,
    verdict: result.verdict,
    layer: result.layer,
    matchedRules: result.matchedRules,
    failMode: result.failMode ?? null,
    reason: result.reason,
    suggestion: result.suggestion,
  });
}

export default { reviewAction };
