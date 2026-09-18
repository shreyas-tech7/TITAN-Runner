#!/usr/bin/env node
/**
 * @file The measuring stick. Drives the real pulse entrypoint, as a child
 * process, through every scenario in `bench/scenarios.mjs` against the
 * deterministic fake provider and fake GitHub in a scratch copy of the repo
 * with its own scratch state directory. Records pass / fail / not-supported
 * per scenario plus the raw numbers (wall clock, peak RSS, model calls,
 * GitHub mutations, state bytes churned) and writes them as JSON.
 *
 *   node bench/harness.mjs --out bench/results/before.json [--repeat 5]
 *                          [--filter single-step] [--keep] [--with-tests]
 *
 * Every number in docs/runner-upgrade/REPORT.md traces back to one of these
 * files. Results are never hand-edited. Fake latency is 2–8 ms, so timings
 * measure Runner overhead, not model speed.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, BASE_ENV_DEFAULT } from './scenarios.mjs';
import { runPulseProcess, readJsonl, readJsonOr, stats } from './lib/run.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Simulated gap between pulses (the production cron cadence). */
const PULSE_CADENCE_MS = 15 * 60_000;

const TERMINAL = new Set(['complete', 'succeeded', 'failed', 'blocked', 'cancelled', 'pr-open', 'dead-lettered', 'expired']);

function parseArgs(argv) {
  const out = { out: null, repeat: 5, filter: null, keep: false, withTests: false, scratch: process.env.TITAN_BENCH_SCRATCH || join(tmpdir(), 'titan-bench') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--repeat') out.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--with-tests') out.withTests = true;
    else if (a === '--scratch') out.scratch = argv[++i];
  }
  return out;
}

