/**
 * @file Deterministic verification of a finished run — the checks that
 * need no model and cost nothing, run before any judge is asked:
 *
 *   steps-complete          every step in the graph ended `complete`
 *   no-conflicts            (warn) the synthesizer found no conflicting files
 *   code-steps-produced     a code-generation step produced at least one file
 *   files-non-empty         no produced file is blank
 *   no-placeholders         no produced file is a stub ("TODO: implement",
 *                           "lorem ipsum", an ellipsis-only body)
 *   no-secrets              no produced file contains a secret-shaped string
 *   json-parses             every `.json` file parses
 *   js-syntax               every `.js/.mjs/.cjs` file passes `node --check`
 *                           (a real parse, in a child process, bounded)
 *
 * Each check returns `{ id, ok, detail, severity }`; `fail` severity fails
 * the run, `warn` is recorded and shown to the judge.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SECRET_PATTERNS } from '../lib/redact.js';

const MAX_SYNTAX_FILES = 12;
const MAX_SYNTAX_BYTES = 200 * 1024;
const PLACEHOLDER = /\bTODO:?\s*implement\b|\blorem ipsum\b|\bplaceholder (only|content)\b|^\s*(\.\.\.|…)\s*$/im;

/**
 * @param {{ graph: object, synthesis: { files: Array<{path: string, content: string}>, conflicts: unknown[] }, tasksById: Map<string, object>, scratchDir?: string, checkSyntax?: boolean }} run
 * @returns {Array<{ id: string, ok: boolean, severity: 'fail'|'warn', detail: string, steps: string[] }>}
 */
export function runChecks(run) {
  const checks = [];
  /** `steps`: the step ids a failure points at, so remediation can target them. */
  const add = (id, ok, severity, detail, steps = []) => checks.push({ id, ok, severity, detail: String(detail).slice(0, 300), steps: [...new Set(steps.filter(Boolean))] });
  const steps = [...run.tasksById.values()];
  const files = run.synthesis?.files ?? [];
  const stepOf = (f) => f.sourceTaskId ?? null;

  const notComplete = steps.filter((s) => s.state !== 'complete');
  add('steps-complete', notComplete.length === 0, 'fail', notComplete.length === 0 ? `${steps.length} step(s) complete` : `not complete: ${notComplete.map((s) => `${s.id}:${s.state}`).join(', ')}`, notComplete.map((s) => s.id));

  const conflicts = run.synthesis?.conflicts ?? [];
  // A conflict is resolved by the synthesizer (both versions are kept under
  // distinct paths), so it is a warning the judge sees, not a failure.
  add('no-conflicts', conflicts.length === 0, 'warn', conflicts.length === 0 ? 'no conflicting files' : `${conflicts.length} conflicting file(s), both versions kept`, conflicts.flatMap((c) => (c.versions ?? []).map((v) => v.taskId)));

  const codeSteps = steps.filter((s) => s.aspect === 'code-generation' && s.state === 'complete');
  const barren = codeSteps.filter((s) => !files.some((f) => f.sourceTaskId === s.id));
  add('code-steps-produced', barren.length === 0, 'fail', barren.length === 0 ? `${codeSteps.length} code step(s) produced files` : `no files from: ${barren.map((s) => s.id).join(', ')}`, barren.map((s) => s.id));

  const empty = files.filter((f) => typeof f.content !== 'string' || f.content.trim().length === 0);
  add('files-non-empty', empty.length === 0, 'fail', empty.length === 0 ? `${files.length} file(s) non-empty` : `empty: ${empty.map((f) => f.path).join(', ')}`, empty.map(stepOf));

  const stubs = files.filter((f) => PLACEHOLDER.test(f.content ?? ''));
  add('no-placeholders', stubs.length === 0, 'fail', stubs.length === 0 ? 'no placeholder content' : `placeholder content in: ${stubs.map((f) => f.path).join(', ')}`, stubs.map(stepOf));

  const leaky = files.filter((f) => SECRET_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace('g', '')).test(f.content ?? '')));
  add('no-secrets', leaky.length === 0, 'fail', leaky.length === 0 ? 'no secret-shaped content' : `secret-shaped content in: ${leaky.map((f) => f.path).join(', ')}`, leaky.map(stepOf));

  const badJson = [];
  const badJsonSteps = [];
  for (const f of files.filter((x) => /\.json$/i.test(x.path))) {
    try {
      JSON.parse(f.content);
    } catch (err) {
      badJson.push(`${f.path} (${err instanceof Error ? err.message.slice(0, 60) : 'parse error'})`);
      badJsonSteps.push(stepOf(f));
    }
  }
  add('json-parses', badJson.length === 0, 'fail', badJson.length === 0 ? 'every .json file parses' : `unparsable: ${badJson.join('; ')}`, badJsonSteps);

  if (run.checkSyntax !== false) {
    const js = files.filter((x) => /\.(m|c)?js$/i.test(x.path)).slice(0, MAX_SYNTAX_FILES);
    const bad = [];
    const badSteps = [];
    if (js.length > 0) {
      const dir = join(run.scratchDir ?? tmpdir(), `titan-syntax-${process.pid}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      try {
        for (const f of js) {
          if (Buffer.byteLength(f.content) > MAX_SYNTAX_BYTES) continue;
          const ext = f.path.toLowerCase().endsWith('.cjs') ? '.cjs' : '.mjs';
          const tmp = join(dir, `${bad.length + js.indexOf(f)}${ext}`);
          writeFileSync(tmp, f.content, 'utf8');
          try {
            execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000 });
          } catch (err) {
            const stderr = String(err?.stderr ?? '').split('\n').find((l) => /SyntaxError/.test(l)) ?? 'syntax error';
            bad.push(`${f.path}: ${stderr.trim().slice(0, 100)}`);
            badSteps.push(stepOf(f));
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    add('js-syntax', bad.length === 0, 'fail', bad.length === 0 ? `${js.length} JS file(s) parse` : bad.join('; '), badSteps);
  }

  return checks;
}

/** @param {ReturnType<typeof runChecks>} checks */
export function summarizeChecks(checks) {
  const failed = checks.filter((c) => !c.ok && c.severity === 'fail');
  const warned = checks.filter((c) => !c.ok && c.severity === 'warn');
  return { ok: failed.length === 0, failed: failed.map((c) => c.id), warned: warned.map((c) => c.id), total: checks.length };
}

export default { runChecks, summarizeChecks };
