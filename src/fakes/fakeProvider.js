/**
 * @file A deterministic, scriptable stand-in for every model the engine can
 * call. Zero network, ever.
 *
 * It sits UNDER the real provider stack, not beside it: five `FakeUpstream`
 * providers (one per registry id) extend the real `BaseProvider`, so the
 * real semaphore, per-call deadline, `withRetry` with Retry-After, health
 * recording, and `Registry` failover all run exactly as they would against
 * Groq or Gemini — only `_doChat` is scripted. `FakeProviderAgent` is the
 * `phase2` pool the scheduler sees (a real `Phase2Agent` over that
 * registry) plus a registry-shaped `chat()` for the reviewer gate. What a
 * benchmark or a chaos test measures is therefore the engine, not a
 * shortcut around it.
 *
 * Why not `TITAN_DRY_RUN=1`: dry-run returns fixed fixtures and skips whole
 * branches (a sample graph, a no-op GitHub); a benchmark needs the *real*
 * paths fed by a provider whose behaviour is scripted — this reply, then
 * that fault, with this much latency, from this seed. The same fake powers
 * `titan simulate` and the chaos tests.
 *
 * Script shape (JSON or a plain object):
 *
 *   {
 *     "seed": 42,
 *     "latencyMs": [5, 20],                 // fixed number or [min, max]
 *     "rules": [
 *       { "kind": "decompose", "sequence": [{ "reply": "graph", "graph": {…} }] },
 *       { "kind": "subtask", "taskId": "api",
 *         "sequence": [{ "fault": "http-500" }, { "reply": "envelope", "files": [...] }] },
 *       { "kind": "review", "sequence": [{ "reply": "verdict", "verdict": "allow" }] },
 *       { "kind": "*", "sequence": [{ "reply": "prose", "text": "Done." }] }
 *     ]
 *   }
 *
 * Rules match in order on `kind` (`decompose` | `subtask` | `review` |
 * `probe` | `judge` | `chat` | `*`), optional `taskId`, optional
 * `promptIncludes`. Each rule keeps a cursor into its `sequence`; the last
 * entry repeats once the sequence is exhausted. Replies: `envelope` (files →
 * fenced JSON envelope), `prose`, `graph`, `verdict`, `raw`, `tool` (a
 * tool-call envelope). Faults: `malformed-json`, `truncated`, `refusal`,
 * `empty`, `http-500`, `http-503`, `http-429` (+`retryAfterMs`),
 * `quota-402`, `unauthorized-401`, `model-404`, `dropped-connection`,
 * `timeout` (+`hangMs`), `kill` (SIGKILL this process at call start — the
 * crash simulator); any reply may carry `thenKillAfterMs` to die *after*
 * replying. Every upstream call is logged as one JSON line on stdout
 * (`fake: "provider.call"`) and, when `logPath` is set, appended to that
 * file so a killed process still leaves its call count behind.
 */
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentAdapter } from '../agents/AgentAdapter.js';
import { Phase2Agent } from '../agents/phase2Agent.js';
import { BaseProvider } from '../providers/base.js';
import { ProviderHealthStore } from '../providers/health.js';
import { Registry, FAILOVER_ORDER } from '../providers/registry.js';
import { mulberry32, pick } from './rng.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Which kind of call is in flight, set by the pool around each registry call. */
const callContext = new AsyncLocalStorage();

function fakeError(code, status, message, retryable, retryAfterMs = null) {
  const err = new Error(message);
  return Object.assign(err, { name: 'FakeProviderError', code, status, retryable, retryAfterMs, service: 'fake' });
}

/** Builds the fenced envelope models are asked for. */
export function envelopeText(files, notes = '', prefix = '') {
  const body = JSON.stringify({ files: files ?? [], notes }, null, 0);
  return `${prefix}${prefix ? '\n\n' : ''}\`\`\`json\n${body}\n\`\`\``;
}

