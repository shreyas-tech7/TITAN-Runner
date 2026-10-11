/**
 * @file The golden task evaluation (RO3). Each week every configured model gets the golden tasks. Each answer is checked by
 * a deterministic checker. The score of a model in a category is the share of its answers that passed.
 *
 * The call budget is about 300 calls a week: the tasks are chosen to fit it (`selectTasks`). A call that fails
 * because of the provider (a rate limit, a rejected key, a spent quota) does not count as a wrong answer. The model
 * stops there, and its tasks that did not run are left out of `tasks_run`, so a provider outage never looks like a
 * model that cannot code. Hermes agents are not evaluated, because an agent can act on its own host.
 */
import { checkAnswer } from './goldenCheck.js';
import { EVAL_VERSION, GOLDEN_TASKS, selectTasks } from './goldenTasks.js';
import { judgeError } from './canary.js';

export const DEFAULT_MAX_CALLS = 280;

/**
 * @param {{ targets: Array<{ id: string, model: string|null, kind: string, ask?: Function }>, tasks?: typeof GOLDEN_TASKS, maxCalls?: number, usage?: { record: Function }|null, now?: () => Date, check?: typeof checkAnswer, onProgress?: (line: string) => void }} opts
 * @returns {Promise<{ evalVersion: string, calls: number, tasksPerModel: number, rows: Array<{ provider: string, model: string, category: string, score: number, tasks_run: number, run_at: string, eval_version: string }>, skipped: Array<{ provider: string, reason: string }> }>}
 */
export async function runEval(opts) {
  const now = opts.now ?? (() => new Date());
  const check = opts.check ?? checkAnswer;
  const evaluable = opts.targets.filter((t) => t.kind === 'chat' && typeof t.ask === 'function');
  const skipped = opts.targets.filter((t) => !evaluable.includes(t)).map((t) => ({ provider: t.id, reason: t.kind === 'list' ? 'agent' : (t.skip ?? 'no_chat') }));
  const tasks = selectTasks(opts.tasks ?? GOLDEN_TASKS, evaluable.length, opts.maxCalls ?? DEFAULT_MAX_CALLS);
  const runAt = now().toISOString();
  const rows = [];
  let calls = 0;

  for (const target of evaluable) {
    /** @type {Map<string, { passed: number, run: number }>} */
    const byCategory = new Map();
    let model = target.model;
    for (const task of tasks) {
      if (calls >= (opts.maxCalls ?? DEFAULT_MAX_CALLS)) break;
      let answer;
      calls += 1;
      try {
        answer = await target.ask(task.prompt);
        opts.usage?.record({ provider: target.id, model: answer.model ?? model, status: 'ok', tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, remainingRequests: answer.rate?.remainingRequests, remainingTokens: answer.rate?.remainingTokens });
        model = answer.model ?? model;
      } catch (err) {
        const j = judgeError(err);
        opts.usage?.record({ provider: target.id, model, status: j.errorClass === 'rate_limited' ? 'rate_limited' : 'error' });
        opts.onProgress?.(`${target.id}: stopped (${j.errorClass})`);
        // A provider problem is not a wrong answer. Stop for this model and leave the rest out.
        if (['auth', 'quota', 'rate_limited', 'model_invalid', 'provider_down', 'timeout'].includes(j.errorClass)) break;
        continue;
      }
      const verdict = await check(task, answer.text);
      // No sandbox on this machine: the code task could not run, so it is not a wrong answer. Leave it out.
      if (verdict.reason === 'no_sandbox') continue;
      const cur = byCategory.get(task.category) ?? { passed: 0, run: 0 };
      cur.run += 1;
      if (verdict.pass) cur.passed += 1;
      byCategory.set(task.category, cur);
      opts.onProgress?.(`${target.id} ${task.id}: ${verdict.pass ? 'pass' : `fail (${verdict.reason})`}`);
    }
    for (const [category, v] of byCategory) {
      rows.push({ provider: target.id, model: model || '*', category, score: Math.round((v.passed / v.run) * 1000) / 1000, tasks_run: v.run, run_at: runAt, eval_version: EVAL_VERSION });
    }
  }
  return { evalVersion: EVAL_VERSION, calls, tasksPerModel: tasks.length, rows, skipped };
}

/** The public mirror: `state/ops/eval.json`. */
export function evalMirror(rows, now = new Date()) {
  const models = {};
  for (const r of [...rows].sort((a, b) => (a.model + a.category).localeCompare(b.model + b.category))) {
    (models[r.model] ??= {})[r.category] = { score: r.score, tasks_run: r.tasks_run, run_at: r.run_at, eval_version: r.eval_version };
  }
  return { contract: '1', generated_at: now.toISOString(), eval_version: EVAL_VERSION, models };
}

/**
 * The record of the capability cache that a result feeds. A direct provider has the record `phase2:<provider>`.
 * An OpenCode model has a record under its own model name.
 */
export function capabilityIdFor(provider, model) {
  if (provider === 'opencode') return model && model !== '*' ? model : null;
  if (provider.startsWith('hermes_')) return null;
  return `phase2:${provider}`;
}

/** Feed the measured scores into the capability cache. @returns {number} How many records changed. */
export function feedCapabilityCache(rows, registry) {
  const byRecord = new Map();
  for (const r of rows) {
    const id = capabilityIdFor(r.provider, r.model);
    if (!id) continue;
    (byRecord.get(id) ?? byRecord.set(id, {}).get(id))[r.category] = { score: r.score, tasksRun: r.tasks_run, runAt: r.run_at, evalVersion: r.eval_version };
  }
  for (const [id, scores] of byRecord) registry.setMeasured(id, scores);
  if (byRecord.size > 0) registry.save();
  return byRecord.size;
}

export default { runEval, evalMirror, feedCapabilityCache, capabilityIdFor };
