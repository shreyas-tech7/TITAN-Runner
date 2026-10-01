/**
 * @file The Hermes agent cluster's client side: read 2-3 instances from the
 * environment, pick which one a piece of work goes to by SPECIALIZATION, and
 * dispatch to it with failover. Client code only — the instances themselves
 * (Railway services running Hermes Agent) are provisioned by a human, and
 * nothing in the pulse calls this yet. See docs/RUNTIME.md "Hermes agent
 * cluster" for what is built vs. what is waiting on infrastructure.
 *
 * Configuration, same shape as the OmniRoute and provider variables in
 * `.env.example` (all optional; nothing set = the cluster does not exist):
 *
 *   HERMES_<N>_BASE_URL         N = 1..3. https only (http for localhost).
 *   HERMES_<N>_API_KEY          required: an instance with no key is NOT used
 *   HERMES_<N>_MODEL            optional, default "hermes-agent"
 *   HERMES_<N>_CHAT_PATH        optional, default /v1/chat/completions
 *   HERMES_<N>_SPECIALIZATION   optional, comma-separated aspect names from
 *                               orchestrator/taxonomy.js (e.g.
 *                               "code-generation,refactoring"); empty = generalist
 *   HERMES_<N>_NAME             optional label, default "hermes-<N>"
 *
 * The meta-router reuses the concept `router.js` already has — a task's
 * `aspect` against what a worker is strong at — in miniature: an instance
 * specialized in the task's aspect first, then generalists, then any other
 * instance as a last resort, with in-flight load and recent failures breaking
 * ties. Secrets never appear in `describe()`, warnings, or errors.
 */
import { ASPECT_CATEGORIES } from './taxonomy.js';
import { HermesProvider } from '../providers/hermes.js';
import { redactString } from '../lib/redact.js';

export const MAX_HERMES_INSTANCES = 3;
const MAX_DISPATCH_INSTANCES = 2;
const COOLDOWN_AFTER_FAILURES = 2;
const COOLDOWN_MS = 5 * 60_000;
const MAX_ERROR_CHARS = 200;
const PLACEHOLDER = /^(?:your[_-].*|<.*>|xxx+|changeme|todo|tbd|none|null|placeholder)$/i;

/** @param {unknown} raw */
function clean(raw) {
  if (typeof raw !== 'string') return '';
  const v = raw.trim();
  return v === '' || PLACEHOLDER.test(v) ? '' : v;
}

/** @param {string} raw @returns {URL|null} */
function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url;
  return null;
}

/**
 * @typedef {object} HermesInstanceConfig
 * @property {number} index 1..3
 * @property {string} id `hermes-<N>`
 * @property {string} name
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {string} chatPath
 * @property {string[]} specialization Aspect names; empty = generalist.
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ instances: HermesInstanceConfig[], warnings: string[] }}
 */
export function loadHermesInstances(env = process.env) {
  const instances = [];
  const warnings = [];
  for (let n = 1; n <= MAX_HERMES_INSTANCES; n += 1) {
    const rawUrl = clean(env[`HERMES_${n}_BASE_URL`]);
    if (!rawUrl) continue;
    const label = `HERMES_${n}`;
    const url = parseBaseUrl(rawUrl);
    if (!url) {
      warnings.push(`${label}_BASE_URL ignored: it must be an https URL (http only for localhost) with no credentials in it`);
      continue;
    }
    const apiKey = clean(env[`${label}_API_KEY`]);
    if (!apiKey) {
      warnings.push(`${label} (${url.origin}) ignored: ${label}_API_KEY is required — an agent endpoint without authentication is never called`);
      continue;
    }
    const specialization = [];
    for (const word of String(env[`${label}_SPECIALIZATION`] ?? '').split(/[\s,]+/).filter(Boolean)) {
      const aspect = word.toLowerCase();
      if (aspect === 'any' || aspect === 'general') continue;
      if (ASPECT_CATEGORIES.includes(aspect)) {
        if (!specialization.includes(aspect)) specialization.push(aspect);
      } else {
        warnings.push(`${label}_SPECIALIZATION: "${word.slice(0, 40)}" is not a known aspect (${ASPECT_CATEGORIES.join(', ')}) and was dropped`);
      }
    }
    const name = clean(env[`${label}_NAME`]).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || `hermes-${n}`;
    instances.push({
      index: n,
      id: `hermes-${n}`,
      name,
      baseUrl: url.origin + url.pathname.replace(/\/+$/, ''),
      apiKey,
      model: clean(env[`${label}_MODEL`]),
      chatPath: clean(env[`${label}_CHAT_PATH`]),
      specialization,
    });
  }
  return { instances, warnings };
}