function classifyMessages(messages) {
  const system = (messages ?? []).find((m) => m.role === 'system')?.content ?? '';
  const user = (messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  if (/You are TITAN\. Evaluate/.test(system) || /Layer 1 \(deterministic\) classification/.test(user)) return 'review';
  if (/describing your own capabilities/.test(user)) return 'probe';
  if (/^You are the decomposer/m.test(user)) return 'decompose';
  if (/You are the verifier|acceptance criteria/i.test(system) || /^VERIFY:/m.test(user)) return 'judge';
  return 'chat';
}

/**
 * The script engine: rule matching, cursors, seeded latency, logging. One
 * instance is shared by the pool and its five upstream providers so the
 * call count and cursors are global to the process, as a real upstream's
 * behaviour would be.
 */
export class FakeScript {
  constructor({ script, logPath = null, quiet = false, pulseIndex = null } = {}) {
    this.script = normalizeScript(script ?? {});
    this.logPath = logPath;
    this.quiet = quiet;
    this.pulseIndex = pulseIndex;
    this.rng = mulberry32(this.script.seed);
    this.calls = 0;
    this.cursors = new Map();
    /** @type {Array<object>} */
    this.history = [];
  }

  next(kind, taskId, prompt) {
    for (let i = 0; i < this.script.rules.length; i += 1) {
      const rule = this.script.rules[i];
      if (rule.kind !== '*' && rule.kind !== kind) continue;
      if (rule.taskId && rule.taskId !== taskId) continue;
      if (rule.promptIncludes && !String(prompt).includes(rule.promptIncludes)) continue;
      const cursor = this.cursors.get(i) ?? 0;
      const seq = rule.sequence;
      const step = seq[Math.min(cursor, seq.length - 1)];
      this.cursors.set(i, cursor + 1);
      return step;
    }
    return { reply: 'prose', text: 'Acknowledged.' };
  }

  record(entry) {
    this.history.push(entry);
    const line = JSON.stringify({ fake: 'provider.call', ...entry });
    if (!this.quiet) process.stdout.write(`${line}\n`);
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, `${line}\n`);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Perform one scripted upstream call.
   * @param {{ kind: string, taskId: string|null, providerId: string, prompt: string, signal?: AbortSignal }} ctx
   * @returns {Promise<string>} The model text.
   */
  async perform(ctx) {
    const step = this.next(ctx.kind, ctx.taskId, ctx.prompt);
    this.calls += 1;
    const n = this.calls;
    const started = performance.now();
    const latency = pick(this.rng, step.latencyMs ?? this.script.latencyMs);
    const record = (outcome) => this.record({ n, pulse: this.pulseIndex, kind: ctx.kind, taskId: ctx.taskId, modelId: ctx.providerId, outcome, ms: Math.round(performance.now() - started), at: new Date().toISOString() });

    if (step.fault === 'kill') {
      record('fault:kill');
      process.kill(process.pid, 'SIGKILL');
      await sleep(10_000); // never reached; SIGKILL is not catchable
    }

    if (latency > 0) await sleep(latency);
    if (ctx.signal?.aborted) {
      record('aborted');
      throw fakeError('CANCELLED', null, 'aborted by caller', false);
    }

    if (step.fault) {
      record(`fault:${step.fault}`);
      switch (step.fault) {
        case 'http-500':
          throw fakeError('UPSTREAM_ERROR', 500, 'Fake upstream error (500)', true);
        case 'http-503':
          throw fakeError('UPSTREAM_ERROR', 503, 'Fake upstream unavailable (503)', true);
        case 'http-429':
          throw fakeError('RATE_LIMITED', 429, 'Fake rate limited (429)', true, step.retryAfterMs ?? 1000);
        case 'quota-402':
          throw fakeError('UPSTREAM_ERROR', 402, 'Fake insufficient_quota: out of credits', false);
        case 'unauthorized-401':
          throw fakeError('UNAUTHORIZED', 401, 'Fake rejected the request (401)', false);
        case 'model-404':
          throw fakeError('UPSTREAM_ERROR', 404, 'Fake model not found', false);
        case 'dropped-connection':
          throw Object.assign(fakeError('UPSTREAM_ERROR', null, 'Fake unreachable: socket hang up', true), { code: 'ECONNRESET' });
        case 'timeout': {
          const hang = step.hangMs ?? 300_000;
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, hang);
            timer.unref?.();
            ctx.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          throw fakeError('TASK_TIMEOUT', null, 'Fake call hung past its deadline', true);
        }
        case 'malformed-json':
          return '```json\n{"files": [ {"path": "src/broken.js", "content": "export const x = 1;\n```';
        case 'truncated': {
          const full = envelopeText(step.files ?? [{ path: 'src/truncated.js', content: 'export const x = 1;\n'.repeat(20) }]);
          return full.slice(0, Math.floor(full.length * 0.6));
        }
        case 'refusal':
          return "I'm sorry, but I can't help with that request.";
        case 'empty':
          return '';
        default:
          throw fakeError('UPSTREAM_ERROR', null, `unknown fake fault "${step.fault}"`, false);
      }
    }

    let text;
    switch (step.reply ?? 'prose') {
      case 'envelope':
        text = envelopeText(step.files ?? [], step.notes ?? '', step.prefix ?? '');
        break;
      case 'graph':
        text = JSON.stringify(step.graph ?? { sharedContext: 'fake', tasks: [] });
        break;
      case 'verdict':
        text = JSON.stringify({ verdict: step.verdict ?? 'allow', reason: step.reason ?? 'fake reviewer verdict', suggestion: step.suggestion ?? null });
        break;
      case 'tool':
        text = `\`\`\`json\n${JSON.stringify({ tool: step.tool, args: step.args ?? {} })}\n\`\`\``;
        break;
      case 'raw':
        text = String(step.text ?? '');
        break;
      case 'prose':
      default:
        text = String(step.text ?? 'Done.');
    }
    record(`reply:${step.reply ?? 'prose'}`);
    if (step.thenKillAfterMs != null) {
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), step.thenKillAfterMs);
    }
    return text;
  }
}

