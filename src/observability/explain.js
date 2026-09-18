/**
 * @file `explain` and `replay`: why a task is where it is, and what happened
 * to it, derived from the task record, its checkpoint, and the event log.
 * Pure functions over data — the CLI (`bin/titan explain|replay <taskId>`)
 * prints them; nothing in the engine reads them.
 */
import { PARK_BACKOFF_MS } from '../reliability/retryPolicy.js';

const SUMMARY_FIELDS = ['stepId', 'provider', 'outcome', 'failureClass', 'code', 'action', 'why', 'reason', 'tool', 'check', 'detail', 'verdict', 'key', 'to', 'from', 'waitReason', 'wakeAt', 'approvalKey', 'calls', 'durationMs'];

/** One line per event, content-free (the log is already redacted; this only picks fields). */
export function summarizeEvent(e) {
  const parts = [];
  for (const f of SUMMARY_FIELDS) {
    if (e[f] === undefined || e[f] === null || e[f] === '') continue;
    const v = typeof e[f] === 'string' ? e[f] : JSON.stringify(e[f]);
    parts.push(`${f}=${v.length > 80 ? `${v.slice(0, 77)}…` : v}`);
  }
  return `${e.ts ?? ''} #${e.seq ?? '?'} ${e.pulseId ?? ''} ${e.type}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`;
}

/**
 * The ordered trail of one task.
 * @param {string} taskId
 * @param {object[]} events All events, in file order.
 * @returns {{ taskId: string, count: number, lines: string[], events: object[] }}
 */
export function replayTask(taskId, events) {
  const own = events.filter((e) => e.taskId === taskId).sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? '') || (a.seq ?? 0) - (b.seq ?? 0));
  return { taskId, count: own.length, lines: own.map(summarizeEvent), events: own };
}

/**
 * @param {{ task: object|null, checkpoint?: object|null, events?: object[], control?: object|null, now?: () => Date }} args
 * @returns {{ found: boolean, status: string|null, headline: string, waitingOn: string|null, unblock: string|null, facts: string[], lastEvents: string[] }}
 */
