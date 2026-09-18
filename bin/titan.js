#!/usr/bin/env node
/**
 * @file `titan` — the operator's command line. Every command works on a
 * state directory (`--state <dir>`, else `TITAN_STATE_DIR`, else ./state)
 * and none of them needs a provider key:
 *
 *   titan pulse [--dry-run]              run one pulse (what the workflow runs)
 *   titan simulate [--script f|happy] [--github f|memory] [--pulses N]
 *                                        run pulses against the fakes, no network
 *   titan explain <taskId>               why a task is where it is, how to unblock it
 *   titan replay <taskId>                the task's ordered event trail
 *   titan queue | analytics | providers  print a derived view (rebuilt from state)
 *   titan control <action> [target] [argument] [--reason "..."]
 *                                        apply a control action (audited)
 *   titan doctor                         check the checkout, state, schemas, and env
 *   titan bench [--repeat N] [--filter id]
 *                                        run the benchmark harness
 *
 * Output is plain text for humans, or one line of JSON (the last line of
 * output) with `--json`.
 */
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const USAGE = `titan — TITAN-Runner operator CLI

  titan pulse [--dry-run]                     run one pulse against ./state (or --state <dir>)
  titan simulate [--script f|happy] [--github f|memory] [--pulses N] [--state <dir>]
  titan explain <taskId>                      why a task is where it is, and how to unblock it
  titan replay <taskId>                       the task's ordered event trail
  titan queue | analytics | providers         a derived view, rebuilt from state
  titan control <action> [target] [argument] [--reason "..."]
  titan doctor                                check the checkout, state files, schemas, and env
  titan bench [--repeat N] [--filter id] [--out file]

Flags: --state <dir>  --json
`;

async function loadEngine(stateDir) {
  if (stateDir) process.env.TITAN_STATE_DIR = stateDir;
  const [{ StateStore }, { readEventsDir }, { resolveStateDir }] = await Promise.all([
    import('../src/state/store.js'), import('../src/observability/events.js'), import('../src/state/paths.js'),
  ]);
  const dir = resolveStateDir(stateDir);
  const store = new StateStore({ stateDir: dir });
  return { dir, store, events: () => readEventsDir(join(dir, 'events')) };
}

/** `--json` prints one line of JSON as the last line of output (log lines may precede it); pipe through `jq` to pretty-print. */
function print(obj, json, human) {
  if (json) {
    console.log(JSON.stringify(obj));
    return;
  }
  console.log(typeof human === 'function' ? human(obj) : human ?? JSON.stringify(obj, null, 2));
}

async function cmdPulse(args) {
  if (args.flags['dry-run']) process.env.TITAN_DRY_RUN = '1';
  if (args.flags.state) process.env.TITAN_STATE_DIR = args.flags.state;
  const { runPulse } = await import('../src/engine/pulse.js');
  const { fakeDepsFromEnv } = await import('../src/fakes/wire.js');
  const summary = await runPulse(fakeDepsFromEnv(process.env) ?? {});
  print(summary, true);
  return summary.error ? 1 : 0;
}

