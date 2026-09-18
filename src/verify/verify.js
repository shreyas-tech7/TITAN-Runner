/**
 * @file Verification of a finished run: the deterministic checks first
 * (`verify/checks.js`, free and certain), then — only when they all pass —
 * the model judge (`verify/judge.js`) on a provider that produced none of
 * the work. The result names the steps at fault so the orchestrator can
 * remediate exactly those (`engine/orchestrate.js`).
 *
 * "Unjudged" is an honest state: when no unused provider is left, the judge
 * is disabled, or the judge cannot be reached or parsed, the run passes on
 * the deterministic checks alone and says so (`unjudged: true`), unless
 * `strict` demands a judge verdict.
 */
import { runChecks, summarizeChecks } from './checks.js';
import { askJudge, pickJudgeProvider } from './judge.js';

/**
 * @param {{
 *   task: object, graph: object, synthesis: object, tasksById: Map<string, object>,
 *   judge?: { enabled?: boolean, chat?: Function|null, candidates?: string[], strict?: boolean, timeoutMs?: number },
 *   events?: { append: Function }|null, runId?: string, scratchDir?: string, checkSyntax?: boolean, signal?: AbortSignal,
 *   onJudgeCall?: () => void,
 * }} args
 * @returns {Promise<{ verdict: 'pass'|'fail', checks: object[], judge: object|null, issues: Array<{ step: string|null, problem: string }>, unjudged: boolean, reason: string }>}
 */
export async function verifyRun(args) {
  const events = args.events ?? null;
  const started = performance.now();
  events?.append('verify.started', { taskId: args.task.id, runId: args.runId ?? null });

  const checks = runChecks({ graph: args.graph, synthesis: args.synthesis, tasksById: args.tasksById, scratchDir: args.scratchDir, checkSyntax: args.checkSyntax });
  const summary = summarizeChecks(checks);
  for (const c of checks) {
    if (!c.ok) events?.append('verify.check', { taskId: args.task.id, runId: args.runId ?? null, check: c.id, outcome: c.severity === 'fail' ? 'failed' : 'warned', detail: c.detail, steps: c.steps });
  }

  if (!summary.ok) {
    const issues = checks.filter((c) => !c.ok && c.severity === 'fail').flatMap((c) => (c.steps.length > 0 ? c.steps.map((step) => ({ step, problem: `${c.id}: ${c.detail}` })) : [{ step: null, problem: `${c.id}: ${c.detail}` }]));
    const result = { verdict: 'fail', checks, judge: null, issues, unjudged: true, reason: `deterministic checks failed: ${summary.failed.join(', ')}` };
    events?.append('verify.finished', { taskId: args.task.id, runId: args.runId ?? null, outcome: 'fail', layer: 'checks', failed: summary.failed, durationMs: Math.round(performance.now() - started) });
    return result;
  }

  const judgeOpts = args.judge ?? {};
  const enabled = judgeOpts.enabled !== false && typeof judgeOpts.chat === 'function';
  const provider = enabled ? pickJudgeProvider(args.tasksById, judgeOpts.candidates, [args.graph?.plannedBy ?? null]) : null;
  let judge = null;
  let error = null;
  if (enabled && provider) {
    args.onJudgeCall?.();
    judge = await askJudge({ run: { task: args.task, graph: args.graph, synthesis: args.synthesis, tasksById: args.tasksById, checks }, chat: judgeOpts.chat, provider, signal: args.signal, timeoutMs: judgeOpts.timeoutMs });
    error = judge.error;
    events?.append('verify.judged', { taskId: args.task.id, runId: args.runId ?? null, provider: judge.provider, outcome: judge.verdict ?? 'unavailable', reason: judge.reason ?? judge.error ?? null, issues: (judge.issues ?? []).length });
  } else if (enabled && !provider) {
    error = 'every configured provider produced part of this run; no independent judge is left';
  } else {
    error = 'judge disabled';
  }

  let result;
  if (judge?.verdict === 'pass') {
    result = { verdict: 'pass', checks, judge, issues: [], unjudged: false, reason: judge.reason || 'the judge passed the run' };
  } else if (judge?.verdict === 'fail') {
    result = { verdict: 'fail', checks, judge, issues: judge.issues.length > 0 ? judge.issues : [{ step: null, problem: judge.reason || 'the judge failed the run' }], unjudged: false, reason: judge.reason || 'the judge failed the run' };
  } else if (judgeOpts.strict) {
    result = { verdict: 'fail', checks, judge, issues: [{ step: null, problem: `no judge verdict (${error})` }], unjudged: true, reason: `strict verification and no judge verdict: ${error}` };
  } else {
    result = { verdict: 'pass', checks, judge, issues: [], unjudged: true, reason: `deterministic checks passed; unjudged (${error})` };
  }
  events?.append('verify.finished', { taskId: args.task.id, runId: args.runId ?? null, outcome: result.verdict, layer: judge?.verdict ? 'judge' : 'checks', unjudged: result.unjudged, provider: judge?.provider ?? null, durationMs: Math.round(performance.now() - started) });
  return result;
}

export default verifyRun;
