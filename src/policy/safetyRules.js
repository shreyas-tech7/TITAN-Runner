/**
 * @file The safety rules engine's pure half: classify an action, read
 * `config/safety-rules.yml`, and say whether the rules require a human
 * first. `policy/engine.js#decide()` calls `evaluateRules()` for every
 * action; the autonomy dial still applies on top, so the rules can only
 * make an action stricter than the dial would, never looser.
 *
 * Two layers, on purpose:
 *   - CLASSIFICATION is code (`classifyAction`). What an action *is* cannot
 *     be edited by a config change.
 *   - POLICY per category is data (`config/safety-rules.yml`), tunable from
 *     the history in `state/approval-log.jsonl`.
 * Underneath both sits a HARD FLOOR (`HARD_ASK`): a git commit, a deletion,
 * a credential change or a state mutation always asks, whatever the file
 * says, and a missing or malformed file falls back to built-in rules that
 * are identical to the shipped file (a test keeps them from drifting).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseYamlSubset } from '../lib/miniYaml.js';

/**
 * @typedef {object} SafetyRules
 * @property {number} version
 * @property {'ask'|'auto'} default
 * @property {readonly string[]} autoApprove
 * @property {readonly string[]} alwaysAsk
 * @property {string} source Where these rules came from (shown on the dashboard).
 * @property {readonly string[]} warnings Problems found while loading them.
 */

export const ACTION_CATEGORIES = Object.freeze([
  'read',
  'scratch-write',
  'external-fetch',
  'external-effect',
  'issue-comment',
  'state-append',
  'git-commit',
  'file-delete',
  'credential-change',
  'state-mutation',
]);

/** Categories that always need a human, regardless of `config/safety-rules.yml`. */
export const HARD_ASK = Object.freeze(['git-commit', 'file-delete', 'credential-change', 'state-mutation']);

/** The rules the engine falls back to; kept identical to `config/safety-rules.yml`. */
export const DEFAULT_SAFETY_RULES = Object.freeze({
  version: 1,
  default: 'ask',
  autoApprove: Object.freeze(['read', 'scratch-write', 'external-fetch', 'external-effect', 'issue-comment', 'state-append']),
  alwaysAsk: Object.freeze(['git-commit', 'file-delete', 'credential-change', 'state-mutation']),
  source: 'built-in',
  warnings: Object.freeze([]),
});

export const DEFAULT_RULES_PATH = fileURLToPath(new URL('../../config/safety-rules.yml', import.meta.url));

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

/** The five built-in tools (src/tools/builtin.js). */
const BUILTIN_TOOL_CATEGORY = Object.freeze({
  repo_read_file: 'read',
  repo_list_files: 'read',
  repo_search: 'read',
  workspace_write: 'scratch-write',
  http_fetch: 'external-fetch',
});

const PATH_ARG_KEYS = ['path', 'file', 'filePath', 'filename', 'target', 'dest', 'destination', 'from', 'to'];

// Tool-id words. Matched against the id split on non-letters, so `repo_search`
// never matches `rm` and `pr_comment` is judged on its own words.
const WORD_GROUPS = [
  ['credential-change', ['secret', 'secrets', 'credential', 'credentials', 'password', 'passwd', 'token', 'apikey', 'keychain', 'keypair', 'gpg', 'ssh']],
  ['file-delete', ['delete', 'remove', 'rm', 'rmdir', 'unlink', 'purge', 'wipe', 'truncate', 'shred', 'erase']],
  ['git-commit', ['git', 'commit', 'push', 'merge', 'rebase', 'cherrypick']],
];
const CREDENTIAL_PHRASES = [/api[-_ ]?key/i, /private[-_ ]?key/i, /cherry[-_ ]?pick/i];

const CREDENTIAL_PATH = /(^|\/)(\.env(\.|$)|\.npmrc$|\.netrc$|id_(rsa|ed25519|ecdsa)|[^/]*\.(pem|key|p12|pfx)$|[^/]*(secret|credential|password|token)s?[^/]*$)/i;

/** @param {unknown} v */
function pathArgs(v) {
  if (!v || typeof v !== 'object') return [];
  const out = [];
  for (const k of PATH_ARG_KEYS) {
    const x = /** @type {Record<string, unknown>} */ (v)[k];
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) for (const y of x.slice(0, 20)) if (typeof y === 'string') out.push(y);
  }
  return out.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));
}

/** @param {string} toolId */
function idWords(toolId) {
  const spaced = String(toolId).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return { words: new Set(spaced.split(/[^a-z]+/).filter(Boolean)), spaced };
}

/**
 * The one category an action belongs to. A read is always `read`; a
 * self-improvement (branch, commit, push, draft PR) is always `git-commit`;
 * otherwise the built-in tool table decides, then the strictest hard-ask
 * category any signal (tool-id words, path arguments) points at, and finally
 * the action's declared effect. Nothing the caller passes can loosen this.
 *
 * @param {{ kind?: string, toolId?: string, effect?: string, args?: object }} action
 * @returns {string} One of ACTION_CATEGORIES.
 */
