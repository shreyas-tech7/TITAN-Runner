/**
 * @file Adapter that wraps the existing five-provider AI registry
 * (`services/registry.js`) behind the `AgentAdapter` interface, so the
 * orchestrator's scheduler can treat "one of the five Phase 2 providers" as
 * just another agent pool alongside `freebuff` and `opencode`.
 *
 * This is a thin pass-through: `services/registry.js` already owns discovery,
 * failover, health caching, and offline-fixture behaviour end to end, so none
 * of that is duplicated here — this file's only job is shaping calls in and
 * results out. The registry dependency is injectable (`registryDep`,
 * defaulting to the real singleton) so tests can prove a full success path
 * with a fake `chat()` that resolves synchronously and does zero I/O. A real
 * `Registry` in this test environment has no provider keys configured and can
 * only ever exercise the ALL_PROVIDERS_FAILED path (see registry.test.js) —
 * that is not sufficient to prove this adapter's happy path works.
 *
 * NOTE on `_buildTaskPrompt`: `AgentAdapter.js` was expected to provide a
 * shared `this._buildTaskPrompt(task, sharedContext)` helper, but as of this
 * writing it does not define one (checked by reading the file in full — no
 * such method exists on `main` or `phase-3-orchestrator`). Rather than add a
 * method to a base class that two other in-flight adapters
 * (`freebuffAgent.js`, `opencodeAgent.js`) extend in parallel — risking an
 * uncoordinated three-way merge conflict on shared infrastructure — this file
 * defines its own equivalent `buildTaskPrompt()` below, scoped to this pool
 * only. If the base class later grows a real `_buildTaskPrompt`, this local
 * copy should be deleted in favour of it.
 */

import { AgentAdapter } from './AgentAdapter.js';
import { registry } from '../providers/registry.js';
import { isProviderConfigured } from '../config.js';
import { buildProbePrompt } from '../orchestrator/capabilityRegistry.js';

/** This adapter's pool name, per taxonomy.js's AGENT_POOLS. */
const POOL = 'phase2';

/** The five provider ids `services/registry.js` owns, in its own FAILOVER_ORDER. */
const PROVIDER_IDS = ['groq', 'openrouter', 'together', 'gemini', 'huggingface'];

/**
 * Context-window figures mirror `capabilityRegistry.js`'s SEED_TABLE for the
 * same five `phase2:*` model ids, so a caller reading either module gets a
 * consistent number instead of two independently-guessed ones.
 * @type {Record<string, number>}
 */
const CONTEXT_WINDOWS = {
  groq: 32768,
  openrouter: 32768,
  together: 32768,
  gemini: 1048576,
  huggingface: 8192,
};

/**
 * Strip the `"phase2:"` pool prefix a capability-record modelId carries
 * (`"phase2:groq"`) down to the bare provider id `registry.chat()` expects
 * (`"groq"`). Values that never had the prefix pass through unchanged, so
 * this is safe to call on either shape.
 * @param {string} modelId
 * @returns {string}
 */
function stripPoolPrefix(modelId) {
  const prefix = `${POOL}:`;
  return typeof modelId === 'string' && modelId.startsWith(prefix)
    ? modelId.slice(prefix.length)
    : modelId;
}

/**
 * Format a task and its shared run context into one user-turn prompt. Local
 * stand-in for a base-class `_buildTaskPrompt()` that does not exist yet —
 * see the file header note.
 * @param {import('./AgentAdapter.js').AdapterTask} task
 * @param {string} sharedContext
 * @returns {string}
 */
function buildTaskPrompt(task, sharedContext) {
  const body = [
    `Task: ${task?.title ?? task?.id ?? 'untitled'}`,
    `Aspect: ${task?.aspect ?? 'unspecified'}`,
    '',
    task?.description ?? '',
    '',
    `Deliverable: ${task?.deliverable ?? ''}`,
  ]
    .join('\n')
    .trim();
  return sharedContext ? `${sharedContext}\n\n${body}` : body;
}

/**
 * Adapts `services/registry.js`'s five-provider chat routing to the
 * `AgentAdapter` interface. See the file header for the DI rationale.
 */
export class Phase2Agent extends AgentAdapter {
  /**
   * @param {{ registry?: import('../services/registry.js').Registry, maxConcurrency?: number }} [init]
   */
  constructor({ registry: registryDep = registry, maxConcurrency = 5 } = {}) {
    super({ pool: POOL, label: 'Phase 2 (5-provider registry)', maxConcurrency });
    this.registryDep = registryDep;
  }

  /**
   * Synchronous by design: `registryDep.listProviders()` is async and runs
   * health checks, which is overkill for "is this pool worth trying at all".
   * True when at least one of the five underlying providers has a key.
   * @returns {boolean}
   */
  isConfigured() {
    return PROVIDER_IDS.some((id) => isProviderConfigured(id));
  }

  /**
   * @param {import('./AgentAdapter.js').AdapterTask} task
   * @param {string} sharedContext
   * @param {{ modelId?: string, signal?: AbortSignal }} options
   * @returns {Promise<{output: string, modelId: string, tokensUsed: number|null}>}
   */
  async _doExecute(task, sharedContext, options) {
    /** @type {import('../services/base.js').ChatMessage[]} */
    const messages = [{ role: 'user', content: buildTaskPrompt(task, sharedContext) }];
    const service = /** @type {import('../services/registry.js').RouteTarget} */ (
      options.modelId ? stripPoolPrefix(options.modelId) : 'auto'
    );

    // Any throw here (a ProviderError, already carrying `.code`) propagates
    // untouched — the base class's execute() wrapper catches, redacts, and
    // shapes it. Nothing to catch on this side.
    const result = await this.registryDep.chat(messages, {
      taskType: 'code',
      service: /** @type {import('../services/registry.js').RouteTarget} */ (service),
      signal: options.signal,
    });

    return {
      output: result.text,
      modelId: `${POOL}:${result.service}`,
      tokensUsed: result.tokensUsed,
    };
  }

  /**
   * Static list rather than `registryDep.listProviders()` — the latter is
   * safe here (60s health cache, never forces a fresh probe) but a fixed list
   * is simpler and this data barely ever changes.
   * @returns {Promise<Array<{modelId: string, pool: string, contextWindow: number}>>}
   */
  async _doListModels() {
    return PROVIDER_IDS.map((id) => ({
      modelId: `${POOL}:${id}`,
      pool: POOL,
      contextWindow: CONTEXT_WINDOWS[id],
    }));
  }

  /**
   * Returns the model's raw probe response text; `capabilityRegistry.js`'s
   * `parseProbeJson`/`sanitizeProbeResult` do the defensive parsing on the
   * caller's side. A throw here propagates — `probeModel()` already catches
   * probe failures and falls back to the seed table.
   * @param {string} modelId
   * @param {{ strict?: boolean }} opts
   * @returns {Promise<string>}
   */
  async _doProbeCapabilities(modelId, opts) {
    const providerId = stripPoolPrefix(modelId);
    const probePrompt = buildProbePrompt(modelId, opts);
    const result = await this.registryDep.chat(
      /** @type {import('../services/base.js').ChatMessage[]} */ ([{ role: 'user', content: probePrompt }]),
      {
        taskType: 'analysis',
        service: /** @type {import('../services/registry.js').RouteTarget} */ (providerId),
      },
    );
    return result.text;
  }
}

export default Phase2Agent;