/** One scripted upstream behind the real BaseProvider contract. */
export class FakeUpstream extends BaseProvider {
  /** @param {{ id: string, engine: FakeScript, health?: object }} init */
  constructor({ id, engine, health }) {
    super({ id, label: `Fake ${id}`, apiKey: 'fake-key', model: `fake/${id}-model`, health });
    this.engine = engine;
  }

  async _doChat(messages, _opts, signal) {
    const ctx = callContext.getStore();
    const prompt = (messages ?? []).map((m) => m.content).join('\n');
    const kind = ctx?.kind ?? classifyMessages(messages);
    const text = await this.engine.perform({ kind, taskId: ctx?.taskId ?? null, providerId: this.id, prompt, signal });
    return { text, model: this.model, tokensUsed: Math.max(1, Math.round((prompt.length + text.length) / 4)) };
  }
}

/**
 * The `phase2` pool the scheduler drives: a real Phase2Agent over a real
 * Registry of five FakeUpstreams. `chat()` exposes the same registry to the
 * reviewer gate and any direct caller.
 */
export class FakeProviderAgent extends Phase2Agent {
  /**
   * @param {{ script?: object, logPath?: string|null, pulseIndex?: number|string|null, quiet?: boolean, health?: object, maxConcurrency?: number, providerIds?: string[] }} [init]
   */
  constructor(init = {}) {
    const engine = new FakeScript({ script: init.script, logPath: init.logPath, quiet: init.quiet, pulseIndex: init.pulseIndex });
    // The fake keeps its own health table (cooldowns, breaker state) so the
    // real registry logic runs against it; `healthPath` persists it across
    // pulses of a simulation, otherwise it lives in a throwaway file.
    const healthPath = init.healthPath ?? join(tmpdir(), `titan-fake-health-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const health = init.health ?? new ProviderHealthStore(healthPath);
    const ids = init.providerIds ?? FAILOVER_ORDER;
    for (const id of ids) health.markConfigured(id);
    const providers = new Map();
    for (const id of ids) providers.set(id, new FakeUpstream({ id, engine, health }));
    const registry = new Registry({ providers, healthStore: health });
    super({ registry, maxConcurrency: init.maxConcurrency ?? 5 });
    this.engine = engine;
    this.registry = registry;
    this.health = health;
    this.persistHealth = Boolean(init.healthPath || init.health);
  }

  isConfigured() {
    return true;
  }

  /** Called by the engine at the end of a pulse; persists the fake's health table when it was given a path. */
  flush() {
    if (this.persistHealth) this.health.save();
  }

  get calls() {
    return this.engine.calls;
  }

  get history() {
    return this.engine.history;
  }

  async _doExecute(task, sharedContext, options = {}) {
    const kind = task?.id === 'decompose' ? 'decompose' : 'subtask';
    return callContext.run({ kind, taskId: task?.id ?? null }, () => super._doExecute(task, sharedContext, options));
  }

  async _doProbeCapabilities(modelId, opts) {
    return callContext.run({ kind: 'probe', taskId: null }, () => super._doProbeCapabilities(modelId, opts));
  }

  /** Registry-shaped chat for the reviewer gate, the verifier, and direct callers. */
  async chat(messages, opts = {}) {
    return this.registry.chat(messages, opts);
  }
}

/** @param {object} raw @returns {{ seed: number, latencyMs: number|[number, number], rules: object[] }} */
export function normalizeScript(raw) {
  const script = raw && typeof raw === 'object' ? raw : {};
  return {
    seed: Number.isFinite(Number(script.seed)) ? Number(script.seed) : 1,
    latencyMs: script.latencyMs ?? 0,
    rules: Array.isArray(script.rules)
      ? script.rules.filter((r) => r && Array.isArray(r.sequence) && r.sequence.length > 0).map((r) => ({ ...r, kind: r.kind ?? '*' }))
      : [],
  };
}

/** A script that makes every kind of call succeed with a plausible reply —
 *  the default for `titan simulate` when no script is given. */
export function happyPathScript(overrides = {}) {
  return {
    seed: 7,
    latencyMs: [2, 8],
    rules: [
      { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
      { kind: 'judge', sequence: [{ reply: 'verdict', verdict: 'allow', reason: 'meets the acceptance criteria' }] },
      { kind: 'decompose', sequence: [{ reply: 'graph', graph: { sharedContext: 'A two-step fake project.', tasks: [
        { id: 'plan', title: 'Plan the module', aspect: 'architecture', description: 'Outline the module.', dependsOn: [], estimatedComplexity: 'low', deliverable: 'A short plan.' },
        { id: 'code', title: 'Write the module', aspect: 'code-generation', description: 'Implement it.', dependsOn: ['plan'], estimatedComplexity: 'medium', deliverable: 'src/module.js' },
      ] } }] },
      { kind: 'subtask', taskId: 'plan', sequence: [{ reply: 'prose', text: 'Plan: export one function.' }] },
      { kind: 'subtask', sequence: [{ reply: 'envelope', files: [{ path: 'src/module.js', content: 'export function fn() { return 1; }\n' }] }] },
      { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] },
    ],
    ...overrides,
  };
}

export { AgentAdapter };
export default FakeProviderAgent;
