/**
 * @file Post-synthesis verification (roadmap aspect A1).
 *
 * After the main graph is scheduled and synthesized, the pulse runs ONE more
 * cheap model pass whose only job is to judge the merged deliverable against
 * the original master prompt — completeness, consistency, obvious breakage —
 * before the run is stamped `complete`. This is the cheapest possible
 * "actually look at the answer" step: it turns a one-pass decompose→synthesize
 * pipeline into a one-pass-plus-a-gate pipeline without re-running any real
 * work.
 *
 * Deliberately isolated in its own module and run as a SEPARATE, single-task
 * `Scheduler` run after `synthesize()` returns, rather than being appended to
 * the main graph. That keeps the main decompose/synthesize path byte-for-byte
 * untouched (zero regression surface there) and lets the verifier see the
 * real merged `synthesis.files` instead of each task's raw envelope.
 *
 * Safety contract (the whole point of A1):
 *   - A verification failure NEVER fails the task. It degrades the run to
 *     "complete with caveats" and is recorded for the dashboard/issue comment.
 *   - A verification call that errors, times out, or returns unparseable text
 *     is `unavailable`, not `failed` — the run result is unchanged.
 *   - Verification only runs in live mode (never in dry-run) and only when
 *     there is at least one produced file to judge.
 */
import { Scheduler } from './scheduler.js';
import { parseProbeJson } from './capabilityRegistry.js';

const VERIFY_TASK_ID = '__verification__';

/** Per-file content cap included in the verify prompt (the paths are all included, uncapped). */
const MAX_VERIFY_FILE_CHARS = 1500;
/** Total content budget across all files in the verify prompt. */
const MAX_VERIFY_TOTAL_CHARS = 24000;

/**
 * Build the verification prompt: the master prompt the run was asked to
 * satisfy, plus every produced file (path in full, content size-capped).
 * @param {string} masterPrompt
 * @param {Array<{path: string, content: string}>} files
 * @returns {string}
 */
export function buildVerifyPrompt(masterPrompt, files) {
  const lines = [
    'You are the verifier for a multi-agent build system. Another pass just produced a set of files ',
    'to satisfy a master prompt. Judge the RESULT, not the process.',
    '',
    'Master prompt the result was supposed to satisfy:',
    '```',
    String(masterPrompt ?? '').slice(0, 8000),
    '```',
    '',
    `Files produced (${files.length}):`,
  ];

  let budget = MAX_VERIFY_TOTAL_CHARS;
  for (const f of files) {
    const content = String(f.content ?? '');
    const slice = content.slice(0, Math.min(MAX_VERIFY_FILE_CHARS, budget));
    lines.push('', `### \`${f.path}\``, '```', slice.length > 0 ? slice : '(empty file)', '```');
    budget -= slice.length;
    if (budget <= 0) {
      lines.push('', '_(remaining file contents omitted — size cap reached)_');
      break;
    }
  }

  lines.push(
    '',
    'Respond with STRICT JSON ONLY and nothing else, exactly this shape:',
    '{"pass": boolean, "issues": string[]}',
    '',
    'Set "pass" to true only if the files, taken together, plausibly and completely satisfy the ',
    'master prompt. Set "pass" to false if anything is missing, contradictory between files, ',
    'obviously broken, or disconnected from the prompt. "issues" lists short, concrete problems ',
    '(empty array when passing). Be strict but fair: surface real gaps, not stylistic opinions.',
  );

  return lines.join('\n');
}

/**
 * Defensively parse a verify model's raw response into a verdict. Accepts
 * several JSON key spellings models actually produce; never throws, and
 * returns `pass: null` (caller treats as "unavailable") when nothing usable
 * survives — a false `unavailable` is safe, a false `pass`/`fail` is not.
 * @param {unknown} raw
 * @returns {{ pass: boolean|null, issues: string[] }}
 */
