/**
 * @file A deterministic, scriptable stand-in for every model the engine can
 * call: the agent-pool interface (`AgentAdapter`) for decomposition and
 * sub-task execution, and the registry-style `chat()` the reviewer gate and
 * any direct caller use. Zero network, ever.
 *
 * Why it exists: `TITAN_DRY_RUN=1` returns fixed fixtures and skips whole
 * branches (decomposition returns a sample graph, GitHub is a no-op), which
 * is right for a smoke test and wrong for measuring the engine — a benchmark
 * needs the *real* code paths (real decomposition parsing, real retries,
 * real synthesis) fed by a provider whose behaviour is scripted: this reply,
 * then that fault, with this much latency, from this seed. The same fake is
 * what `titan simulate` runs against and what the chaos tests drive.
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
 * `probe` | `chat` | `*`), optional `taskId`, optional `promptIncludes`.
 * Each rule keeps a cursor into its `sequence`; the last entry repeats once
 * the sequence is exhausted. Replies: `envelope` (files → fenced JSON
 * envelope), `prose`, `graph`, `verdict`, `raw`, `tool` (a tool-call
 * envelope, see engine/toolLoop). Faults: `malformed-json`, `truncated`,
 * `refusal`, `empty`, `http-500`, `http-429` (+`retryAfterMs`), `quota-402`,
 * `unauthorized-401`, `model-404`, `dropped-connection`, `timeout`
 * (+`hangMs`), `kill` (SIGKILL this process at call start — the crash
 * simulator), and any reply may carry `thenKillAfterMs` to die *after*
 * replying. Every call is logged as one JSON line on stdout (`fake:
 * "provider.call"`) and, when `logPath` is set, appended to that file so a
 * killed process still leaves its call count behind.
 */
import { appendFileSync } from 'node:fs';
import { AgentAdapter } from '../agents/AgentAdapter.js';
import { mulberry32, pick } from './rng.js';

const DEFAULT_MODELS = ['phase2:groq', 'phase2:together', 'phase2:openrouter', 'phase2:gemini', 'phase2:huggingface'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {unknown} err @returns {Error & {code: string, status: number|null, retryable: boolean, retryAfterMs: number|null}} */
function fakeError(code, status, message, retryable, retryAfterMs = null) {
  const err = new Error(message);
  return Object.assign(err, { name: 'FakeProviderError', code, status, retryable, retryAfterMs, service: 'fake' });
}

/** Builds the fenced envelope models are asked for. */
export function envelopeText(files, notes = '', prefix = '') {
  const body = JSON.stringify({ files: files ?? [], notes }, null, 0);
  return `${prefix}${prefix ? '\n\n' : ''}\`\`\`json\n${body}\n\`\`\``;
}

function classify(task, messages) {
  if (task) return task.id === 'decompose' ? 'decompose' : 'subtask';
  const system = (messages ?? []).find((m) => m.role === 'system')?.content ?? '';
  const user = (messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  if (/You are TITAN\. Evaluate/.test(system) || /Layer 1 \(deterministic\) classification/.test(user)) return 'review';
  if (/describing your own capabilities/.test(user)) return 'probe';
  if (/^You are the decomposer/.test(user)) return 'decompose';
  return 'chat';
}

export class FakeProviderAgent extends AgentAdapter {
  /**
   * @param {{ script?: object, models?: string[], logPath?: string|null, pool?: string, maxConcurrency?: number, quiet?: boolean }} [init]
   */
  constructor(init = {}) {
    super({ pool: init.pool ?? 'phase2', label: 'Fake provider', maxConcurrency: init.maxConcurrency ?? 5 });
    this.script = normalizeScript(init.script ?? {});
    this.models = init.models ?? DEFAULT_MODELS;
    this.logPath = init.logPath ?? null;
    this.quiet = init.quiet ?? false;
    this.rng = mulberry32(this.script.seed);
    this.calls = 0;
    this.cursors = new Map();
    /** @type {Array<{n:number, kind:string, taskId:string|null, modelId:string|null, outcome:string, ms:number}>} */
    this.history = [];
  }

  isConfigured() {
    return true;
  }

  async _doListModels() {
    return this.models.map((modelId) => ({ modelId, pool: this.pool, contextWindow: 32768 }));
  }

  async _doExecute(task, sharedContext, options = {}) {
    const kind = classify(task, null);
    const prompt = this._buildTaskPrompt(task, sharedContext);
    const step = this.#next(kind, task.id, prompt);
    const text = await this.#perform(step, { kind, taskId: task.id, modelId: options.modelId ?? null, signal: options.signal });
    return { output: text, modelId: options.modelId ?? this.models[0], tokensUsed: Math.max(1, Math.round(text.length / 4)) };
  }

  async _doProbeCapabilities(modelId) {
    const step = this.#next('probe', null, modelId);
    return this.#perform(step, { kind: 'probe', taskId: null, modelId });
  }

  /**
   * Registry-shaped chat, for the reviewer gate and direct callers.
   * @param {Array<{role:string, content:string}>} messages
   * @param {{ service?: string, signal?: AbortSignal, maxTokens?: number, temperature?: number }} [opts]
   */
  async chat(messages, opts = {}) {
    const kind = classify(null, messages);
    const prompt = (messages ?? []).map((m) => m.content).join('\n');
    const step = this.#next(kind, null, prompt);
    const started = performance.now();
    const text = await this.#perform(step, { kind, taskId: null, modelId: opts.service ?? 'fake', signal: opts.signal });
    return { text, service: 'fake', model: opts.service ?? 'fake', latencyMs: Math.round(performance.now() - started), tokensUsed: Math.max(1, Math.round(text.length / 4)), attempts: 1 };
  }

  /* ---- internals --------------------------------------------------------- */

  #next(kind, taskId, prompt) {
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

  async #perform(step, ctx) {
    this.calls += 1;
    const n = this.calls;
    const started = performance.now();
    const latency = pick(this.rng, step.latencyMs ?? this.script.latencyMs);
    const record = (outcome) => {
      const entry = { n, kind: ctx.kind, taskId: ctx.taskId, modelId: ctx.modelId, outcome, ms: Math.round(performance.now() - started) };
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
    };

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

export default FakeProviderAgent;
