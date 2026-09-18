/**
 * @file The tool registry: every action a model can ask the engine to take
 * on its behalf, declared once with a typed argument schema, a side-effect
 * class, a risk level, a timeout, and whether repeating it is harmless.
 *
 * `invoke()` is the only way a tool runs, and it does the same things for
 * every tool, in this order:
 *   1. the tool must exist and its arguments must match the schema
 *      (`lib/validate.js`) — a model cannot pass what the tool did not declare;
 *   2. the Reviewer Gate's deterministic layer (`reviewer/policy.js`) must not
 *      classify the call as destructive;
 *   3. the policy engine (`policy/engine.js`) must allow it at the current
 *      autonomy level — or the call waits for `/titan approve <key>`;
 *   4. a non-idempotent side effect that already ran (same tool, same args,
 *      recorded in the task's checkpoint ledger) is not run again;
 *   5. the tool runs under its timeout; its output is capped and redacted.
 * The result is always a value, never a throw, and every call is one
 * `tool.call` event.
 */
import { check } from '../lib/validate.js';
import { redactString } from '../lib/redact.js';
import { classifyAction } from '../reviewer/policy.js';
import { decide } from '../policy/engine.js';
import { createHash } from 'node:crypto';

export const MAX_TOOL_OUTPUT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} ToolDefinition
 * @property {string} id `^[a-z][a-z0-9_]{1,40}$`
 * @property {string} description One line for the model.
 * @property {'read'|'local_write'|'external'} effect
 * @property {'low'|'medium'|'high'} riskLevel
 * @property {object} schema JSON-Schema-ish (lib/validate.js) for `args`.
 * @property {boolean} [idempotent] Repeating the call with the same args is harmless (reads are).
 * @property {number} [timeoutMs]
 * @property {(args: Record<string, unknown>, ctx: object) => Promise<string|object>} run
 */

export class ToolRegistry {
  /** @type {Map<string, ToolDefinition>} */
  #tools = new Map();

  /** @param {ToolDefinition} def */
  register(def) {
    if (!def || typeof def.id !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(def.id)) throw new Error('tool id must match ^[a-z][a-z0-9_]{1,40}$');
    if (!['read', 'local_write', 'external'].includes(def.effect)) throw new Error(`tool ${def.id}: effect must be read | local_write | external`);
    if (typeof def.run !== 'function') throw new Error(`tool ${def.id}: run() is required`);
    if (!def.schema || typeof def.schema !== 'object') throw new Error(`tool ${def.id}: a schema is required`);
    this.#tools.set(def.id, { idempotent: def.effect === 'read', riskLevel: 'medium', timeoutMs: DEFAULT_TIMEOUT_MS, ...def });
    return this;
  }

  get(id) {
    return this.#tools.get(id) ?? null;
  }