/**
 * Rank instances for one task aspect, best first. Pure.
 * @param {string|undefined} aspect
 * @param {Array<{ id: string, specialization: string[] }>} instances
 * @param {{ inFlight?: Map<string, number>, coolingDown?: Set<string> }} [state]
 * @returns {Array<{ id: string, score: number, reason: string }>}
 */
export function rankInstances(aspect, instances, state = {}) {
  const inFlight = state.inFlight ?? new Map();
  const cooling = state.coolingDown ?? new Set();
  const ranked = instances.map((inst, position) => {
    const special = inst.specialization ?? [];
    let score;
    let reason;
    if (aspect && special.includes(aspect)) {
      score = 100;
      reason = `specialized in ${aspect}`;
    } else if (special.length === 0) {
      score = 10;
      reason = 'generalist';
    } else {
      score = 1;
      reason = `last resort: specialized in ${special.join(', ')}`;
    }
    if (cooling.has(inst.id)) {
      // Behind every healthy instance, whatever its specialization.
      score -= 1000;
      reason += ' (cooling down after repeated failures)';
    }
    return { id: inst.id, score, reason, load: inFlight.get(inst.id) ?? 0, position };
  });
  ranked.sort((a, b) => b.score - a.score || a.load - b.load || a.position - b.position);
  return ranked.map(({ id, score, reason }) => ({ id, score, reason }));
}

/**
 * @param {{ id?: string, title?: string, aspect?: string, description?: string, deliverable?: string }} task
 * @param {string} [sharedContext]
 */
export function buildHermesMessages(task, sharedContext = '') {
  const parts = [
    `Task: ${task.title ?? task.id ?? 'untitled'}`,
    task.aspect ? `Area: ${task.aspect}` : null,
    task.description ? `\n${task.description}` : null,
    task.deliverable ? `\nDeliverable: ${task.deliverable}` : null,
    sharedContext ? `\nShared context:\n${sharedContext}` : null,
  ].filter(Boolean);
  return [
    { role: 'system', content: 'You are one specialist agent in a small cluster working for TITAN-Runner. Do the task you are given and reply with the result only. Do not ask questions; state your assumptions instead.' },
    { role: 'user', content: parts.join('\n') },
  ];
}

/** Remove every literal occurrence of a known secret, then the usual credential-shaped patterns. */
function scrubText(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  return redactString(out);
}

export class HermesCluster {
  /**
   * @param {{ instances?: HermesInstanceConfig[], env?: NodeJS.ProcessEnv, fetchImpl?: Function, now?: () => number, cooldownMs?: number }} [opts]
   *   `instances` defaults to whatever the environment configures.
   */
  constructor(opts = {}) {
    const loaded = opts.instances ? { instances: opts.instances, warnings: [] } : loadHermesInstances(opts.env ?? process.env);
    this.warnings = loaded.warnings;
    this.now = opts.now ?? (() => Date.now());
    this.cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
    /** @type {Map<string, HermesProvider>} */
    this.providers = new Map(loaded.instances.map((c) => [c.id, new HermesProvider({ ...c, label: c.name, fetchImpl: opts.fetchImpl })]));
    this.inFlight = new Map();
    this.failures = new Map();
    this.coolingUntil = new Map();
    /** The instances' own keys: scrubbed literally from every error and reply this class hands back. */
    this.secrets = loaded.instances.map((c) => c.apiKey).filter(Boolean);
  }

