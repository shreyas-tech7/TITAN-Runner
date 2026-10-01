/**
 * @file The policy engine: one pure decision for every side effect the
 * engine is about to cause — a tool call, a delivery (comment, close, PR),
 * a self-improvement — given the repo's control file and the task's own
 * settings. It sits *beside* the Reviewer Gate, never instead of it: the
 * gate decides whether a task is safe to run at all; this decides, per
 * effect, whether the current autonomy level lets it happen now, needs a
 * human first, or forbids it.
 *
 * Autonomy levels, least to most permissive:
 *   dry-run     nothing leaves the process: reads only, no local writes, no
 *               comments, no PRs (the run record is still written)
 *   propose     local writes happen; every external effect waits for
 *               `/titan approve <key>` from an authorized user
 *   approval    every non-read effect waits for approval
 *   autonomous  everything the gate allowed happens (the default)
 *
 * The effective level is the stricter of `control.autonomy` (repo-wide, set
 * by the operator) and `task.autonomy` (per task, from the issue YAML). Safe
 * mode (`control.safeMode`) forbids external effects at any level. A denial
 * from an authorized user (`/titan deny <key>`) forbids that effect for good.
 *
 * Beneath the dial sit the safety rules (`config/safety-rules.yml`, see
 * `safetyRules.js`): every action is classified into a category, and a
 * category that is not auto-approved — always a git commit, a deletion, a
 * credential change or a state mutation — needs `/titan approve <key>` at
 * EVERY autonomy level. The rules can only make an action stricter than the
 * dial would; `approve all` does not cover the hard-ask categories.
 *
 * Every decision is data (`{decision, reason, approvalKey, category, rule}`)
 * so the engine can audit it; the engine appends it as a `policy.decision`
 * event.
 */
import { createHash } from 'node:crypto';
import { evaluateRules, DEFAULT_SAFETY_RULES } from './safetyRules.js';

export const AUTONOMY_LEVELS = Object.freeze(['dry-run', 'propose', 'approval', 'autonomous']);
export const EFFECTS = Object.freeze(['read', 'local_write', 'external']);

/** @param {string|null|undefined} level */
function rank(level) {
  const i = AUTONOMY_LEVELS.indexOf(level);
  return i === -1 ? AUTONOMY_LEVELS.length - 1 : i;
}

/**
 * The stricter of the repo-wide level and the task's own.
 * @param {{ autonomy?: string|null }} control
 * @param {{ autonomy?: string|null }} [task]
 */
export function effectiveAutonomy(control, task = {}) {
  const c = AUTONOMY_LEVELS.includes(control?.autonomy) ? control.autonomy : 'autonomous';
  const t = AUTONOMY_LEVELS.includes(task?.autonomy) ? task.autonomy : 'autonomous';
  return rank(t) < rank(c) ? t : c;
}

/** A short, stable key an approver can name: `tool:<id>:<8 hex of args>` or `deliver:<runId>`. */
export function approvalKeyFor(action) {
  if (action.kind === 'tool') {
    const digest = createHash('sha1').update(JSON.stringify(action.args ?? {})).digest('hex').slice(0, 8);
    return `tool:${action.toolId}:${digest}`;
  }
  if (action.kind === 'deliver') return `deliver:${action.runId ?? 'run'}`;
  if (action.kind === 'self-improve') return `self-improve:${action.runId ?? 'run'}`;
  return `${action.kind}:${action.toolId ?? 'action'}`;
}

/**
 * @param {{
 *   action: { kind: 'tool'|'deliver'|'self-improve', toolId?: string, effect: 'read'|'local_write'|'external', runId?: string, args?: object },
 *   control: { killSwitch?: boolean, safeMode?: boolean, autonomy?: string },
 *   task?: { autonomy?: string|null, approvals?: Record<string, { decision: string, by?: string, at?: string }>|null },
 *   rules?: import('./safetyRules.js').SafetyRules,
 * }} input `rules` defaults to the built-in rules (identical to the shipped
 *   `config/safety-rules.yml`); the engine passes the loaded file.
 * @returns {{ decision: 'allow'|'deny'|'approve', reason: string, approvalKey: string, autonomy: string, source: 'level'|'denial'|'approval'|'safe-mode'|'kill-switch'|'safety-rules', category: string, rule: string }}
 */
export function decide({ action, control, task = {}, rules = DEFAULT_SAFETY_RULES }) {
  const autonomy = effectiveAutonomy(control, task);
  const key = approvalKeyFor(action);
  const effect = EFFECTS.includes(action.effect) ? action.effect : 'external';
  const verdict = evaluateRules(action, rules);
  const out = (decision, reason, source) => ({ decision, reason, approvalKey: key, autonomy, source, category: verdict.category, rule: verdict.rule });

  if (control?.killSwitch) return out('deny', 'the kill switch is on', 'kill-switch');

  // A recorded human decision on this exact effect wins over every level.
  const exact = task?.approvals?.[key] ?? null;
  const recorded = exact ?? task?.approvals?.all ?? null;
  if (recorded?.decision === 'denied') return out('deny', `denied by ${recorded.by ?? 'an authorized user'}`, 'denial');

  if (effect === 'read') return out('allow', 'a read has no side effect', 'level');
  if (autonomy === 'dry-run') return out('deny', `autonomy is dry-run: no ${effect === 'external' ? 'external' : 'local'} side effects`, 'level');
  if (control?.safeMode && effect === 'external') return out('deny', 'safe mode is on: no external side effects', 'safe-mode');

  // A hard-ask category is only ever cleared by an approval naming its exact
  // key — `/titan approve all` was given before anyone knew what would be asked.
  const approval = verdict.hard ? exact : recorded;
  if (approval?.decision === 'approved') return out('allow', `approved by ${approval.by ?? 'an authorized user'}`, 'approval');

  if (verdict.ask) return out('approve', `safety rules: ${verdict.reason}; needs /titan approve ${key}`, 'safety-rules');

  if (autonomy === 'approval') return out('approve', `autonomy is approval: every ${effect.replace('_', ' ')} needs /titan approve ${key}`, 'level');
  if (autonomy === 'propose' && effect === 'external') return out('approve', `autonomy is propose: an external effect needs /titan approve ${key}`, 'level');
  return out('allow', `autonomy is ${autonomy}`, 'level');
}

export default { decide, effectiveAutonomy, approvalKeyFor, AUTONOMY_LEVELS, EFFECTS };
