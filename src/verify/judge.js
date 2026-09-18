/**
 * @file The model judge: a second opinion on a finished run from a model
 * that did *not* produce it. It is asked only after every deterministic
 * check passed (a failed check is a free, certain verdict), receives the
 * task, the acceptance criteria, and a bounded summary of what was
 * produced, and must answer with strict JSON:
 *
 *   {"verdict": "pass" | "fail", "reason": "...", "issues": [{"step": "<id>", "problem": "..."}]}
 *
 * The judge's provider is chosen from the pool's providers minus every
 * provider that produced a step (`pickJudgeProvider`); when none is left
 * or the judge cannot be reached, the run is recorded as *unjudged*
 * (`judge: null`) rather than failed — unless `strict` is set.
 */
import { FAILOVER_ORDER } from '../providers/registry.js';
import { parseProbeJson } from '../orchestrator/capabilityRegistry.js';

export const JUDGE_SYSTEM_PROMPT = 'You are the verifier for an autonomous coding runner. You judge whether a finished task meets its acceptance criteria. You did not produce this work. Be strict about missing deliverables, stubs, and answers that dodge the task; do not fail work for style. Answer with strict JSON only.';

const MAX_FILE_PREVIEW = 1200;
const MAX_FILES = 12;
const MAX_STEP_PREVIEW = 600;

/**
 * Acceptance criteria derived from the task and its plan — what "done" means.
 * @param {{ title: string, prompt: string }} task
 * @param {{ tasks: Array<{ id: string, title: string, deliverable: string, aspect: string }> }} graph
 * @returns {string[]}
 */
export function acceptanceCriteria(task, graph) {
  const out = [`The output addresses the request: "${String(task.title).slice(0, 160)}".`];
  for (const step of graph?.tasks ?? []) {
    out.push(`Step ${step.id} (${step.aspect}) delivers: ${String(step.deliverable ?? step.title).slice(0, 160)}.`);
  }
  out.push('No step output is a refusal, a placeholder, or an unrelated answer.');
  return out;
}

/**
 * @param {Map<string, object>} tasksById
 * @param {string[]} [candidates]
 * @param {Array<string|null>} [alsoUsed] Model ids outside the steps (the planner).
 * @returns {string|null} A provider id that produced no part of the run, or null.
 */
export function pickJudgeProvider(tasksById, candidates = FAILOVER_ORDER, alsoUsed = []) {
  const used = new Set();
  for (const id of alsoUsed) if (id) used.add(String(id).replace(/^[a-z0-9]+:/, ''));
  for (const t of tasksById.values()) {
    for (const a of t.attempts ?? []) if (a.modelId) used.add(String(a.modelId).replace(/^[a-z0-9]+:/, ''));
    if (t.assignment?.modelId) used.add(String(t.assignment.modelId).replace(/^[a-z0-9]+:/, ''));
  }
  return candidates.find((id) => !used.has(id)) ?? null;
}

/**
 * @param {{ task: object, graph: object, synthesis: { files: Array<{path: string, content: string, sourceTaskId?: string}>, markdownSummary?: string }, tasksById: Map<string, object>, checks: Array<{ id: string, ok: boolean, detail: string }> }} run
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildJudgeMessages(run) {
  const criteria = acceptanceCriteria(run.task, run.graph);
  const files = (run.synthesis?.files ?? []).slice(0, MAX_FILES).map((f) => `--- ${f.path} (${f.content.length} chars) ---\n${f.content.slice(0, MAX_FILE_PREVIEW)}${f.content.length > MAX_FILE_PREVIEW ? '\n…' : ''}`);
  const steps = [...run.tasksById.values()].map((t) => `- ${t.id} [${t.state}] ${t.title}: ${typeof t.output === 'string' ? t.output.slice(0, MAX_STEP_PREVIEW).replace(/\s+/g, ' ') : '(no output)'}`);
  const warnings = (run.checks ?? []).filter((c) => !c.ok).map((c) => `- ${c.id}: ${c.detail}`);
  const user = [
    'VERIFY: judge the finished task below against its acceptance criteria.',
    '',
    `Task: ${run.task.title}`,
    `Request:\n${String(run.task.prompt).slice(0, 4000)}`,
    '',
    'Acceptance criteria:',
    ...criteria.map((c) => `- ${c}`),
    '',
    'Steps and their outputs:',
    ...steps,
    '',
    files.length > 0 ? `Files produced (${run.synthesis.files.length}):\n${files.join('\n')}` : 'Files produced: none.',
    warnings.length > 0 ? `\nDeterministic check warnings:\n${warnings.join('\n')}` : '',
    '',
    'Answer with ONLY this JSON: {"verdict":"pass"|"fail","reason":"<one sentence>","issues":[{"step":"<step id>","problem":"<what is missing or wrong>"}]}',
  ].join('\n');
  return [{ role: 'system', content: JUDGE_SYSTEM_PROMPT }, { role: 'user', content: user }];
}

/**
 * @param {string} raw
 * @returns {{ verdict: 'pass'|'fail', reason: string, issues: Array<{ step: string|null, problem: string }> } | null}
 */
export function parseJudgeVerdict(raw) {
  const parsed = parseProbeJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const verdict = String(parsed.verdict ?? '').toLowerCase();
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.slice(0, 10).map((i) => ({ step: typeof i?.step === 'string' ? i.step.slice(0, 60) : null, problem: String(i?.problem ?? i ?? '').slice(0, 300) })).filter((i) => i.problem.length > 0) : [];
  return { verdict, reason: String(parsed.reason ?? '').slice(0, 400), issues };
}

/**
 * Ask the judge. Never throws: an unreachable or unparsable judge is
 * reported as `{ verdict: null, error }`.
 * @param {{ run: object, chat: (messages: object[], opts: object) => Promise<{ text: string, service?: string }>, provider: string, signal?: AbortSignal, timeoutMs?: number }} args
 */
export async function askJudge({ run, chat, provider, signal, timeoutMs = 60_000 }) {
  const messages = buildJudgeMessages(run);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await chat(messages, { service: provider, temperature: 0, signal: combined });
    const verdict = parseJudgeVerdict(res?.text ?? '');
    if (!verdict) return { verdict: null, provider: res?.service ?? provider, error: 'the judge did not answer with a {verdict, reason, issues} object' };
    return { ...verdict, provider: res?.service ?? provider, error: null };
  } catch (err) {
    return { verdict: null, provider, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export default { acceptanceCriteria, pickJudgeProvider, buildJudgeMessages, parseJudgeVerdict, askJudge };