  #scrub(text) {
    return scrubText(text, this.secrets);
  }

  #errText(err) {
    return this.#scrub(err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
  }

  isConfigured() {
    return [...this.providers.values()].some((p) => p.isConfigured());
  }

  /** What is configured, with no secrets in it. */
  describe() {
    return [...this.providers.values()].map((p) => ({
      id: p.id, name: p.label, origin: new URL(p.baseUrl).origin, model: p.model, chatPath: p.chatPath,
      specialization: p.specialization.length > 0 ? [...p.specialization] : ['generalist'],
    }));
  }

  #coolingSet() {
    const t = this.now();
    return new Set([...this.coolingUntil].filter(([, until]) => until > t).map(([id]) => id));
  }

  /** Instances in the order a task with this aspect would be tried. */
  route(aspect) {
    const usable = [...this.providers.values()].filter((p) => p.isConfigured());
    return rankInstances(aspect, usable, { inFlight: this.inFlight, coolingDown: this.#coolingSet() });
  }

  #recordFailure(id) {
    const n = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, n);
    if (n >= COOLDOWN_AFTER_FAILURES) this.coolingUntil.set(id, this.now() + this.cooldownMs);
  }

  #recordSuccess(id) {
    this.failures.delete(id);
    this.coolingUntil.delete(id);
  }

  /**
   * Run one piece of work on the best-suited instance, falling back to the
   * next on failure (at most `maxInstances`). Never throws.
   * @param {Parameters<typeof buildHermesMessages>[0]} task
   * @param {{ sharedContext?: string, signal?: AbortSignal, maxInstances?: number, temperature?: number, maxTokens?: number }} [opts]
   * @returns {Promise<{ ok: boolean, text: string|null, instance: string|null, model: string|null, tried: Array<{id: string, ok: boolean, ms: number, error?: string}>, route: Array<{id: string, score: number, reason: string}>, error: {code: string, message: string}|null }>}
   */
  async dispatch(task, opts = {}) {
    const route = this.route(task?.aspect);
    const tried = [];
    const fail = (code, message) => ({ ok: false, text: null, instance: null, model: null, tried, route, error: { code, message } });
    if (route.length === 0) return fail('NOT_CONFIGURED', 'no Hermes instance is configured (set HERMES_1_BASE_URL and HERMES_1_API_KEY)');

    const messages = buildHermesMessages(task, opts.sharedContext);
    const limit = Math.max(1, Math.min(opts.maxInstances ?? MAX_DISPATCH_INSTANCES, route.length));
    for (const candidate of route.slice(0, limit)) {
      if (opts.signal?.aborted) return fail('ABORTED', 'dispatch aborted');
      const provider = this.providers.get(candidate.id);
      const started = performance.now();
      this.inFlight.set(candidate.id, (this.inFlight.get(candidate.id) ?? 0) + 1);
      try {
        const out = await provider.chat(messages, { signal: opts.signal, temperature: opts.temperature, maxTokens: opts.maxTokens });
        tried.push({ id: candidate.id, ok: true, ms: Math.round(performance.now() - started) });
        this.#recordSuccess(candidate.id);
        return { ok: true, text: this.#scrub(out.text), instance: candidate.id, model: out.model ?? provider.model, tried, route, error: null };
      } catch (err) {
        tried.push({ id: candidate.id, ok: false, ms: Math.round(performance.now() - started), error: this.#errText(err) });
        this.#recordFailure(candidate.id);
        if (opts.signal?.aborted) return fail('ABORTED', 'dispatch aborted');
      } finally {
        this.inFlight.set(candidate.id, Math.max(0, (this.inFlight.get(candidate.id) ?? 1) - 1));
      }
    }
    return fail('ALL_INSTANCES_FAILED', `no Hermes instance answered (tried: ${tried.map((t) => t.id).join(', ')})`);
  }

  /**
   * Cheap liveness check for each configured instance: one tiny chat call.
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async ping(opts = {}) {
    const results = [];
    for (const provider of this.providers.values()) {
      const started = performance.now();
      try {
        const out = await provider.chat([{ role: 'user', content: 'Reply with the single word: pong' }], { maxTokens: 16, temperature: 0, signal: opts.signal });
        results.push({ id: provider.id, name: provider.label, ok: true, ms: Math.round(performance.now() - started), model: out.model, sample: this.#scrub(out.text).slice(0, 60) });
      } catch (err) {
        results.push({ id: provider.id, name: provider.label, ok: false, ms: Math.round(performance.now() - started), error: this.#errText(err) });
      }
    }
    return results;
  }
}

export default { HermesCluster, loadHermesInstances, rankInstances, buildHermesMessages, MAX_HERMES_INSTANCES };