export function parseVerdict(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { pass: null, issues: [] };
  const parsed = parseProbeJson(raw);
  if (!parsed || typeof parsed !== 'object') return { pass: null, issues: [] };

  let pass = null;
  if (typeof parsed.pass === 'boolean') pass = parsed.pass;
  else if (typeof parsed.passed === 'boolean') pass = parsed.passed;
  else if (typeof parsed.ok === 'boolean') pass = parsed.ok;
  else if (parsed.verdict === 'pass') pass = true;
  else if (parsed.verdict === 'fail' || parsed.verdict === 'failed') pass = false;

  const issuesRaw = Array.isArray(parsed.issues) ? parsed.issues : Array.isArray(parsed.problems) ? parsed.problems : [];
  const issues = issuesRaw
    .map((i) => (typeof i === 'string' ? i.trim() : typeof i === 'object' && i && typeof i.message === 'string' ? i.message : ''))
    .filter((i) => i.length > 0)
    .slice(0, 20);

  return { pass, issues };
}

/**
 * Run one verification pass over the synthesized files.
 *
 * @param {object} deps
 * @param {Record<string, import('../../agents/AgentAdapter.js').AgentAdapter>} deps.pools
 * @param {import('./capabilityRegistry.js').CapabilityRegistry|object} deps.capabilityRegistry
 * @param {string} deps.masterPrompt
 * @param {Array<{path: string, content: string}>} deps.files
 * @param {number} [deps.taskTimeoutMs]
 * @returns {Promise<{
 *   ran: boolean,
 *   state: 'passed'|'failed'|'unavailable'|'skipped',
 *   issues: string[],
 *   modelId: string|null,
 *   pool: string|null,
 *   tokensUsed: number|null,
 *   durationMs: number,
 * }>}
 */
export async function runVerification({ pools, capabilityRegistry, masterPrompt, files, taskTimeoutMs }) {
  const started = Date.now();
  const empty = {
    ran: false,
    state: 'skipped',
    issues: [],
    modelId: null,
    pool: null,
    tokensUsed: null,
    durationMs: 0,
  };

  if (!Array.isArray(files) || files.length === 0) return empty;

  const prompt = buildVerifyPrompt(masterPrompt, files);
  const graph = {
    sharedContext: '',
    tasks: [
      {
        id: VERIFY_TASK_ID,
        title: 'Verify the merged deliverable against the master prompt',
        aspect: 'testing',
        description: prompt,
        dependsOn: [],
        estimatedComplexity: 'medium',
        deliverable: 'A strict JSON verdict: {"pass": boolean, "issues": string[]}',
      },
    ],
  };

  let scheduler;
  let tasksById;
  try {
    scheduler = new Scheduler({ pools, capabilityRegistry, taskTimeoutMs });
    tasksById = await scheduler.run(graph);
  } catch (err) {
    return { ...empty, ran: true, state: 'unavailable', durationMs: Date.now() - started };
  }

  const verify = tasksById.get(VERIFY_TASK_ID);
  const attempts = verify?.attempts ?? [];
  const lastAttempt = attempts[attempts.length - 1] ?? null;
  const durationMs = Date.now() - started;

  if (!verify || verify.state !== 'complete' || typeof verify.output !== 'string') {
    return {
      ran: true,
      state: 'unavailable',
      issues: [],
      modelId: lastAttempt?.modelId ?? null,
      pool: lastAttempt?.pool ?? null,
      tokensUsed: attempts.reduce((sum, a) => sum + (a.tokensUsed ?? 0), 0) || null,
      durationMs,
    };
  }

  const { pass, issues } = parseVerdict(verify.output);
  const tokensUsed = attempts.reduce((sum, a) => sum + (a.tokensUsed ?? 0), 0);

  if (pass === null) {
    return { ran: true, state: 'unavailable', issues, modelId: lastAttempt?.modelId ?? null, pool: lastAttempt?.pool ?? null, tokensUsed: tokensUsed || null, durationMs };
  }

  return {
    ran: true,
    state: pass ? 'passed' : 'failed',
    issues,
    modelId: lastAttempt?.modelId ?? null,
    pool: lastAttempt?.pool ?? null,
    tokensUsed: tokensUsed || null,
    durationMs,
  };
}

export default { buildVerifyPrompt, parseVerdict, runVerification };