async function cmdSimulate(args) {
  const stateDir = args.flags.state ?? mkdtempSync(join(tmpdir(), 'titan-sim-'));
  const script = args.flags.script ?? 'happy';
  const githubSpec = args.flags.github ?? join(stateDir, 'github-fixture.json');
  if (!args.flags.github && !existsSync(githubSpec)) {
    // A single authorized issue so a plain `titan simulate` has something to run.
    writeFileSync(githubSpec, JSON.stringify({ issues: [{ number: 1, title: 'Simulated task', body: 'Build the module the fake script describes.', user: { login: 'simulated-owner' }, author_association: 'OWNER', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), labels: [{ name: 'titan-task' }], state: 'open', comments: [] }] }));
  }
  const pulses = Math.max(1, Number.parseInt(String(args.flags.pulses ?? '1'), 10) || 1);
  process.env.TITAN_STATE_DIR = stateDir;
  process.env.TITAN_FAKE_PROVIDER = script;
  process.env.TITAN_FAKE_GITHUB = githubSpec;
  process.env.TITAN_FAKE_QUIET = '1';
  process.env.TITAN_NETWORK = 'off';
  const { runPulse } = await import('../src/engine/pulse.js');
  const { fakeDepsFromEnv } = await import('../src/fakes/wire.js');
  const summaries = [];
  for (let p = 1; p <= pulses; p += 1) {
    process.env.TITAN_FAKE_PULSE_INDEX = String(p);
    process.env.TITAN_CLOCK_OFFSET_MS = String((p - 1) * 15 * 60_000);
    const deps = fakeDepsFromEnv(process.env);
    summaries.push(await runPulse({ ...deps, pulseId: `sim-${p}` }));
  }
  const tasks = JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8')).tasks;
  const out = { stateDir, pulses: summaries.map((s) => ({ pulseId: s.pulseId, claimed: s.tasksClaimed, completed: s.tasksCompleted, failed: s.tasksFailed, parked: s.tasksParked, modelCalls: s.modelCalls, error: s.error })), tasks: tasks.map((t) => ({ id: t.id, status: t.status, waitReason: t.waitReason ?? null, error: t.error ?? null })) };
  print(out, args.flags.json, (o) => [`state: ${o.stateDir}`, ...o.pulses.map((p) => `${p.pulseId}: claimed ${p.claimed}, completed ${p.completed}, failed ${p.failed}, parked ${p.parked}, model calls ${p.modelCalls}${p.error ? `, ERROR ${p.error}` : ''}`), ...o.tasks.map((t) => `  ${t.id}: ${t.status}${t.waitReason ? ` (${t.waitReason})` : ''}${t.error ? ` — ${t.error}` : ''}`)].join('\n'));
  return summaries.some((s) => s.error) ? 1 : 0;
}

async function cmdExplain(args) {
  const id = args._[1];
  if (!id) throw new Error('usage: titan explain <taskId>');
  const { store, events } = await loadEngine(args.flags.state);
  const { explainTask } = await import('../src/observability/explain.js');
  const tasks = store.loadTasks();
  const task = tasks.tasks.find((t) => t.id === id) ?? null;
  const out = explainTask({ task, checkpoint: task ? store.loadCheckpoint(id) : null, events: events(), control: store.loadControl() });
  print(out, args.flags.json, (o) => (o.found ? [`${id}: ${o.headline}`, o.waitingOn ? `waiting on: ${o.waitingOn}` : null, o.unblock ? `to unblock: ${o.unblock}` : null, '', ...o.facts, '', 'recent events:', ...o.lastEvents.map((l) => `  ${l}`)].filter((l) => l !== null).join('\n') : `no such task: ${id}`));
  return out.found ? 0 : 1;
}

async function cmdReplay(args) {
  const id = args._[1];
  if (!id) throw new Error('usage: titan replay <taskId>');
  const { events } = await loadEngine(args.flags.state);
  const { replayTask } = await import('../src/observability/explain.js');
  const out = replayTask(id, events());
  print(out, args.flags.json, (o) => (o.count === 0 ? `no events for ${id}` : o.lines.join('\n')));
  return 0;
}

async function cmdView(args, name) {
  const { store, dir } = await loadEngine(args.flags.state);
  const { buildQueueView, buildAnalyticsView, buildProvidersView, readEventArchive } = await import('../src/observability/views.js');
  const { readEventsDir } = await import('../src/observability/events.js');
  const now = () => new Date();
  let out;
  if (name === 'queue') out = buildQueueView(store.loadTasks(), { now });
  else if (name === 'analytics') out = buildAnalyticsView(readEventsDir(join(dir, 'events')), { now, archive: readEventArchive(join(dir, 'events')) });
  else {
    const { ProviderHealthStore } = await import('../src/providers/health.js');
    const { QuotaLedger } = await import('../src/reliability/quota.js');
    const health = new ProviderHealthStore(store.paths.providers);
    out = buildProvidersView({ health, ids: ['groq', 'together', 'openrouter', 'gemini', 'huggingface', 'opencode', 'freebuff'], quota: new QuotaLedger({ path: store.paths.quota }), now });
  }
  print(out, true);
  return 0;
}

