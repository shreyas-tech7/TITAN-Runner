/**
 * @file The operator's control plane: one function that applies one
 * control action to the state, authenticated by GitHub and audited by the
 * event log.
 *
 * Who may call it: `workflow_dispatch` on `titan-control.yml` — only a user
 * with write access to the repository can trigger it, and GitHub records
 * who did (`github.actor`, passed in as `by`). Locally, the CLI passes the
 * operating-system user. There is no other path: nothing in the pulse
 * reads a control action from an issue body, a comment (the `/titan`
 * commands are task commands, see control/commands.js), or the network.
 *
 * Actions:
 *   kill-switch on|off   halt: the pulse reconciles and heartbeats, claims nothing
 *   drain on|off         intake continues, nothing new is claimed
 *   safe-mode on|off     no external side effects (policy/engine.js)
 *   autonomy <level>     dry-run | propose | approval | autonomous
 *   cancel|pause|resume|retry <taskId>
 *   priority <taskId> <low|normal|high|urgent>
 *   approve|deny <taskId> <key|all>
 *
 * Every action is one `control.action` event with `audit: true`, and the
 * control file records who changed it last and why.
 */
import { AUTONOMY_LEVELS } from '../policy/engine.js';
import { applyCommand } from '../issueSync.js';
import { COMMANDS } from './commands.js';

export const CONTROL_ACTIONS = Object.freeze(['kill-switch', 'drain', 'safe-mode', 'autonomy', 'cancel', 'pause', 'resume', 'retry', 'priority', 'approve', 'deny']);
const SWITCHES = { 'kill-switch': 'killSwitch', drain: 'drain', 'safe-mode': 'safeMode' };
const MAX_REASON = 300;

function parseOnOff(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'no'].includes(v)) return false;
  return null;
}

/**
 * @param {{
 *   action: string, target?: string|null, argument?: string|null, reason?: string|null, by: string,
 *   control: object, tasksFile: { tasks: object[] }, now?: () => Date, events?: { append: Function }|null,
 * }} input
 * @returns {{ ok: boolean, outcome: string, control: object, message: string }}
 */
export function applyControlAction(input) {
  const now = input.now ?? (() => new Date());
  const events = input.events ?? null;
  const by = String(input.by ?? '').trim().slice(0, 80);
  const action = String(input.action ?? '').trim().toLowerCase();
  const target = input.target == null ? null : String(input.target).trim().slice(0, 120);
  const argument = input.argument == null ? null : String(input.argument).trim().slice(0, 64);
  const reason = input.reason == null ? null : String(input.reason).trim().slice(0, MAX_REASON) || null;
  const control = { ...input.control };
  const audit = (outcome, extra = {}) => {
    events?.append('control.action', { action, target, argument, outcome, by, reason, audit: true, ...extra });
    return outcome;
  };
  const stamp = () => {
    control.updatedAt = now().toISOString();
    control.updatedBy = by || null;
    control.reason = reason;
  };

  if (!by) return { ok: false, outcome: audit('rejected-no-actor'), control: input.control, message: 'a control action needs an actor' };
  if (!CONTROL_ACTIONS.includes(action)) return { ok: false, outcome: audit('rejected-unknown-action'), control: input.control, message: `unknown action: ${action || '(empty)'}` };

  if (action in SWITCHES) {
    const value = parseOnOff(argument ?? target);
    if (value === null) return { ok: false, outcome: audit('rejected-bad-argument'), control: input.control, message: `${action} needs on or off` };
    const field = SWITCHES[action];
    const changed = control[field] !== value;
    control[field] = value;
    stamp();
    return { ok: true, outcome: audit(changed ? `${action}-${value ? 'on' : 'off'}` : 'unchanged', { field, value }), control, message: `${action} is now ${value ? 'on' : 'off'}${changed ? '' : ' (unchanged)'}` };
  }

  if (action === 'autonomy') {
    const level = String(argument ?? target ?? '').toLowerCase();
    if (!AUTONOMY_LEVELS.includes(level)) return { ok: false, outcome: audit('rejected-bad-argument'), control: input.control, message: `autonomy must be one of ${AUTONOMY_LEVELS.join(', ')}` };
    const changed = control.autonomy !== level;
    control.autonomy = level;
    stamp();
    return { ok: true, outcome: audit(changed ? `autonomy-${level}` : 'unchanged', { level }), control, message: `autonomy is now ${level}${changed ? '' : ' (unchanged)'}` };
  }

  // Task commands share the grammar and the state changes of the `/titan`
  // issue commands; the actor here is the workflow's dispatcher.
  const spec = COMMANDS[action];
  if (!spec) return { ok: false, outcome: audit('rejected-unknown-action'), control: input.control, message: `unknown action: ${action}` };
  if (!target) return { ok: false, outcome: audit('rejected-no-target'), control: input.control, message: `${action} needs a task id` };
  const task = input.tasksFile.tasks.find((t) => t.id === target);
  if (!task) return { ok: false, outcome: audit('rejected-no-such-task'), control: input.control, message: `no such task: ${target}` };
  const args = spec.args > 0 ? [argument ?? (action === 'approve' || action === 'deny' ? 'all' : '')] : [];
  if (spec.args > 0 && args[0] === '') return { ok: false, outcome: audit('rejected-bad-argument'), control: input.control, message: `${action} needs an argument` };
  const outcome = applyCommand(task, { verb: action, args }, { now, events, by });
  const ok = !outcome.startsWith('ignored');
  audit(outcome, { taskId: target });
  return { ok, outcome, control: input.control, message: ok ? `${action} ${target}: ${outcome}` : `${action} ${target} was ignored (${outcome}; status ${task.status})` };
}

export default { applyControlAction, CONTROL_ACTIONS };
