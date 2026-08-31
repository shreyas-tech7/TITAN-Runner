/**
 * @file Reviewer Gate — Layer 1, deterministic policy.
 *
 * Pure and synchronous: no network, no filesystem, no clock. Classifies a
 * proposed action into `safe` / `caution` / `destructive` before any model
 * is ever consulted, so the common case (a `read` tool, a low-risk lookup)
 * never pays for a network round trip.
 *
 * `destructive` is earned only by matching one of the explicit patterns
 * below — a tool's own declared risk metadata (`riskLevel`/`effect`) can
 * only ever produce `safe` or `caution` on its own. This keeps "destructive"
 * meaning something specific and grep-able rather than "whatever the
 * catalog happened to mark high-risk this week".
 */

/**
 * @typedef {'safe'|'caution'|'destructive'} Classification
 */

/**
 * @typedef {object} ProposedAction
 * @property {string} toolId
 * @property {Record<string, unknown>} [args]
 * @property {'low'|'medium'|'high'} [riskLevel] From the orchestrator's tool catalog.
 * @property {'read'|'local_write'|'external'} [effect] From the assistant's tool registry.
 * @property {string} [description] Free-text description of the action, when
 *   the caller has one beyond a tool id + args (e.g. a job's own summary).
 */

/**
 * @typedef {object} DestructiveRule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} reason Human-readable, fed to the model prompt and
 *   surfaced directly if Layer 2 never runs or never returns.
 */

/** @type {DestructiveRule[]} */
const DESTRUCTIVE_RULES = [
  {
    id: 'recursive-delete',
    pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|--recursive\s+--force|--force\s+--recursive)\b|\brmdir\s+\/s\b|Remove-Item[^\n]*-Recurse[^\n]*-Force|Remove-Item[^\n]*-Force[^\n]*-Recurse|"op"\s*:\s*"delete"[^}]*"recursive"\s*:\s*true/i,
    reason: 'looks like a recursive, forced delete',
  },
  {
    id: 'force-push',
    pattern: /\bgit\s+push\b[^\n]*(--force(?!-with-lease\s+--force-if-includes)|--force-with-lease|\s-f\b)/i,
    reason: 'looks like a force push, which can overwrite remote history',
  },
  {
    id: 'history-rewrite',
    pattern: /\bgit\s+(rebase|filter-branch|reflog\s+expire)\b|\bgit\s+reset\s+--hard\b/i,
    reason: 'looks like a git history rewrite (rebase, filter-branch, or a hard reset)',
  },
  {
    id: 'env-or-credential-file',
    pattern: /(^|[\\/"'\s])\.env(\.[A-Za-z0-9_.-]*)?($|["'\s\\/])|credentials\.json|token\.json|id_rsa\b|\.pem["'\s]|\.pfx["'\s]|\bsecrets?\.ya?ml\b/i,
    reason: 'touches a `.env*` file or a credential file',
  },
  {
    id: 'db-drop-or-truncate',
    pattern: /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
    reason: 'looks like it drops or truncates a database table',
  },
  {
    id: 'mass-rename',
    pattern: /\*[^\n]{0,40}\b(rename|move|mv)\b|\b(rename|bulk[- ]rename)\b[^\n]{0,40}\*/i,
    reason: 'looks like a wildcard-driven mass rename/move',
  },
  {
    id: 'kill-service',
    pattern: /\btaskkill\b|\bkill\s+-9\b|Stop-Process\b|Stop-Service\b|Stop-ScheduledTask[^\n]*TITAN/i,
    reason: 'looks like it kills a running process or service',
  },
  {
    id: 'unbounded-root-glob',
    // Matched against a JSON-stringified args blob (see `toSearchText`),
    // where every real backslash is doubled and every real terminator is a
    // `"` closing the JSON string value, not raw end-of-input — `\\+` and a
    // `"`-inclusive terminator class account for both, rather than assuming
    // exactly one backslash and a bare end-of-string the way a match
    // against a raw shell string alone would.
    pattern: /\brm\s+-\w*[rf]\w*\s+\/(\s|\*|"|$)|\bdel\s+\/s\s+\/q\s+[A-Za-z]:\\*("|\s|$)|[A-Za-z]:\\+\*\*?("|\s|$)|(^|[\s"'])\/\*\*?("|\s|$)/i,
    reason: 'looks like an unbounded glob expansion at a filesystem root',
  },
  {
    id: 'write-outside-repo-root',
    // A path argument that is absolute (drive letter or leading slash) or
    // escapes via `..` more than once — a single `../foo` inside a vault
    // move is common and already denied by vaultFs.js itself; this rule is
    // a coarse backstop for tools that don't do their own containment check.
    pattern: /"(?:path|to|dest(?:ination)?|target)"\s*:\s*"(?:[A-Za-z]:[\\/]|\/(?!.*vault)|(?:\.\.[\\/]){2,})/i,
    reason: 'looks like it writes outside the repo/vault root',
  },
];

/**
 * @param {ProposedAction} action
 * @returns {string} A single searchable blob — tool id, description, and a
 *   JSON rendering of the arguments. Rules match against this rather than
 *   inspecting each field individually, so a pattern that could show up in
 *   any argument (a `.env` path buried three keys deep, say) is still caught.
 */
function toSearchText(action) {
  const parts = [action.toolId ?? '', action.description ?? ''];
  try {
    parts.push(JSON.stringify(action.args ?? {}));
  } catch {
    parts.push(String(action.args));
  }
  return parts.join('\n');
}

/**
 * @param {'low'|'medium'|'high'|undefined} riskLevel
 * @param {'read'|'local_write'|'external'|undefined} effect
 * @returns {Classification} `safe` or `caution` only — never `destructive`;
 *   that tier is earned exclusively by a pattern match.
 */
function baselineFromMetadata(riskLevel, effect) {
  if (riskLevel === 'low' || effect === 'read') return 'safe';
  if (riskLevel === 'medium' || riskLevel === 'high' || effect === 'local_write' || effect === 'external') {
    return 'caution';
  }
  // No metadata at all: default to the safer choice — don't let an action
  // skip review just because the caller forgot to declare a risk tier.
  return 'caution';
}

/**
 * @param {ProposedAction} action
 * @returns {{ classification: Classification, matchedRules: string[], reasons: string[] }}
 */
export function classifyAction(action) {
  const text = toSearchText(action);
  const matched = DESTRUCTIVE_RULES.filter((rule) => rule.pattern.test(text));

  if (matched.length > 0) {
    return {
      classification: 'destructive',
      matchedRules: matched.map((r) => r.id),
      reasons: matched.map((r) => r.reason),
    };
  }

  const classification = baselineFromMetadata(action.riskLevel, action.effect);
  return { classification, matchedRules: [], reasons: [] };
}

export default { classifyAction };
