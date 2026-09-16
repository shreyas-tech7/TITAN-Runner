/**
 * @file The hard leash on self-improvement (task instructions, section F).
 *
 * The agent may propose changes to its own code as a pull request, never a
 * direct push to main. These paths are additionally off-limits to that PR
 * flow entirely — a self-authored PR that touches any of them is rejected
 * before it is even opened (`src/selfImprove.js`) and, as a second,
 * independent backstop, `scripts/check-denylist.mjs` fails CI on any PR
 * (self-authored or not) whose diff touches one of these paths without a
 * human's own commit in the history of that branch.
 *
 * This list is itself denylisted: the agent may never modify this file,
 * `.github/workflows/`, the reviewer gate, or the secret-handling code.
 */
export const DENYLIST = Object.freeze([
  '.github/workflows/',
  'src/denylist.js',
  'src/reviewer/',
  'src/lib/redact.js',
  'src/lib/secretScrub.js',
  'scripts/check-denylist.mjs',
  'scripts/check-secrets-in-state.mjs',
  // The always-on sub-agent cluster (build brief: "always-on sub-agent
  // cluster"): worker/ holds the admin-token auth check and the sealed-box
  // key-encryption flow, and run-subagent-task.mjs is what actually calls
  // the Reviewer Gate before ever reaching a provider. Neither is covered
  // by the entries above, and either one would be a quiet way to weaken
  // this repo's safety net without ever touching src/reviewer/ itself.
  'worker/',
  'scripts/run-subagent-task.mjs',
]);

/**
 * @param {string} filePath Repo-relative path, forward-slash separated.
 * @returns {boolean}
 */
export function isDenylisted(filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return DENYLIST.some((entry) =>
    entry.endsWith('/') ? normalized.startsWith(entry) : normalized === entry,
  );
}

/**
 * @param {string[]} changedFiles Repo-relative paths.
 * @returns {string[]} The subset that hit the denylist.
 */
export function findDenylistViolations(changedFiles) {
  return changedFiles.filter(isDenylisted);
}

export default { DENYLIST, isDenylisted, findDenylistViolations };
