/**
 * @file The one interface every agent pool implements — Freebuff, OpenCode,
 * and the Phase 2 five-provider wrapper.
 *
 * Mirrors `services/base.js`'s `BaseProvider` philosophy: cross-cutting
 * concerns (the concurrency gate, timing, never-throwing-across-the-
 * boundary, redacting error text before it can reach a log or the dashboard)
 * live here, once, so a concrete adapter is nothing but "how do I call this
 * pool and shape its answer". Subclasses override `_doExecute`,
 * `_doListModels`, and `_doProbeCapabilities` — never `execute`,
 * `listModels`, or `probeCapabilities` directly.
 *
 * Unlike `BaseProvider`, this base class does NOT branch on
 * `config.dryRun` itself. The three pools' offline stories differ too
 * much to unify: `phase2Agent.js` simply delegates to `services/registry.js`,
 * which already has its own complete offline/fixture path; `freebuffAgent.js`
 * and `opencodeAgent.js` read their own fixtures directly. Each subclass's
 * `_doExecute` decides.
 */

import { Semaphore } from '../lib/semaphore.js';
import { redactString } from '../lib/redact.js';
import { providerHealth } from '../providers/health.js';

/**
 * Pools tracked in `state/providers.json` health/dashboard terms. `phase2`
 * is deliberately excluded: it fans out to the five registry providers,
 * each already tracked individually by `providers/base.js#chat()` — a
 * top-level "phase2" health record would just duplicate and blur that.
 */
const HEALTH_TRACKED_POOLS = new Set(['freebuff', 'opencode']);

/**
 * @typedef {object} AdapterTask
 * @property {string} id
 * @property {string} title
 * @property {string} aspect One of taxonomy.js's ASPECT_CATEGORIES.
 * @property {string} description
 * @property {string} deliverable
 */

/**
 * @typedef {object} ExecuteResult
 * @property {boolean} ok
 * @property {string|null} output
 * @property {string|null} modelId
 * @property {number|null} tokensUsed
 * @property {number} ms
 * @property {{code: string, message: string}|null} error
 */

/** A failure a concrete adapter's `_doExecute`/`_doProbeCapabilities` can throw. */
export class AdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, retryable?: boolean, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AdapterError';
    this.code = opts.code ?? 'UPSTREAM_ERROR';
    this.retryable = opts.retryable ?? false;
  }
}

export class AgentAdapter {
  /** @type {Semaphore} */
  #gate;

  /**
   * @param {{ pool: string, label: string, maxConcurrency: number }} init
   */
  constructor(init) {
    if (new.target === AgentAdapter) {
      throw new TypeError('AgentAdapter is abstract; extend it with a concrete adapter.');
    }
    this.pool = init.pool;
    this.label = init.label;
    this.maxConcurrency = Math.max(1, Math.floor(Number(init.maxConcurrency) || 1));
    this.#gate = new Semaphore(this.maxConcurrency);
  }

  /** @returns {boolean} Whether this pool has what it needs to attempt a live call. */
  isConfigured() {
    return false;
  }

  /** @returns {number} */
  get inFlight() {
    return this.#gate.inFlight;
  }

  /** @returns {number} */
  get queued() {
    return this.#gate.queued;
  }

  /**
   * Run one task against this pool. Always resolves — the scheduler treats
   * every pool identically and branches on `.ok`, never on a thrown error.
   * @param {AdapterTask} task
   * @param {string} sharedContext
   * @param {{ modelId?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<ExecuteResult>}
   */
  async execute(task, sharedContext, options = {}) {
    const started = performance.now();
    const trackHealth = HEALTH_TRACKED_POOLS.has(this.pool);
    await this.#gate.acquire();
    try {
      const raw = await this._doExecute(task, sharedContext, options);
      const ms = Math.round(performance.now() - started);
      if (trackHealth) {
        providerHealth.recordOutcome(this.pool, { ok: true, latencyMs: ms, model: raw?.modelId ?? null });
      }
      return {
        ok: true,
        output: typeof raw?.output === 'string' ? raw.output : '',
        modelId: raw?.modelId ?? options.modelId ?? null,
        tokensUsed: Number.isFinite(raw?.tokensUsed) ? raw.tokensUsed : null,
        ms,
        error: null,
      };
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      if (trackHealth) {
        providerHealth.recordOutcome(this.pool, {
          ok: false,
          code: err?.code,
          status: err?.status ?? null,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        ok: false,
        output: null,
        modelId: options.modelId ?? null,
        tokensUsed: null,
        ms,
        error: {
          code: err?.code ?? 'UPSTREAM_ERROR',
          message: String(redactString(err instanceof Error ? err.message : String(err))),
        },
      };
    } finally {
      this.#gate.release();
    }
  }

  /** @returns {Promise<Array<{modelId: string, pool: string, contextWindow: number}>>} */
  async listModels() {
    return this._doListModels();
  }

  /**
   * @param {string} modelId
   * @param {{ strict?: boolean }} [opts]
   * @returns {Promise<string>} Raw model text — the caller (capabilityRegistry) parses it.
   */
  async probeCapabilities(modelId, opts = {}) {
    return this._doProbeCapabilities(modelId, opts);
  }

  /* ---- subclass hooks — never called in offline mode by the base class,   */
  /* each subclass decides its own offline behaviour inside these.          */

  /**
   * @param {AdapterTask} _task
   * @param {string} _sharedContext
   * @param {{ modelId?: string, signal?: AbortSignal }} _options
   * @returns {Promise<{output: string, modelId?: string, tokensUsed?: number|null}>}
   */
  async _doExecute(_task, _sharedContext, _options) {
    throw new Error(`${this.pool}: _doExecute() is not implemented`);
  }

  /** @returns {Promise<Array<{modelId: string, pool: string, contextWindow: number}>>} */
  async _doListModels() {
    throw new Error(`${this.pool}: _doListModels() is not implemented`);
  }

  /**
   * @param {string} _modelId
   * @param {{ strict?: boolean }} _opts
   * @returns {Promise<string>}
   */
  async _doProbeCapabilities(_modelId, _opts) {
    throw new Error(`${this.pool}: _doProbeCapabilities() is not implemented`);
  }

  /* ---- shared helper ------------------------------------------------------ */

  /**
   * Render one task into the single prompt string every adapter sends its
   * model. Centralised so all three pools format a task identically — a
   * synthesizer or a human reading three agents' raw output should not have
   * to mentally translate three different conventions.
   * @param {AdapterTask} task
   * @param {string} sharedContext Decomposer-generated project-wide context,
   *   injected into every agent's prompt (see decomposer.js). May be empty.
   * @returns {string}
   */
  _buildTaskPrompt(task, sharedContext) {
    const lines = [];
    if (sharedContext) {
      lines.push(`Shared project context:\n${sharedContext}`);
    }
    lines.push(`Task: ${task.title}`);
    lines.push(`Aspect: ${task.aspect}`);
    lines.push(`Description: ${task.description}`);
    lines.push(`Expected deliverable: ${task.deliverable}`);
    lines.push(
      'Produce your output now. If your output includes one or more files, put them in a ' +
        'single fenced JSON code block matching exactly this shape: ' +
        '{"files":[{"path":"<relative path>","content":"<full file content>"}],"notes":"<optional>"}. ' +
        'Every file goes in that one array — do not use separate code blocks per file. If your ' +
        'answer has no files (a description, a plan, an analysis), just write normal prose with ' +
        'no JSON block at all.',
    );
    return lines.join('\n\n');
  }
}

export default AgentAdapter;
