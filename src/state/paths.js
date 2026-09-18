/**
 * @file The one place the state directory is resolved.
 *
 * Every state file used to be computed at import time from `process.cwd()`
 * (or, for the capability cache, from the module's own location), which
 * meant the pulse could only ever run against the checkout's real `state/`.
 * The harness, the simulator, and the tests need to point the whole engine
 * at a scratch directory instead, so the directory is now resolved here:
 * an explicit argument, else `TITAN_STATE_DIR`, else `<cwd>/state` — the
 * last being exactly the previous behaviour, so a plain `node src/pulse.js`
 * is unchanged.
 */
import { join, resolve } from 'node:path';

/**
 * @param {string} [explicit]
 * @returns {string} Absolute state directory.
 */
export function resolveStateDir(explicit) {
  const raw = explicit || process.env.TITAN_STATE_DIR || join(process.cwd(), 'state');
  return resolve(raw);
}

/**
 * @typedef {object} StatePaths
 * @property {string} stateDir
 * @property {string} tasks
 * @property {string} agents
 * @property {string} heartbeat
 * @property {string} pulseHistory
 * @property {string} providers
 * @property {string} runs
 * @property {string} digests
 * @property {string} reviews
 */

/**
 * @param {string} [stateDir]
 * @returns {StatePaths}
 */
export function statePaths(stateDir = resolveStateDir()) {
  return Object.freeze({
    stateDir,
    tasks: join(stateDir, 'tasks.json'),
    agents: join(stateDir, 'agents.json'),
    heartbeat: join(stateDir, 'heartbeat.json'),
    pulseHistory: join(stateDir, 'pulse-history.json'),
    providers: join(stateDir, 'providers.json'),
    runs: join(stateDir, 'runs'),
    digests: join(stateDir, 'digests'),
    reviews: join(stateDir, 'reviews'),
  });
}

/** Resolved once at import for the module-level defaults the rest of the
 *  codebase already keys off (`STATE_DIR`, `TASKS_PATH`, …). */
export const DEFAULT_PATHS = statePaths();

export default { resolveStateDir, statePaths, DEFAULT_PATHS };