  list() {
    return [...this.#tools.values()];
  }

  get size() {
    return this.#tools.size;
  }

  /** The one-line-per-tool catalogue the prompt carries. */
  describeForPrompt() {
    return this.list().map((t) => `- ${t.id} (${t.effect}): ${t.description} args: ${JSON.stringify(schemaSummary(t.schema))}`).join('\n');
  }

  /**
   * @param {{ tool: string, args?: Record<string, unknown> }} call
   * @param {{
   *   control?: object, task?: object, taskId?: string|null, stepId?: string|null,
   *   ledger?: Record<string, object>, events?: { append: Function }|null,
   *   now?: () => Date, signal?: AbortSignal, [k: string]: unknown,
   * }} [ctx]
   * @returns {Promise<{ ok: boolean, output: string, error: null | { code: string, message: string, class?: string, approvalKey?: string }, effect: string, ms: number, cached?: boolean, decision?: object }>}
   */
  async invoke(call, ctx = {}) {
    const started = performance.now();
    const now = ctx.now ?? (() => new Date());
    const events = ctx.events ?? null;
    const finish = (result) => {
      const ms = Math.round(performance.now() - started);
      const out = { ...result, ms };
      events?.append('tool.call', {
        taskId: ctx.taskId ?? null, stepId: ctx.stepId ?? null, toolCallId: out.callId ?? null, tool: call?.tool ?? null, effect: out.effect ?? null,
        outcome: out.ok ? (out.cached ? 'replayed' : 'ok') : out.error?.code ?? 'error', durationMs: ms, decision: out.decision?.decision ?? null, audit: out.effect !== 'read',
      });
      return out;
    };

    const def = typeof call?.tool === 'string' ? this.#tools.get(call.tool) : null;
    if (!def) return finish({ ok: false, output: '', error: { code: 'TOOL_UNKNOWN', message: `no such tool: ${String(call?.tool ?? '').slice(0, 60)}` }, effect: 'read' });
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const callId = `${def.id}:${createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 12)}`;

    const valid = check(args, def.schema);
    if (!valid.ok) return finish({ ok: false, callId, output: '', error: { code: 'TOOL_INVALID_ARGS', message: `invalid arguments: ${valid.errors.slice(0, 3).join('; ')}` }, effect: def.effect });

    // Reviewer Gate, deterministic layer: a destructive pattern is refused
    // outright, whatever the autonomy level says.
    const gate = classifyAction({ toolId: def.id, args, effect: def.effect, riskLevel: def.riskLevel });
    if (gate.classification === 'destructive') {
      return finish({ ok: false, callId, output: '', error: { code: 'TOOL_DENIED', class: 'policy_blocked', message: `refused by the reviewer gate: ${gate.reasons.join('; ')}` }, effect: def.effect, decision: { decision: 'deny', reason: 'reviewer gate', matchedRules: gate.matchedRules } });
    }

    const decision = decide({ action: { kind: 'tool', toolId: def.id, effect: def.effect, args }, control: ctx.control ?? {}, task: ctx.task ?? {} });
    events?.append('policy.decision', { taskId: ctx.taskId ?? null, stepId: ctx.stepId ?? null, action: `tool:${def.id}`, effect: def.effect, outcome: decision.decision, reason: decision.reason, approvalKey: decision.approvalKey, autonomy: decision.autonomy, audit: true });
    if (decision.decision === 'deny') return finish({ ok: false, callId, output: '', error: { code: 'TOOL_DENIED', class: 'policy_blocked', message: `not allowed: ${decision.reason}` }, effect: def.effect, decision });
    if (decision.decision === 'approve') return finish({ ok: false, callId, output: '', error: { code: 'APPROVAL_REQUIRED', message: decision.reason, approvalKey: decision.approvalKey }, effect: def.effect, decision });

    // Idempotency: a side effect that already ran is replayed from the ledger.
    const ledger = ctx.ledger ?? null;
    if (ledger && !def.idempotent && ledger[callId]?.ok) {
      return finish({ ok: true, callId, output: ledger[callId].output ?? '', error: null, effect: def.effect, cached: true, decision });
    }

    let output;
    try {
      output = await withTimeout(def.run(args, { ...ctx, callId }), def.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx.signal);
    } catch (err) {
      const code = err?.code === 'TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'TOOL_ERROR';
      const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (ledger && !def.idempotent) ledger[callId] = { ok: false, at: now().toISOString(), error: message };
      return finish({ ok: false, callId, output: '', error: { code, class: 'tool_error', message }, effect: def.effect, decision });
    }
    const text = redactString(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
    const capped = text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars]` : text;
    if (ledger && !def.idempotent) ledger[callId] = { ok: true, at: now().toISOString(), output: capped.slice(0, 2000) };
    return finish({ ok: true, callId, output: capped, error: null, effect: def.effect, decision });
  }
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`tool timed out after ${ms} ms`), { code: 'TOOL_TIMEOUT' })), ms);
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** `{path: 'string', maxBytes: 'integer?'}` — enough for a model to call it right. */
function schemaSummary(schema) {
  const out = {};
  const required = new Set(schema.required ?? []);
  for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = `${v.type ?? (v.enum ? v.enum.join('|') : 'any')}${required.has(k) ? '' : '?'}`;
  return out;
}

export default ToolRegistry;