export function explainTask(args) {
  const now = args.now ?? (() => new Date());
  const { task, checkpoint: cp = null, control = null } = args;
  const events = args.events ?? [];
  if (!task) return { found: false, status: null, headline: 'no such task', waitingOn: null, unblock: null, facts: [], lastEvents: [] };
  const facts = [];
  const own = replayTask(task.id, events);
  facts.push(`status ${task.status}${task.waitReason ? ` (${task.waitReason})` : ''}, priority ${task.priority ?? 'normal'}, attempts ${task.attempts ?? 0}/${task.maxAttempts ?? '?'}, parks ${task.parks ?? 0}`);
  if (task.usage) facts.push(`usage: ${task.usage.calls ?? 0} model calls, ${task.usage.tokens ?? 0} tokens, ${Math.round((task.usage.wallMs ?? 0) / 1000)} s active`);
  if (task.dependsOn?.length) facts.push(`depends on ${task.dependsOn.join(', ')}`);
  if (task.deadline) facts.push(`deadline ${task.deadline}`);
  if (task.expiresAt) facts.push(`expires ${task.expiresAt}`);
  if (task.failure) facts.push(`last failure: ${task.failure.class}${task.failure.code ? `/${task.failure.code}` : ''} — ${task.failure.message ?? ''}`.trim());
  if (task.error) facts.push(`error: ${task.error}`);
  if (cp) {
    const steps = Object.entries(cp.subtasks ?? {});
    facts.push(`checkpoint: phase ${cp.phase}, run ${cp.runId}, ${steps.filter(([, s]) => s.state === 'complete').length}/${steps.length || (cp.graph?.tasks?.length ?? 0)} steps complete, ${cp.remediations ?? 0} remediation(s)${cp.verification ? `, verification ${cp.verification.verdict}${cp.verification.unjudged ? ' (unjudged)' : ''}` : ''}`);
    if (cp.gate) facts.push(`gate: ${cp.gate.verdict} (${cp.gate.classification}, layer ${cp.gate.layer})`);
  }
  if (control) facts.push(`control: autonomy ${control.autonomy}${control.killSwitch ? ', KILL SWITCH ON' : ''}${control.drain ? ', draining' : ''}${control.safeMode ? ', safe mode' : ''}`);
  const approvals = Object.entries(task.approvals ?? {});
  if (approvals.length > 0) facts.push(`approvals: ${approvals.map(([k, v]) => `${k}=${v.decision} by ${v.by ?? '?'}`).join('; ')}`);
  const history = (task.history ?? []).slice(-6).map((h) => `${h.at} ${h.from ?? '·'}→${h.to}${h.reason ? ` (${h.reason})` : ''}`);
  if (history.length > 0) facts.push(`recent transitions:\n  ${history.join('\n  ')}`);

  let waitingOn = null;
  let unblock = null;
  let headline;
  switch (task.status) {
    case 'waiting': {
      const wake = task.wakeAt ? Math.round((Date.parse(task.wakeAt) - now().getTime()) / 60_000) : null;
      if (task.waitReason === 'approval') {
        const key = own.events.filter((e) => e.type === 'run.parked' && e.approvalKey).at(-1)?.approvalKey ?? own.events.filter((e) => e.type === 'policy.decision' && e.outcome === 'approve').at(-1)?.approvalKey ?? null;
        waitingOn = `an authorized user's approval${key ? ` of ${key}` : ''}`;
        unblock = key ? `comment "/titan approve ${key}" (or "/titan deny ${key}") on the issue` : 'comment "/titan approve all" on the issue';
      } else if (task.waitReason === 'dependency') {
        waitingOn = `dependencies ${(task.dependsOn ?? []).join(', ')} to complete`;
        unblock = 'nothing to do; it runs when they finish (or dead-letters if one fails)';
      } else if (task.waitReason === 'provider' || task.waitReason === 'quota') {
        waitingOn = `the provider side (${task.waitReason}); wakes ${task.wakeAt}${wake != null ? ` (in ${wake} min)` : ''}, park ${task.parks ?? 0} of the ladder ${PARK_BACKOFF_MS.map((ms) => `${ms / 60_000}m`).join('/')}`;
        unblock = 'nothing to do unless a key is bad; "/titan retry" after it dead-letters';
      } else {
        waitingOn = `${task.waitReason}; wakes ${task.wakeAt}`;
        unblock = 'the next pulse after the wake time';
      }
      headline = `waiting on ${waitingOn}`;
      break;
    }
    case 'paused':
      waitingOn = 'a resume command';
      unblock = 'comment "/titan resume" on the issue or dispatch the control workflow';
      headline = 'paused by a human';
      break;
    case 'running':
      waitingOn = `the pulse holding its lease (${task.lease?.owner ?? 'unknown'}, expires ${task.lease?.expiresAt ?? '?'})`;
      unblock = 'nothing; if the lease expires without progress the next pulse reclaims it';
      headline = 'running';
      break;
    case 'pending':
      waitingOn = control?.killSwitch ? 'the kill switch to be turned off' : control?.drain ? 'drain to be turned off' : 'the next pulse with capacity';
      unblock = control?.killSwitch || control?.drain ? 'dispatch the control workflow' : 'nothing';
      headline = 'queued';
      break;
    case 'dead-lettered':
      headline = `dead-lettered: ${task.failure?.code ?? task.error ?? 'unknown'}`;
      unblock = 'fix the cause, then "/titan retry" on the issue';
      break;
    case 'failed':
    case 'blocked':
    case 'expired':
    case 'cancelled':
      headline = `${task.status}: ${task.error ?? task.failure?.message ?? ''}`.trim();
      unblock = task.status === 'blocked' ? 'the reviewer gate refused it; rephrase the task' : '"/titan retry" on the issue';
      break;
    default:
      headline = task.status;
  }
  return { found: true, status: task.status, headline, waitingOn, unblock, facts, lastEvents: own.lines.slice(-12) };
}

export default { explainTask, replayTask, summarizeEvent };