export function classifyAction(action) {
  const kind = action?.kind ?? 'tool';
  if (kind === 'self-improve') return 'git-commit';
  if (kind === 'deliver') return 'issue-comment';
  if (action?.effect === 'read') return 'read';

  const toolId = String(action?.toolId ?? '');
  // The built-in tools are audited code whose arguments are jailed
  // (`workspace_write`'s path is relative to its own scratch directory), so
  // they use the fixed table. The heuristics below are for tools added later.
  if (Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_CATEGORY, toolId)) return BUILTIN_TOOL_CATEGORY[toolId];
  const { words, spaced } = idWords(toolId);
  const paths = pathArgs(action?.args);
  const hits = new Set();

  for (const [category, list] of WORD_GROUPS) {
    if (list.some((w) => words.has(w))) hits.add(category);
  }
  if (CREDENTIAL_PHRASES[0].test(spaced) || CREDENTIAL_PHRASES[1].test(spaced)) hits.add('credential-change');
  if (CREDENTIAL_PHRASES[2].test(spaced)) hits.add('git-commit');

  let touchesState = false;
  for (const p of paths) {
    if (CREDENTIAL_PATH.test(p)) hits.add('credential-change');
    if (p === '.git' || p.startsWith('.git/')) hits.add('git-commit');
    if (p === 'state' || p.startsWith('state/')) touchesState = true;
  }
  if (touchesState) {
    const appends = words.has('append') || action?.args?.mode === 'append' || action?.args?.append === true;
    if (!appends) hits.add('state-mutation');
  }

  // Strictest hard-ask first.
  for (const category of ['credential-change', 'file-delete', 'git-commit', 'state-mutation']) {
    if (hits.has(category)) return category;
  }
  if (touchesState) return 'state-append';

  if (action?.effect === 'local_write') return 'scratch-write';
  return 'external-effect';
}

/**
 * Best-effort category for an approval key from a `/titan approve <key>`
 * comment (`tool:<id>:<hash>`, `deliver:<run>`, `self-improve:<run>`, `all`).
 * Only used to label log entries.
 * @param {string} key
 */
export function categoryForApprovalKey(key) {
  const k = String(key ?? '');
  if (k === 'all') return 'all';
  if (k.startsWith('self-improve:')) return 'git-commit';
  if (k.startsWith('deliver:')) return 'issue-comment';
  const m = k.match(/^tool:([^:]+):/);
  if (m) return classifyAction({ kind: 'tool', toolId: m[1], effect: 'external' });
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} text Contents of a safety-rules.yml.
 * @returns {{ version: number, default: 'ask'|'auto', autoApprove: string[], alwaysAsk: string[], source: string, warnings: string[] }}
 * @throws {Error} When the file is not valid or not version 1.
 */
export function parseSafetyRules(text) {
  const doc = parseYamlSubset(text);
  if (doc.version !== 1) throw new Error(`unsupported or missing "version" (expected 1, got ${JSON.stringify(doc.version)})`);
  const def = doc.default ?? 'ask';
  if (def !== 'ask' && def !== 'auto') throw new Error(`"default" must be "ask" or "auto", got ${JSON.stringify(def)}`);
  const asList = (name) => {
    const v = doc[name];
    if (v == null) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`"${name}" must be a list of category names`);
    return v;
  };
  const autoApprove = asList('auto_approve');
  const alwaysAsk = asList('always_ask');
  const warnings = [];
  for (const name of [...autoApprove, ...alwaysAsk]) {
    if (!ACTION_CATEGORIES.includes(name)) warnings.push(`unknown category "${name}" is ignored`);
  }
  for (const name of autoApprove) {
    if (HARD_ASK.includes(name)) warnings.push(`"${name}" is under auto_approve but is hard-ask: it still needs approval`);
    if (alwaysAsk.includes(name)) warnings.push(`"${name}" is in both lists: always_ask wins`);
  }
  return { version: 1, default: def, autoApprove, alwaysAsk, source: 'config', warnings };
}

/**
 * Read the rules from disk. Never throws: a missing file gives the built-in
 * rules quietly; an unreadable or invalid one gives the built-in rules plus
 * a warning the engine records, so a bad edit can never weaken the floor.
 * @param {{ path?: string, readFile?: (p: string) => string }} [opts]
 */
export function loadSafetyRules(opts = {}) {
  const path = opts.path ?? DEFAULT_RULES_PATH;
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let text;
  try {
    text = readFile(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ...DEFAULT_SAFETY_RULES, source: 'built-in (no config/safety-rules.yml)', warnings: [] };
    return { ...DEFAULT_SAFETY_RULES, source: 'built-in', warnings: [`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  try {
    return { ...parseSafetyRules(text), source: path.replace(/^.*[\\/]config[\\/]/, 'config/') };
  } catch (err) {
    return { ...DEFAULT_SAFETY_RULES, source: 'built-in', warnings: [`config/safety-rules.yml ignored: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/**
 * @param {Parameters<typeof classifyAction>[0]} action
 * @param {SafetyRules} [rules]
 * @returns {{ ask: boolean, hard: boolean, category: string, rule: 'hard-floor'|'always_ask'|'auto_approve'|'default', reason: string }}
 */
export function evaluateRules(action, rules = DEFAULT_SAFETY_RULES) {
  const category = classifyAction(action);
  if (HARD_ASK.includes(category)) {
    return { ask: true, hard: true, category, rule: 'hard-floor', reason: `${category} always needs approval` };
  }
  if (rules.alwaysAsk.includes(category)) {
    return { ask: true, hard: false, category, rule: 'always_ask', reason: `${category} is on the always-ask list` };
  }
  if (rules.autoApprove.includes(category)) {
    return { ask: false, hard: false, category, rule: 'auto_approve', reason: `${category} is auto-approved` };
  }
  const ask = rules.default !== 'auto';
  return { ask, hard: false, category, rule: 'default', reason: ask ? `${category} is not on the auto-approve list` : `${category} allowed by default` };
}

export default { classifyAction, categoryForApprovalKey, evaluateRules, loadSafetyRules, parseSafetyRules, ACTION_CATEGORIES, HARD_ASK, DEFAULT_SAFETY_RULES };
