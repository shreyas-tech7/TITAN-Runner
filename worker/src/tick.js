/**
 * @file The 1-minute tick. Each step is independent: one that fails is logged and the next one still runs.
 * The free plan allows 50 D1 queries and 50 subrequests in one invocation, so each step keeps its work small.
 */
import { authenticateInternal, tickCallbackToken } from './callback.js';
import { ensureMigrations } from './lib/migrate.js';
import { tickKeeper } from './keeper.js';
import { dispatchQueuedVms, expireStaleVms } from './legacy.js';
import { dispatchQueuedTasks, mirrorGithubIssues, reapStuckTasks } from './tasks.js';
import { runMetaAgent } from './meta-agent.js';
import { pruneOldRows } from './retention.js';

export { authenticateInternal };

/** @param {Record<string, any>} env @param {Date} [now] */
export async function runTick(env, now = new Date()) {
  const report = {};
  try {
    await ensureMigrations(env);
  } catch (err) {
    console.error('titan-runner-brain: migrations failed:', err instanceof Error ? err.message : err);
    return { error: 'migrations_failed' };
  }
  const steps = [
    ['callback', () => tickCallbackToken(env, now)],
    ['keeper', () => tickKeeper(env, now)],
    ['reaper', () => reapStuckTasks(env, now)],
    ['mirror', () => mirrorGithubIssues(env)],
    ['dispatch', () => dispatchQueuedTasks(env)],
    ['vms', () => dispatchQueuedVms(env)],
    ['expireVms', () => expireStaleVms(env)],
  ];
  for (const [name, run] of steps) {
    try {
      report[name] = await run();
    } catch (err) {
      report[name] = { error: err instanceof Error ? err.message : 'error' };
      console.error(`titan-runner-brain: tick step "${name}" failed:`, report[name].error);
    }
  }
  return report;
}

/** The 6-hour cron: the meta-agent and the retention rules. */
export async function runSixHourly(env, now = new Date()) {
  const report = {};
  try {
    await ensureMigrations(env);
    report.retention = await pruneOldRows(env, now);
  } catch (err) {
    report.retention = { error: err instanceof Error ? err.message : 'error' };
  }
  try {
    await runMetaAgent(env);
    report.metaAgent = 'ran';
  } catch (err) {
    report.metaAgent = { error: err instanceof Error ? err.message : 'error' };
  }
  return report;
}
