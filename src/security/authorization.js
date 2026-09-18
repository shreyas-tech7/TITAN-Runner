/**
 * @file Who may hand Runner work, and who may steer it.
 *
 * This repository is public. Anyone on GitHub can open an issue through the
 * task template (which applies the `titan-task` label for them) and anyone
 * can comment on any issue. A label is not authorization and neither is a
 * comment. The pulse therefore treats every issue and every comment as
 * attacker-controlled input and acts only when GitHub itself vouches for the
 * author:
 *
 *   - `author_association` is computed by GitHub for every issue/comment
 *     payload and cannot be forged by the author: OWNER, MEMBER (org member),
 *     and COLLABORATOR (explicit write access) are trusted; CONTRIBUTOR
 *     ("has a merged PR"), FIRST_TIMER, NONE, and anything unknown are not.
 *   - An explicit login allowlist (`TITAN_TASK_AUTHORS`, comma separated)
 *     lets a maintainer name additional accounts (or restrict to exactly one)
 *     without touching code. The repository owner (from `GITHUB_REPOSITORY`)
 *     is always allowed.
 *
 * Everything unauthorized is ignored at zero model calls and zero comments —
 * replying to a stranger's issue would turn the bot into a spam amplifier.
 *
 * Pure: no I/O, no clock. Callers pass the actor and the context.
 */

/** GitHub's `author_association` values Runner trusts. Frozen so a task or a
 *  model response can never append to it at runtime. */
export const TRUSTED_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Bot accounts that Runner must never treat as a human principal, even if a
 *  maintainer lists them by mistake. `github-actions[bot]` is the pulse's own
 *  identity; trusting it would let the bot authorize itself. */
const NEVER_TRUSTED_LOGINS = Object.freeze(['github-actions[bot]', 'dependabot[bot]']);

/**
 * @param {string|undefined|null} raw Comma/space separated logins.
 * @returns {string[]} Lower-cased, de-duplicated, without empties.
 */
export function parseLoginList(raw) {
  if (typeof raw !== 'string') return [];
  const out = new Set();
  for (const part of raw.split(/[,\s]+/)) {
    const login = part.trim().toLowerCase().replace(/^@/, '');
    if (login.length > 0) out.add(login);
  }
  return [...out];
}

/**
 * @typedef {object} AuthorizationContext
 * @property {string[]} allowlist Lower-cased logins that are always trusted.
 * @property {string|null} repoOwner Lower-cased owner of `GITHUB_REPOSITORY`.
 * @property {boolean} trustAssociations Whether OWNER/MEMBER/COLLABORATOR
 *   associations count on their own. `false` means the allowlist is the only
 *   source of truth.
 */

/**
 * @typedef {object} Actor
 * @property {{ login?: string, type?: string } | null | undefined} [user]
 * @property {string | null | undefined} [author_association]
 */

/**
 * @param {Actor} actor An issue or comment payload as GitHub returns it.
 * @param {AuthorizationContext} ctx
 * @returns {{ ok: boolean, reason: string, login: string|null }}
 */
export function authorizeActor(actor, ctx) {
  const rawLogin = actor?.user?.login;
  const login = typeof rawLogin === 'string' && rawLogin.length > 0 ? rawLogin.toLowerCase() : null;
  if (!login) return { ok: false, reason: 'no author login on the payload', login: null };
  if (NEVER_TRUSTED_LOGINS.includes(login) || actor?.user?.type === 'Bot') {
    return { ok: false, reason: `"${login}" is a bot account`, login };
  }
  if (ctx.repoOwner && login === ctx.repoOwner) return { ok: true, reason: 'repository owner', login };
  if (ctx.allowlist.includes(login)) return { ok: true, reason: 'login allowlist (TITAN_TASK_AUTHORS)', login };
  const association = typeof actor?.author_association === 'string' ? actor.author_association.toUpperCase() : '';
  if (ctx.trustAssociations && TRUSTED_ASSOCIATIONS.includes(association)) {
    return { ok: true, reason: `author_association ${association}`, login };
  }
  return { ok: false, reason: `"${login}" is not the owner, not allowlisted, and association is "${association || 'NONE'}"`, login };
}

/**
 * Build the context from environment-derived config. Kept as a function of
 * its inputs (not of `process.env` directly) so tests and the harness can
 * pass any context they like.
 * @param {{ taskAuthors?: string[], repository?: string, trustCollaborators?: boolean }} cfg
 * @returns {AuthorizationContext}
 */
export function authorizationContextFrom(cfg) {
  const owner = typeof cfg.repository === 'string' && cfg.repository.includes('/')
    ? cfg.repository.split('/')[0].toLowerCase()
    : null;
  return {
    allowlist: (cfg.taskAuthors ?? []).map((l) => String(l).toLowerCase()),
    repoOwner: owner,
    trustAssociations: cfg.trustCollaborators !== false,
  };
}

export default { authorizeActor, authorizationContextFrom, parseLoginList, TRUSTED_ASSOCIATIONS };
