/**
 * @file The sub-agent tools for connectors (Wave 12, C9): `connector_list` and `connector_call`.
 *
 * Both tools call the broker of the Worker with the callback token. The broker decides what a runner may do:
 *   - a `read` action with the data class `public` or `internal` runs, and the result comes back;
 *   - a `write` action returns `pending_approval`, and a person decides in the dashboard or in Telegram;
 *   - an action with the data class `personal` is refused, so personal data never reaches a runner.
 * This file adds a second wall. It refuses to run without the callback token, it refuses an answer that is marked
 * `personal`, and it scrubs every answer with `scrubForState()` before the text can reach a log line or a state file.
 * The Reviewer Gate screens the arguments before the call. Repos that call this are public, so nothing personal may pass.
 */
import { callWorker, callbackAuth, workerBase } from '../lib/workerCallback.js';
import { scrubForState } from '../lib/secretScrub.js';

const MAX_OUTPUT = 8000;

/** @param {unknown} value */
const scrub = (value) => scrubForState(typeof value === 'string' ? value : JSON.stringify(value));

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} A reason to refuse, or null when the call may go on.
 */
export function refusal(env) {
  if (!workerBase(env)) return 'TITAN_WORKER_URL is not set, so the Worker cannot be reached.';
  const auth = callbackAuth(env);
  if (!auth) return 'No callback token is set.';
  if (auth.kind !== 'callback') return 'Connector calls need the callback token. The admin token is not used for them.';
  return null;
}

/**
 * Call one connector action through the Worker.
 * @param {{ connector: string, action: string, input?: Record<string, unknown> }} args
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, taskId?: string|null }} [opts]
 * @returns {Promise<{ ok: boolean, state: 'done'|'pending_approval'|'error', text: string }>}
 */
export async function callConnector(args, opts = {}) {
  const env = opts.env ?? process.env;
  const why = refusal(env);
  if (why) return { ok: false, state: 'error', text: why };
  const res = await callWorker('/internal/connector-call', {
    env,
    fetchImpl: opts.fetchImpl,
    timeoutMs: 25_000,
    body: { connector: args.connector, action: args.action, input: args.input ?? {}, ...(opts.taskId ? { taskId: String(opts.taskId).slice(0, 40) } : {}) },
  });
  if (res.status === null) return { ok: false, state: 'error', text: `The Worker could not be reached (${scrub(res.error ?? 'network error')}).` };
  const j = res.json ?? {};
  if (res.status === 202 && j.state === 'pending_approval') {
    return { ok: true, state: 'pending_approval', text: `pending_approval: a person must approve this call (key ${scrub(j.approvalId)}). Do not repeat it. Continue without its result.` };
  }
  if (!res.ok) return { ok: false, state: 'error', text: `${scrub(j.error ?? res.status)}: ${scrub(j.message ?? 'The broker refused the call.')}`.slice(0, 500) };
  if (j.dataClass === 'personal') return { ok: false, state: 'error', text: 'personal_data_forbidden: the answer was dropped because it holds personal data.' };
  if (j.state === 'error') return { ok: false, state: 'error', text: scrub(j.error ?? 'The connector reported an error.').slice(0, 500) };
  const text = scrub(j.data ?? {});
  return { ok: true, state: 'done', text: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}…[truncated]` : text };
}

/** What a runner may call, as one text block for the prompt. */
export async function describeConnectors(opts = {}) {
  const env = opts.env ?? process.env;
  if (refusal(env)) return null;
  const res = await callWorker('/internal/connectors', { env, fetchImpl: opts.fetchImpl, method: 'GET', timeoutMs: 10_000 });
  const list = res.ok ? res.json?.connections : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const lines = list.map((c) => `- ${scrub(c.connector)} (${scrub(c.label)}): ${c.actions.map((a) => `${scrub(a.id)} [${a.risk}]`).join(', ')}`);
  return lines.join('\n');
}

/**
 * Tool definitions for `ToolRegistry`.
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [opts]
 * @returns {import('./registry.js').ToolDefinition[]}
 */
export function connectorTools(opts = {}) {
  return [
    {
      id: 'connector_list',
      description: 'List the connected tools and the actions that a runner may call. Personal actions are not listed.',
      effect: 'read', riskLevel: 'low', idempotent: true, timeoutMs: 12_000,
      schema: { type: 'object', additionalProperties: false, properties: {} },
      async run() {
        const text = await describeConnectors(opts);
        return text ?? 'No connector is available to runners.';
      },
    },
    {
      id: 'connector_call',
      description: 'Call one action of a connected tool through the broker. A read action runs. A write action waits for a person to approve it.',
      effect: 'external', riskLevel: 'medium', idempotent: false, timeoutMs: 27_000,
      schema: {
        type: 'object', required: ['connector', 'action'], additionalProperties: false,
        properties: {
          connector: { type: 'string', minLength: 2, maxLength: 64, pattern: '^[a-z][a-z0-9_]{1,63}$|^c_[0-9a-f]{16}$' },
          action: { type: 'string', minLength: 2, maxLength: 41, pattern: '^[a-z][a-z0-9_]{1,40}$' },
          input: { type: 'object', additionalProperties: true },
        },
      },
      async run(args, ctx) {
        const out = await callConnector(args, { env: opts.env, fetchImpl: opts.fetchImpl, taskId: ctx?.taskId });
        if (!out.ok) throw new Error(out.text);
        return out.text;
      },
    },
  ];
}

export default connectorTools;
