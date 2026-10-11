/**
 * @file Post-mortems of failed runs (RO4).
 *
 * Every task that ends `failed` or `dead-lettered` gets a short post-mortem: what failed, the likely cause, and a
 * suggested fix. A free model writes the last two lines when one is available. If none is, or if its text is not clean,
 * a template writes them. The text is cleaned (secrets, emails, links), scanned with gitleaks when the binary is there,
 * and then appended to `state/lessons.jsonl`. This repo is public, so a post-mortem never holds the task text, the
 * title, the prompt, an answer, or a login. It holds facts: a failure class, a code, a stage, a category, and counts.
 *
 * Repeats merge by error signature: the second failure of the same kind raises `count` and moves `last_seen`. It adds
 * no new line. The decomposer reads the five most relevant lessons before it plans (`relevantLessons`).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cleanText } from '../reviewer/githubGatePolicy.js';
import { redactString } from '../lib/redact.js';

export const MAX_LESSONS = 200;
const MAX_FIELD = 400;
const MAX_RUN_IDS = 5;
/** Failure codes that only say "a task that I depend on failed". The root failure has its own post-mortem. */
const SKIP_CODES = new Set(['DEPENDENCY_FAILED', 'DEPENDENCY_MISSING']);

// ---------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------

/** Strip what changes from one failure to the next: numbers, ids, hashes, links, quoted text. */
export function normalizeMessage(message) {
  let text = redactString(String(message ?? '')).toLowerCase().replace(/https?:\/\/\S+/g, '<url>');
  // A list in parentheses, such as "(tried: a, b)" or "(skipped: c)", changes with the state of the breakers. The cause is
  // the same. Remove the innermost parentheses first, and go on until none are left.
  for (let i = 0; i < 6 && /\([^()]*\)/.test(text); i += 1) text = text.replace(/\([^()]*\)/g, '');
  return text
    .replace(/["'`][^"'`]{0,200}["'`]/g, '<text>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<hash>')
    .replace(/\bissue-\d+\b/g, 'issue-<n>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** The error signature of a failure: its class, its code, and the shape of its message. */
export function errorSignature(failure) {
  const cls = String(failure?.class ?? 'permanent');
  const code = String(failure?.code ?? 'UNKNOWN').toUpperCase();
  const hash = createHash('sha256').update(`${cls}|${code}|${normalizeMessage(failure?.message)}`).digest('hex').slice(0, 10);
  return `${cls}:${code}:${hash}`;
}

// ---------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------

const CAUSES = {
  rate_limited: ['The provider answered 429. The free limit of the provider was reached.', 'Wait for the reset. Spread calls over more providers. The quota meter in the dashboard shows what is left.'],
  provider_down: ['The provider or its network did not answer, or answered with a server error.', 'Check the host status panel. Retry later. The router will use another provider while this one is down.'],
  timeout: ['A call took longer than its time limit.', 'Retry with a smaller task. Check the provider latency in the health panel.'],
  malformed_output: ['The model answered, but not in the format that the step needs.', 'Make the step smaller, or give the model a clearer format example. A model with a better eval score in this category may do better.'],
  tool_error: ['A tool that the step used failed.', 'Read the tool error in the run record. Check the arguments of the tool call.'],
  policy_blocked: ['The Reviewer Gate or the policy engine refused the action.', 'Read the reason of the gate. Change the task so it does not need the refused action, or approve it by hand.'],
  budget_exhausted: ['The free quota of the provider, or the call budget of the task, was spent.', 'Wait for the quota to reset, or split the task into smaller tasks.'],
  poisoned: ['The same failure repeated on the same model, so the engine stopped to avoid a retry storm.', 'Change the step or the model. A retry with the same input will fail the same way.'],
  permanent: ['The failure will not go away on a retry. Common causes: a rejected key, a missing model, or a check that the output did not pass.', 'Read the failure code. If the code is VERIFICATION_FAILED, make the task more exact. If it is a rejected key, rotate the key.'],
  transient: ['A short fault that has no clear cause.', 'Retry the task.'],
};
const CODE_HINTS = {
  VERIFICATION_FAILED: ['The result did not pass the checks after the retries.', 'Make the task more exact, or break it into steps that each have one clear result.'],
  UNAUTHORIZED: ['The key was rejected by the provider.', 'Rotate the key and save it again on the Keys page.'],
  TASK_BUDGET: ['The task used more calls than its budget allows.', 'Split the task into smaller tasks.'],
  PARK_CEILING: ['The task waited many times for a provider and never got through.', 'Check the health and quota panels. Add a provider key.'],
  NO_PROGRESS: ['A step failed the same way several times.', 'Change the step. A retry with the same input will fail again.'],
};

/** Pure. The facts of a failure, with no task text. */
export function failureFacts(task, run = null) {
  const failure = task.failure ?? {};
  const step = (run?.tasks ?? []).find((t) => t.state === 'failed') ?? null;
  const pools = [...new Set((step?.attempts ?? []).map((a) => String(a.pool ?? '').replace(/[^a-z0-9_.-]/gi, '')).filter(Boolean))].slice(0, 6);
  return {
    class: String(failure.class ?? 'permanent'),
    code: String(failure.code ?? 'UNKNOWN').toUpperCase(),
    message: redactString(String(failure.message ?? '')).slice(0, 300),
    taskType: String(task.type ?? 'task'),
    aspect: step?.aspect && /^[a-z-]{3,30}$/.test(step.aspect) ? step.aspect : null,
    attempts: Number.isFinite(task.attempts) ? task.attempts : null,
    parks: Number.isFinite(task.parks) ? task.parks : 0,
    providers: pools,
    status: String(task.status),
  };
}

export function templatePostmortem(facts) {
  const base = CAUSES[facts.class] ?? CAUSES.permanent;
  const hint = CODE_HINTS[facts.code];
  const where = facts.aspect ? ` in a "${facts.aspect}" step` : '';
  const who = facts.providers.length ? ` Providers tried: ${facts.providers.join(', ')}.` : '';
  return {
    what_failed: `A ${facts.taskType} ${facts.status === 'dead-lettered' ? 'was dead-lettered' : 'failed'}${where}. Failure class ${facts.class}, code ${facts.code}, after ${facts.attempts ?? 'an unknown number of'} attempt(s) and ${facts.parks} wait(s).${who}`,
    likely_cause: (hint ?? base)[0],
    suggested_fix: (hint ?? base)[1],
    source: 'template',
  };
}

// ---------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------

export function postmortemMessages(facts) {
  return [
    { role: 'system', content: 'You write short post-mortems for failed runs of a free-tier task runner. Use only the facts you are given. Reply with ONLY a JSON object: {"likely_cause": string, "suggested_fix": string}. Each value is one sentence of 30 words or less. Do not mention any names, links, or keys.' },
    { role: 'user', content: `Facts:\n- failure class: ${facts.class}\n- failure code: ${facts.code}\n- step category: ${facts.aspect ?? 'unknown'}\n- attempts: ${facts.attempts ?? 'unknown'}\n- waits: ${facts.parks}\n- providers tried: ${facts.providers.join(', ') || 'unknown'}\n- error text: ${facts.message || 'none'}` },
  ];
}

/** Make model text safe for a public file. Returns null when nothing safe is left. */
export function sanitizeLine(text) {
  let t = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+?([.,;:!?)]*)(?=\s|$)/g, '[link]$1')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = redactString(cleanText(t).text);
  if (t.length < 8 || /\[REDACTED\]/.test(t)) return null; // a secret was in it. Do not keep the rest.
  return t.slice(0, MAX_FIELD);
}

function extractObject(text) {
  const raw = String(text ?? '');
  for (const c of [raw.trim(), ...(raw.match(/\{[^{}]*\}/g) ?? [])]) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // next
    }
  }
  return null;
}

/** Scan text with gitleaks, when the binary exists. @returns {{ scanned: boolean, clean: boolean }} */
export function gitleaksScan(text, { bin = process.env.GITLEAKS_BIN || 'gitleaks', config = '.gitleaks.toml' } = {}) {
  const args = ['stdin', '--no-banner', '--redact=100', ...(existsSync(config) ? ['-c', config] : [])];
  const res = spawnSync(bin, args, { input: text, encoding: 'utf8', timeout: 10_000 });
  if (res.error || res.status === null) return { scanned: false, clean: true };
  if (res.status === 0) return { scanned: true, clean: true };
  return { scanned: true, clean: false };
}

/**
 * Write one post-mortem. A model writes the cause and the fix when it can. A template is the fallback.
 * @param {ReturnType<typeof failureFacts>} facts
 * @param {{ chat?: ((messages: object[], opts: object) => Promise<{ text: string }>)|null, scan?: (text: string) => { clean: boolean } }} [deps]
 */
export async function writePostmortem(facts, deps = {}) {
  const template = templatePostmortem(facts);
  if (!deps.chat) return template;
  let reply;
  try {
    reply = await deps.chat(postmortemMessages(facts), { service: 'auto', priority: 'low', maxTokens: 400, temperature: 0, maxProviders: 2 });
  } catch {
    return template;
  }
  const obj = extractObject(reply?.text);
  const cause = sanitizeLine(obj?.likely_cause);
  const fix = sanitizeLine(obj?.suggested_fix);
  if (!cause || !fix) return template;
  const scan = (deps.scan ?? gitleaksScan)(`${cause}\n${fix}`);
  if (!scan.clean) return template;
  return { ...template, likely_cause: cause, suggested_fix: fix, source: 'model' };
}

// ---------------------------------------------------------------------
// The lessons file
// ---------------------------------------------------------------------

export function readLessons(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v.signature === 'string') out.push(v);
    } catch {
      // a line that cannot be read is skipped, never repaired
    }
  }
  return out;
}

/**
 * Add a lesson, or merge it into the lesson with the same signature.
 * @param {string} path
 * @param {{ signature: string, task_type: string|null, what_failed: string, likely_cause: string, suggested_fix: string, source: 'model'|'template' }} lesson
 * @param {string} runKey Names the failure, so the same failure is never counted twice.
 * @param {Date} now
 * @returns {{ outcome: 'new'|'merged'|'duplicate', lesson: object }}
 */
export function appendLesson(path, lesson, runKey, now = new Date()) {
  const lessons = readLessons(path);
  const iso = now.toISOString();
  const existing = lessons.find((l) => l.signature === lesson.signature);
  let outcome;
  let result;
  if (existing) {
    if ((existing.run_ids ?? []).includes(runKey)) return { outcome: 'duplicate', lesson: existing };
    existing.count = (existing.count ?? 1) + 1;
    existing.last_seen = iso;
    existing.run_ids = [...(existing.run_ids ?? []), runKey].slice(-MAX_RUN_IDS);
    // A model text replaces a template text. Never the other way round.
    if (lesson.source === 'model' && existing.source !== 'model') Object.assign(existing, { likely_cause: lesson.likely_cause, suggested_fix: lesson.suggested_fix, source: 'model' });
    outcome = 'merged';
    result = existing;
  } else {
    result = {
      id: createHash('sha256').update(lesson.signature).digest('hex').slice(0, 8),
      signature: lesson.signature, first_seen: iso, last_seen: iso, count: 1, task_type: lesson.task_type,
      what_failed: lesson.what_failed.slice(0, 2000), likely_cause: lesson.likely_cause.slice(0, 2000), suggested_fix: lesson.suggested_fix.slice(0, 2000),
      source: lesson.source, run_ids: [runKey],
    };
    lessons.push(result);
    outcome = 'new';
  }
  const kept = lessons.length > MAX_LESSONS
    ? [...lessons].sort((a, b) => (b.count - a.count) || (a.last_seen < b.last_seen ? 1 : -1)).slice(0, MAX_LESSONS)
    : lessons;
  kept.sort((a, b) => (a.first_seen < b.first_seen ? -1 : a.first_seen > b.first_seen ? 1 : a.id < b.id ? -1 : 1));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${kept.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { outcome, lesson: result };
}

// ---------------------------------------------------------------------
// Reading lessons before a plan
// ---------------------------------------------------------------------

const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'your', 'task', 'tasks', 'make', 'when', 'then', 'into', 'about', 'which', 'should', 'would', 'could', 'there', 'their', 'what', 'each', 'step', 'steps']);
const words = (text) => new Set(String(text ?? '').toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? []);

/**
 * The most relevant lessons for a new task: words that the task and the lesson share, how often the failure happened,
 * and how recent it is.
 * @param {object[]} lessons
 * @param {string} taskText
 * @param {number} [k]
 * @param {Date} [now]
 */
export function relevantLessons(lessons, taskText, k = 5, now = new Date()) {
  const task = words(taskText);
  const scored = lessons.map((l) => {
    const lw = words(`${l.task_type ?? ''} ${l.what_failed} ${l.likely_cause} ${l.suggested_fix}`);
    let overlap = 0;
    for (const w of lw) if (task.has(w)) overlap += 1;
    const ageDays = Math.max(0, (now.getTime() - Date.parse(l.last_seen)) / 86_400_000);
    const score = overlap * 3 + Math.log2(1 + (l.count ?? 1)) + Math.max(0, 1 - ageDays / 30) + (l.task_type && task.has(String(l.task_type).split('-')[0]) ? 2 : 0);
    return { l, score };
  });
  return scored.sort((a, b) => b.score - a.score || (a.l.last_seen < b.l.last_seen ? 1 : -1)).slice(0, k).map((s) => s.l);
}

/** The text that the decomposer reads. One short line for each lesson. */
export function lessonsBlock(lessons) {
  if (!lessons.length) return '';
  return lessons.map((l) => `- (${l.count}x) ${l.what_failed} Likely cause: ${l.likely_cause} Fix: ${l.suggested_fix}`).join('\n');
}

// ---------------------------------------------------------------------
// The sweep that the pulse runs
// ---------------------------------------------------------------------

/**
 * Write a post-mortem for each task that ended in failure and has none yet.
 * @param {{ tasks: object[], lessonsPath: string, readRun?: (runId: string) => object|null, chat?: Function|null, scan?: Function, now?: Date, events?: { append: Function }|null, max?: number }} opts
 * @returns {Promise<{ written: number, merged: number, skipped: number }>}
 */
export async function runPostmortems(opts) {
  const now = opts.now ?? new Date();
  const out = { written: 0, merged: 0, skipped: 0 };
  const known = new Set(readLessons(opts.lessonsPath).flatMap((l) => l.run_ids ?? []));
  let budget = opts.max ?? 3;
  for (const task of opts.tasks) {
    if (!['failed', 'dead-lettered'].includes(task.status) || !task.failure) continue;
    if (SKIP_CODES.has(String(task.failure.code).toUpperCase())) { out.skipped += 1; continue; }
    const runKey = `${task.id}@${task.failure.at ?? task.completedAt ?? 'x'}`.slice(0, 100);
    if (known.has(runKey)) continue;
    if (budget <= 0) break;
    budget -= 1;
    const run = task.runId && opts.readRun ? opts.readRun(task.runId) : null;
    const facts = failureFacts(task, run);
    const pm = await writePostmortem(facts, { chat: opts.chat, scan: opts.scan });
    const { outcome } = appendLesson(opts.lessonsPath, { signature: errorSignature(task.failure), task_type: facts.aspect, what_failed: pm.what_failed, likely_cause: pm.likely_cause, suggested_fix: pm.suggested_fix, source: pm.source }, runKey, now);
    if (outcome === 'new') out.written += 1;
    else if (outcome === 'merged') out.merged += 1;
    opts.events?.append('postmortem.written', { taskId: task.id, outcome, source: pm.source, signature: errorSignature(task.failure) });
    known.add(runKey);
  }
  return out;
}

export default { errorSignature, normalizeMessage, failureFacts, templatePostmortem, writePostmortem, appendLesson, readLessons, relevantLessons, lessonsBlock, runPostmortems };