async function cmdControl(args) {
  const { runControl } = await import('../src/control/cli.js');
  const rest = args._.slice(1);
  const argv = args.flags.reason ? [...rest, '--reason', String(args.flags.reason)] : rest;
  const result = runControl(argv, { ...process.env, ...(args.flags.state ? { TITAN_STATE_DIR: args.flags.state } : {}) });
  print({ ok: result.ok, outcome: result.outcome, message: result.message, by: result.by }, args.flags.json, (o) => `${o.ok ? 'ok' : 'REJECTED'}: ${o.message} (by ${o.by})`);
  return result.ok ? 0 : 1;
}

async function cmdDoctor(args) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  add('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
  const { dir, store } = await loadEngine(args.flags.state);
  add('state directory', existsSync(dir), dir);
  try {
    const t = store.loadTasks();
    add('tasks.json loads and validates', true, `v${t.version}, ${t.tasks.length} task(s)${store.repairs.length ? `, repaired: ${store.repairs.map((r) => r.file ?? r).join(', ')}` : ''}`);
  } catch (err) {
    add('tasks.json loads and validates', false, err instanceof Error ? err.message : String(err));
  }
  try {
    const c = store.loadControl();
    add('control.json', true, `autonomy ${c.autonomy}${c.killSwitch ? ', KILL SWITCH ON' : ''}${c.drain ? ', draining' : ''}${c.safeMode ? ', safe mode' : ''}`);
  } catch (err) {
    add('control.json', false, String(err));
  }
  const { SCHEMA_FILES } = await import('../src/state/schema.js');
  const stale = Object.entries(SCHEMA_FILES).filter(([name, schema]) => {
    const path = join(ROOT, 'schemas', `${name}.schema.json`);
    return !existsSync(path) || readFileSync(path, 'utf8') !== `${JSON.stringify(schema, null, 2)}\n`;
  }).map(([name]) => name);
  add('schemas/ in sync with src/state/schema.js', stale.length === 0, stale.length ? `stale: ${stale.join(', ')} (run scripts/export-schemas.mjs)` : 'in sync');
  const { config, isProviderConfigured } = await import('../src/config.js');
  const configured = ['groq', 'together', 'openrouter', 'gemini', 'huggingface', 'opencode'].filter((id) => isProviderConfigured(id));
  add('provider keys', true, configured.length ? `configured: ${configured.join(', ')}` : 'none configured (the pulse runs, every provider reports not_configured)');
  add('reviewer gate', config.reviewer?.enabled !== false, config.reviewer?.enabled === false ? 'DISABLED by TITAN_REVIEWER=0' : 'on');
  add('egress allowlist', true, process.env.TITAN_EGRESS_ALLOWLIST ? process.env.TITAN_EGRESS_ALLOWLIST : 'empty (http_fetch tool allows nothing)');
  const heartbeat = join(dir, 'heartbeat.json');
  if (existsSync(heartbeat)) {
    const h = JSON.parse(readFileSync(heartbeat, 'utf8'));
    const age = h.lastPulseAt ? Math.round((Date.now() - Date.parse(h.lastPulseAt)) / 60_000) : null;
    add('last pulse', h.lastPulseStatus !== 'error', `${h.lastPulseAt ?? 'never'}${age != null ? ` (${age} min ago)` : ''}, status ${h.lastPulseStatus}, ${h.consecutivePulseFailures ?? 0} consecutive failure(s)`);
  }
  const ok = checks.every((c) => c.ok);
  print({ ok, checks }, args.flags.json, (o) => o.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`).join('\n'));
  return ok ? 0 : 1;
}

function cmdBench(args) {
  const argv = [join(ROOT, 'bench', 'harness.mjs')];
  for (const f of ['repeat', 'filter', 'out', 'scratch']) if (args.flags[f] != null) argv.push(`--${f}`, String(args.flags[f]));
  if (args.flags.keep) argv.push('--keep');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=512', ...argv], { stdio: 'inherit', cwd: ROOT });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  switch (cmd) {
    case 'pulse': return cmdPulse(args);
    case 'simulate': return cmdSimulate(args);
    case 'explain': return cmdExplain(args);
    case 'replay': return cmdReplay(args);
    case 'queue': case 'analytics': case 'providers': return cmdView(args, cmd);
    case 'control': return cmdControl(args);
    case 'doctor': return cmdDoctor(args);
    case 'bench': return cmdBench(args);
    case undefined: case 'help': case '--help': case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] && /[\\/]titan(\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
}
