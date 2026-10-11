/**
 * @file The deterministic checkers of the golden tasks (RO3). No model judges another model.
 *
 *   exact  the answer equals a fixed text, after the text is cleaned (fences, quotes, a final period, case)
 *   regex  the answer matches a pattern
 *   json   the answer holds JSON that fits a schema, and holds required values
 *   code   the answer is JavaScript. A unit test calls its function with fixed inputs and compares the results.
 *
 * CODE FROM A MODEL IS UNTRUSTED. The unit test never runs it in this process. It runs in a child process that has:
 *   - an EMPTY environment, so no key and no token is there to read,
 *   - a temporary folder as its working folder,
 *   - Node's permission model when this Node has it, which denies files, child processes, and workers,
 *   - a bare `vm` context, a time limit for each call, and a hard kill by the parent after a few seconds.
 * `vm` is not a security boundary by itself. The empty environment and the permission model are what contain the code.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../lib/validate.js';

const KILL_AFTER_MS = 8_000;
const MAX_OUTPUT = 20_000;

/** Take the text out of a code fence, if there is one. */
export function unfence(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/```[a-zA-Z0-9]*\s*\n?([\s\S]*?)```/);
  return (m ? m[1] : raw).trim();
}

function normalize(text) {
  return unfence(text).replace(/^[`"'\s]+|[`"'\s]+$/g, '').replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim().toLowerCase();
}

function extractJson(text) {
  const raw = String(text ?? '');
  const candidates = [unfence(raw), raw.trim(), ...(raw.match(/\{[\s\S]*\}/g) ?? []), ...(raw.match(/\[[\s\S]*\]/g) ?? [])];
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, value: null };
}

const at = (value, path) => String(path).split('.').reduce((v, k) => (v == null ? undefined : v[k]), value);

let permissionFlag;
/** The flag that turns on the permission model on this Node, or null. */
async function detectPermissionFlag() {
  if (permissionFlag !== undefined) return permissionFlag;
  for (const flag of ['--permission', '--experimental-permission']) {
    const ok = await new Promise((resolve) => {
      const child = spawn(process.execPath, [flag, '-e', '0'], { env: {}, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    if (ok) {
      permissionFlag = flag;
      return flag;
    }
  }
  permissionFlag = null;
  return null;
}

/** The program that the child runs. It reads one job from stdin and writes one result to stdout. */
const RUNNER = `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const vm = require('node:vm');
  const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const out = { passed: 0, total: job.cases.length, error: null };
  try {
    const ctx = vm.createContext({});
    vm.runInContext(job.code, ctx, { timeout: 1500 });
    const exists = vm.runInContext('typeof ' + job.fn + ' === "function"', ctx);
    if (!exists) out.error = 'no_function';
    else {
      for (const c of job.cases) {
        try {
          ctx.__args = vm.runInContext('(' + JSON.stringify(c.args) + ')', ctx);
          const got = vm.runInContext('JSON.stringify(' + job.fn + '(...__args))', ctx, { timeout: 1500 });
          if (got === JSON.stringify(c.expect)) out.passed += 1;
        } catch (e) { /* a case that throws fails */ }
      }
    }
  } catch (e) { out.error = 'code_error'; }
  process.stdout.write(JSON.stringify(out));
});
`;

/**
 * Run the unit test of a code task in the isolated child.
 * @returns {Promise<{ passed: number, total: number, error: string|null }>}
 */
export async function runCodeCases({ code, fn, cases }) {
  const flag = await detectPermissionFlag();
  // Fail closed. The job that runs this holds provider keys in the environment of the PARENT. Without the permission
  // model, a child could read them from /proc. So without it, no model code runs. A person can allow it on their own
  // machine, where no key is at stake, with TITAN_EVAL_ALLOW_UNSANDBOXED=1.
  if (!flag && process.env.TITAN_EVAL_ALLOW_UNSANDBOXED !== '1') return { passed: 0, total: cases.length, error: 'no_sandbox' };
  const dir = mkdtempSync(join(tmpdir(), 'titan-golden-'));
  try {
    return await new Promise((resolve) => {
      const args = [...(flag ? [flag] : []), '--max-old-space-size=64', '-e', RUNNER];
      const child = spawn(process.execPath, args, { cwd: dir, env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
      child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
      child.on('error', () => { clearTimeout(timer); resolve({ passed: 0, total: cases.length, error: 'spawn_error' }); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out);
          resolve({ passed: Number(parsed.passed) || 0, total: cases.length, error: parsed.error ?? null });
        } catch {
          resolve({ passed: 0, total: cases.length, error: 'no_result' });
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ code, fn, cases }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check one answer against the checker of its task.
 * @param {{ checker: any }} task
 * @param {string} text The answer of the model.
 * @returns {Promise<{ pass: boolean, reason: string }>}
 */
export async function checkAnswer(task, text) {
  const c = task.checker;
  if (typeof text !== 'string' || text.trim() === '') return { pass: false, reason: 'empty' };
  if (c.type === 'exact') return normalize(text) === normalize(c.answer) ? { pass: true, reason: 'ok' } : { pass: false, reason: 'wrong_answer' };
  if (c.type === 'regex') return new RegExp(c.pattern, c.flags ?? '').test(unfence(text)) ? { pass: true, reason: 'ok' } : { pass: false, reason: 'no_match' };
  if (c.type === 'json') {
    const j = extractJson(text);
    if (!j.ok) return { pass: false, reason: 'bad_json' };
    if (validate(j.value, c.schema).length > 0) return { pass: false, reason: 'schema' };
    if (c.includesAll) {
      const list = at(j.value, c.includesAll.path);
      if (!Array.isArray(list) || !c.includesAll.values.every((v) => list.includes(v))) return { pass: false, reason: 'missing_values' };
    }
    return { pass: true, reason: 'ok' };
  }
  if (c.type === 'code') {
    const code = unfence(text);
    for (const p of c.requires ?? []) if (!new RegExp(p).test(code)) return { pass: false, reason: 'missing_construct' };
    for (const p of c.forbids ?? []) if (new RegExp(p).test(code)) return { pass: false, reason: 'forbidden_construct' };
    const res = await runCodeCases({ code, fn: c.fn, cases: c.cases });
    if (res.error) return { pass: false, reason: res.error };
    return res.passed === res.total ? { pass: true, reason: 'ok' } : { pass: false, reason: 'failed_cases' };
  }
  return { pass: false, reason: 'unknown_checker' };
}

export default { checkAnswer, runCodeCases, unfence };
