#!/usr/bin/env node
/**
 * @file `node src/control/cli.js <action> [target] [argument] [--reason "..."]`
 *
 * The control workflow (`.github/workflows/titan-control.yml`) and the
 * local operator both land here. Reads the state directory, applies one
 * action (`control/dispatch.js`), writes control.json / tasks.json through
 * the validated store, appends the audit event, and prints one JSON line.
 * It never talks to GitHub or a provider; the workflow commits `state/`.
 *
 * The actor is `TITAN_CONTROL_ACTOR` (the workflow passes `github.actor`),
 * else the local user. Exit code 1 when the action was rejected.
 */
import { resolveStateDir } from '../state/paths.js';
import { StateStore } from '../state/store.js';
import { EventLog } from '../observability/events.js';
import { applyControlAction } from './dispatch.js';
import { now as clockNow } from '../lib/clock.js';
import { join } from 'node:path';
import { userInfo } from 'node:os';

function parseArgs(argv) {
  const out = { positional: [], reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reason') out.reason = argv[++i] ?? null;
    else if (argv[i].startsWith('--reason=')) out.reason = argv[i].slice('--reason='.length);
    else out.positional.push(argv[i]);
  }
  return out;
}

export function runControl(argv, env = process.env) {
  const { positional, reason } = parseArgs(argv);
  const [action, target = null, argument = null] = positional;
  const stateDir = resolveStateDir(env.TITAN_STATE_DIR);
  const now = clockNow;
  const events = new EventLog({ dir: join(stateDir, 'events'), pulseId: `control-${Date.now().toString(36)}`, now });
  const store = new StateStore({ stateDir, now, events });
  store.ensureLayout();
  const control = store.loadControl();
  const tasksFile = store.loadTasks();
  let by = env.TITAN_CONTROL_ACTOR;
  if (!by) {
    try {
      by = `local:${userInfo().username}`;
    } catch {
      by = 'local';
    }
  }
  const result = applyControlAction({ action, target, argument, reason, by, control, tasksFile, now, events });
  if (result.ok) {
    store.saveControl(result.control);
    store.saveTasks(tasksFile);
  }
  return { ...result, by, stateDir };
}

const invokedDirectly = process.argv[1] && /[\\/]cli\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  const result = runControl(process.argv.slice(2));
  console.log(JSON.stringify({ ok: result.ok, outcome: result.outcome, message: result.message, by: result.by }));
  if (!result.ok) process.exitCode = 1;
}