/** A private copy of the engine so a scenario can never touch the real checkout or its git state. */
function makeScratchRepo(scratchRoot) {
  const repo = join(scratchRoot, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const entry of ['src', 'package.json']) cpSync(join(REPO_ROOT, entry), join(repo, entry), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', 'add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', 'commit', '-q', '-m', 'bench baseline'], { cwd: repo });
  return repo;
}

async function detectCapabilities(repo) {
  const file = join(repo, 'src', 'capabilities.js');
  if (!existsSync(file)) return [];
  try {
    const mod = await import(`${file}?t=${Date.now()}`);
    const caps = mod.CAPABILITIES ?? mod.default ?? [];
    return Array.isArray(caps) ? caps : Object.keys(caps);
  } catch {
    return [];
  }
}

function seedState(stateDir, scenario) {
  mkdirSync(join(stateDir, 'runs'), { recursive: true });
  mkdirSync(join(stateDir, 'digests'), { recursive: true });
  mkdirSync(join(stateDir, 'reviews'), { recursive: true });
  const tasks = { version: 1, updatedAt: new Date(0).toISOString(), tasks: scenario.seedTasks ?? [] };
  writeFileSync(join(stateDir, 'tasks.json'), JSON.stringify(tasks, null, 2));
  writeFileSync(join(stateDir, 'agents.json'), '{}');
  // An operator's control file (autonomy level, switches) seeded before the first pulse.
  if (scenario.control) {
    writeFileSync(join(stateDir, 'control.json'), JSON.stringify({ version: 1, killSwitch: false, drain: false, safeMode: false, autonomy: 'autonomous', updatedAt: new Date(0).toISOString(), updatedBy: 'bench', reason: 'scenario', ...scenario.control }, null, 2));
  }
  if (scenario.corrupt) {
    // Simulate a bad hand edit / conflict marker landing in a committed file
    // after a good version existed: the good version is what an engine with
    // backups would have kept under state/backup/ on its previous save.
    mkdirSync(join(stateDir, 'backup'), { recursive: true });
    writeFileSync(join(stateDir, 'backup', scenario.corrupt), JSON.stringify(tasks, null, 2));
    const target = join(stateDir, scenario.corrupt);
    writeFileSync(target, '<<<<<<< HEAD\n{"version":1,"tasks":[\n=======\ngarbage\n>>>>>>> theirs\n');
  }
}

/** Every event the engine recorded, in file order (null when there is no event log). */
function readEvents(stateDir) {
  const dir = join(stateDir, 'events');
  if (!existsSync(dir)) return null;
  const out = [];
  for (const file of (readdirSafe(dir)).filter((f) => f.endsWith('.jsonl')).sort()) out.push(...readJsonl(join(dir, file)));
  return out;
}

function readTimeline(stateDir) {
  const events = readEvents(stateDir);
  if (!events) return null;
  const out = [];
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    if (ev.type === 'task.transition' || ev.type === 'task.state') out.push({ seq, taskId: ev.taskId, status: ev.to ?? ev.status, at: ev.ts });
  }
  return out;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function runScenario(scenario, opts, capabilities, rep) {
  const scratch = join(opts.scratch, `${scenario.id}-${rep}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const repo = makeScratchRepo(scratch);
  const stateDir = join(scratch, 'state');
  const logs = join(scratch, 'logs');
  mkdirSync(logs, { recursive: true });
  seedState(stateDir, scenario);

  const githubPath = join(scratch, 'github.json');
  writeFileSync(githubPath, JSON.stringify(scenario.github ?? { issues: [] }));
  const scripts = Array.isArray(scenario.provider) ? scenario.provider : [scenario.provider];
  const controlFields = (c) => ({ killSwitch: c?.killSwitch ?? false, drain: c?.drain ?? false, safeMode: c?.safeMode ?? false, autonomy: c?.autonomy ?? 'autonomous' });
  const controlBefore = controlFields(readJsonOr(join(stateDir, 'control.json'), null));

  const pulses = [];
  const timelineByPulse = [];
  let pulsesToTerminal = null;
  const planned = scenario.pulses ?? 1;

  for (let p = 1; p <= planned; p += 1) {
    // A scenario may act between pulses the way a human would (an approval
    // comment, a reopened issue): it edits the GitHub fixture and the state
    // on disk, never the engine.
    if (typeof scenario.beforePulse === 'function' && p > 1) {
      const fixture = readJsonOr(githubPath, { issues: [] });
      const changed = scenario.beforePulse(p, { fixture, stateDir, tasks: readJsonOr(join(stateDir, 'tasks.json'), { tasks: [] }).tasks ?? [] });
      if (changed !== false) writeFileSync(githubPath, JSON.stringify(fixture));
    }
    const script = scripts[Math.min(p - 1, scripts.length - 1)];
    const scriptPath = join(scratch, `provider-${p}.json`);
    writeFileSync(scriptPath, JSON.stringify(script));
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...BASE_ENV_DEFAULT,
      ...(scenario.env ?? {}),
      TITAN_FAKE_PROVIDER: scriptPath,
      TITAN_FAKE_GITHUB: githubPath,
      TITAN_FAKE_LOG_DIR: logs,
      TITAN_FAKE_PULSE_INDEX: String(p),
      GITHUB_RUN_ID: `bench-${p}`,
      // The engine's clock moves forward one cron cadence per pulse (the
      // harness runs pulses back to back; production leaves ~15 minutes
      // between them), so wake times, cooldowns, and quota windows behave
      // as they would across real pulses. Concurrent pulses share a clock.
      TITAN_CLOCK_OFFSET_MS: String((p - 1) * (scenario.pulseCadenceMs ?? PULSE_CADENCE_MS)),
    };
    const concurrent = scenario.concurrent ?? 1;
    const runs = await Promise.all(Array.from({ length: concurrent }, (_, k) => runPulseProcess({ repoRoot: repo, stateDir, env: { ...env, TITAN_FAKE_PULSE_INDEX: concurrent > 1 ? `${p}.${k + 1}` : String(p), GITHUB_RUN_ID: concurrent > 1 ? `bench-${p}-${k + 1}` : `bench-${p}` }, timeoutMs: 30_000 })));
    for (const r of runs) pulses.push({ pulse: p, exitCode: r.exitCode, signal: r.signal, wallMs: Math.round(r.wallMs * 10) / 10, peakRssKb: r.peakRssKb, summary: r.summary, stateBytesChanged: r.stateBytesChanged, stateFilesChanged: r.stateFilesChanged, stderrTail: r.stderr.slice(-600) });
    const tasksNow = readJsonOr(join(stateDir, 'tasks.json'), { tasks: [] }).tasks ?? [];
    timelineByPulse.push({ pulse: p, statuses: tasksNow.map((t) => ({ taskId: t.id, status: t.status })) });
    const allTerminal = tasksNow.length > 0 && tasksNow.every((t) => TERMINAL.has(t.status));
    if (allTerminal && pulsesToTerminal == null) pulsesToTerminal = p;
    if (allTerminal && !scenario.timed) break;
    // The cron gap between pulses, shrunk: long enough for a crashed pulse's
    // lease (TITAN_LEASE_TTL_MS) to expire before the next pulse looks.
    if (p < planned) await new Promise((r) => setTimeout(r, scenario.pulseGapMs ?? 450));
  }

  const providerCalls = readJsonl(join(logs, 'provider-calls.jsonl')).map((c) => ({ ...c, pulse: Number(String(c.pulse).split('.')[0]) }));
  const githubCalls = readJsonl(join(logs, 'github-calls.jsonl'));
  const tasks = readJsonOr(join(stateDir, 'tasks.json'), { tasks: [] }).tasks ?? [];
  const githubIssues = readJsonOr(githubPath, { issues: [] }).issues ?? [];
  const eventTimeline = readTimeline(stateDir);
  const timeline = eventTimeline ?? timelineByPulse.flatMap((p, i) => p.statuses.map((s, j) => ({ seq: i * 1000 + j, taskId: s.taskId, status: s.status })));
  const controlAfter = controlFields(readJsonOr(join(stateDir, 'control.json'), null));

  const observed = {
    tasks, githubIssues, providerCalls, githubCalls, pulses, timeline, pulsesToTerminal,
    events: readEvents(stateDir) ?? [],
    repoHasFile: (rel) => existsSync(join(repo, rel)),
    parentHasFile: (rel) => existsSync(join(scratch, rel)),
    stateHasFile: (rel) => existsSync(join(stateDir, rel)),
    controlUnchanged: JSON.stringify(controlBefore) === JSON.stringify(controlAfter),
    controlDetail: `control before ${JSON.stringify(controlBefore)} after ${JSON.stringify(controlAfter)}`,
  };

  let checks = [];
  try {
    checks = scenario.expect(observed);
  } catch (err) {
    checks = [{ name: 'expect() threw', ok: false, detail: String(err) }];
  }
  const missing = (scenario.requires ?? []).filter((c) => !capabilities.includes(c));
  const status = missing.length > 0 ? 'not-supported' : checks.every((c) => c.ok) ? 'pass' : 'fail';

  const metrics = {
    pulsesRun: pulses.length,
    pulsesToTerminal,
    modelCalls: providerCalls.filter((c) => c.kind === 'subtask' || c.kind === 'decompose').length,
    providerCallsTotal: providerCalls.length,
    githubMutations: githubCalls.filter((c) => ['commentOnIssue', 'closeIssue', 'createPullRequest', 'closePullRequest', 'createIssue'].includes(c.op)).length,
    duplicateComments: Object.values(githubCalls.filter((c) => c.op === 'commentOnIssue').reduce((acc, c) => { acc[c.args.number] = (acc[c.args.number] ?? 0) + 1; return acc; }, {})).reduce((s, n) => s + Math.max(0, n - 1), 0),
    firstPulseWallMs: pulses[0]?.wallMs ?? null,
    peakRssKb: Math.max(0, ...pulses.map((p) => p.peakRssKb)),
    stateBytesChangedPerPulse: pulses.map((p) => p.stateBytesChanged),
    taskOutcomes: tasks.map((t) => ({ id: t.id, status: t.status })),
  };

  if (!opts.keep) rmSync(scratch, { recursive: true, force: true });
  return { id: scenario.id, group: scenario.group, status, missingCapabilities: missing, checks, metrics, pulses };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.scratch, { recursive: true });
  const probeRepo = makeScratchRepo(join(opts.scratch, '_probe'));
  const capabilities = await detectCapabilities(probeRepo);
  rmSync(join(opts.scratch, '_probe'), { recursive: true, force: true });

  const commit = safeGit(['rev-parse', 'HEAD']);
  const results = [];
  const selected = SCENARIOS.filter((s) => !opts.filter || s.id === opts.filter || s.group === opts.filter);

  for (const scenario of selected) {
    const reps = scenario.timed ? opts.repeat : 1;
    const runs = [];
    for (let r = 1; r <= reps; r += 1) {
      const res = await runScenario(scenario, opts, capabilities, r);
      runs.push(res);
      process.stderr.write(`${scenario.id} [${r}/${reps}] ${res.status}${res.status === 'fail' ? ` — ${res.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}` : ''}\n`);
    }
    const primary = runs[runs.length - 1];
    const timing = scenario.timed ? {
      firstPulseWallMs: stats(runs.map((x) => x.metrics.firstPulseWallMs).filter((v) => v != null)),
      allPulsesWallMs: stats(runs.flatMap((x) => x.pulses.map((p) => p.wallMs))),
      peakRssKb: stats(runs.map((x) => x.metrics.peakRssKb)),
      stateBytesChangedPerPulse: stats(runs.flatMap((x) => x.metrics.stateBytesChangedPerPulse)),
      repeats: reps,
    } : null;
    results.push({ ...primary, timing, allStatuses: runs.map((x) => x.status) });
  }

  const byStatus = (st) => results.filter((r) => r.status === st).length;
  const corpus = results.filter((r) => r.group === 'corpus');
  const faults = results.filter((r) => r.group === 'fault');
  const idle = results.find((r) => r.id === 'idle-pulse');
  const single = results.find((r) => r.id === 'single-step');
  const summary = {
    scenarios: results.length,
    pass: byStatus('pass'),
    fail: byStatus('fail'),
    notSupported: byStatus('not-supported'),
    corpusCompletionRate: corpus.length ? round(corpus.filter((r) => r.status === 'pass').length / corpus.length) : null,
    faultRecoveryRate: faults.length ? round(faults.filter((r) => r.status === 'pass').length / faults.length) : null,
    duplicateSideEffectsTotal: results.reduce((s, r) => s + r.metrics.duplicateComments, 0),
    modelCallsTotal: results.reduce((s, r) => s + r.metrics.modelCalls, 0),
    idlePulseWallMsMedian: idle?.timing?.allPulsesWallMs?.median ?? null,
    idlePulseStateBytesMedian: idle?.timing?.stateBytesChangedPerPulse?.median ?? null,
    singleStepWallMsMedian: single?.timing?.firstPulseWallMs?.median ?? null,
    peakRssKbMax: Math.max(0, ...results.map((r) => r.metrics.peakRssKb)),
    tests: opts.withTests ? runTests() : null,
  };

  const out = { meta: { at: new Date().toISOString(), commit, node: process.version, platform: `${process.platform} ${process.arch}`, repeat: opts.repeat, capabilities, note: 'Fake-provider latency is synthetic (2-8 ms); timings measure Runner overhead, not model speed.' }, summary, scenarios: results };
  const json = JSON.stringify(out, null, 2);
  if (opts.out) {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(resolve(opts.out), `${json}\n`);
    process.stderr.write(`wrote ${opts.out}\n`);
  }
  process.stdout.write(`${JSON.stringify({ summary, matrix: results.map((r) => ({ id: r.id, status: r.status })) }, null, 2)}\n`);
}

function runTests() {
  try {
    const out = execFileSync('npm', ['test', '--silent'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const n = (re) => Number((out.match(re) ?? [])[1] ?? 0);
    return { tests: n(/^# tests (\d+)/m), pass: n(/^# pass (\d+)/m), fail: n(/^# fail (\d+)/m) };
  } catch (err) {
    const out = `${err.stdout ?? ''}`;
    const n = (re) => Number((out.match(re) ?? [])[1] ?? 0);
    return { tests: n(/^# tests (\d+)/m), pass: n(/^# pass (\d+)/m), fail: n(/^# fail (\d+)/m), error: 'npm test exited non-zero' };
  }
}

function safeGit(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

await main();
