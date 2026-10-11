#!/usr/bin/env node
/**
 * @file The weekly golden task eval (RO3). It runs in `ops-eval.yml`, or by hand.
 *
 *   node scripts/ops-eval.mjs run   --out eval-results.json [--max-calls 280] [--only groq,gemini]
 *       Sends the golden tasks to every configured model and writes the scores to a file. It writes nothing under state/.
 *   node scripts/ops-eval.mjs apply --in eval-results.json [--no-post]
 *       Writes the public mirror state/ops/eval.json, feeds the scores into the capability cache (state/agents.json),
 *       and posts them to the Worker (POST /ops/eval) when TITAN_WORKER_URL and OPS_TOKEN are set.
 *   node scripts/ops-eval.mjs all   Both steps, for a run on your machine.
 *
 * The results file holds model names, categories, scores, and counts. It holds no key and no answer text.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { capabilityRegistry } from '../src/orchestrator/capabilityRegistry.js';
import { buildTargets } from '../src/ops/canaryTargets.js';
import { DEFAULT_MAX_CALLS, evalMirror, feedCapabilityCache, runEval } from '../src/ops/eval.js';
import { UsageReporter } from '../src/ops/usageReporter.js';

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

async function run() {
  if (process.env.TITAN_DRY_RUN === '1') throw new Error('this script makes real calls. It refuses to run under TITAN_DRY_RUN.');
  const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const maxCalls = Number.parseInt(flag('--max-calls') ?? '', 10) || DEFAULT_MAX_CALLS;
  const usage = new UsageReporter();
  const targets = await buildTargets({ only });
  const result = await runEval({ targets, maxCalls, usage, onProgress: (l) => console.log(l) });
  console.log(`ops-eval: ${result.calls} call(s), ${result.tasksPerModel} task(s) for each model, ${result.rows.length} score(s).`);
  for (const s of result.skipped) console.log(`ops-eval: skipped ${s.provider} (${s.reason})`);
  const flushed = await usage.flush();
  console.log(`ops-eval: usage ${flushed.skipped ? `skipped (${flushed.skipped})` : `sent ${flushed.sent}`}`);
  return result;
}

function readResults(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data.rows)) throw new Error('the results file has no rows');
  for (const r of data.rows) {
    if (typeof r.provider !== 'string' || typeof r.model !== 'string' || typeof r.category !== 'string' || !(r.score >= 0 && r.score <= 1) || !(r.tasks_run > 0)) throw new Error('a row of the results file is not valid');
  }
  return data;
}

async function apply(data, { post }) {
  const mirror = evalMirror(data.rows);
  mkdirSync('state/ops', { recursive: true });
  writeFileSync('state/ops/eval.json', `${JSON.stringify(mirror, null, 2)}\n`);
  const changed = feedCapabilityCache(data.rows, capabilityRegistry);
  console.log(`ops-eval: wrote state/ops/eval.json and updated ${changed} record(s) of the capability cache.`);
  const workerUrl = (process.env.TITAN_WORKER_URL ?? '').replace(/\/$/, '');
  const token = process.env.OPS_TOKEN ?? '';
  if (post && workerUrl && token && data.rows.length > 0) {
    const results = data.rows.map(({ model, category, score, tasks_run, run_at, eval_version }) => ({ model, category, score, tasks_run, run_at, eval_version }));
    try {
      const res = await fetch(`${workerUrl}/ops/eval`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ results }), signal: AbortSignal.timeout(15_000) });
      console.log(`ops-eval: POST /ops/eval answered ${res.status}`);
    } catch (err) {
      console.error(`ops-eval: the Worker was not reachable (${err instanceof Error ? err.message.slice(0, 80) : 'error'}). The mirror is written.`);
    }
  } else {
    console.log('ops-eval: nothing was posted. The Worker URL or the ops token is not set, or there are no scores.');
  }
}

async function main() {
  if (mode === 'run' || mode === 'all') {
    const result = await run();
    const out = flag('--out') ?? 'eval-results.json';
    mkdirSync(dirname(out) || '.', { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    if (mode === 'all') await apply(result, { post: !args.includes('--no-post') });
    return 0;
  }
  if (mode === 'apply') {
    const input = flag('--in');
    if (!input) throw new Error('--in <file> is required');
    await apply(readResults(input), { post: !args.includes('--no-post') });
    return 0;
  }
  console.error('usage: ops-eval.mjs run|apply|all [--out file] [--in file] [--max-calls n] [--only ids] [--no-post]');
  return 2;
}

main().then((c) => process.exit(c), (err) => {
  console.error(`ops-eval: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
