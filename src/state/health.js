/**
 * @file `state/health.json` — task brief, Track B: "Every pulse writes
 * state/health.json with last run time, duration, outcome, and provider
 * status. The dashboard turns amber then red when the beacon goes stale."
 *
 * Additive alongside the existing `state/heartbeat.json` (see
 * docs/DECISIONS.md D-6) rather than a replacement — the dead-man's-switch
 * script and the dashboard's existing staleness banner already depend on
 * `heartbeat.json`'s exact shape, and renaming it out from under them for
 * no behavioral gain would violate the brief's own "everything is
 * additive" rule. This file is a superset aimed at the brief's literal
 * name and shape (per-provider status folded in directly), written from
 * the same inputs in the same step.
 */
import { join } from 'node:path';
import { STATE_DIR, writeJsonAtomic } from './io.js';

export const HEALTH_JSON_PATH = join(STATE_DIR, 'health.json');

/** Past this many minutes since the last successful pulse, the dashboard's
 *  beacon should read amber; past AMBER_AFTER_MINUTES * 2, red. Kept here
 *  (not just in dashboard code) so a script/test can assert on the exact
 *  thresholds the brief's "amber then red" language calls for. */
export const AMBER_AFTER_MINUTES = 20; // > the 15-minute cadence, so one slipped tick is not alarming
export const RED_AFTER_MINUTES = 45; // matches the existing dashboard staleness banner's own threshold

/**
 * @param {{
 *   lastPulseAt: string|null, lastPulseStatus: 'ok'|'error'|null, lastPulseDurationMs: number|null,
 *   consecutivePulseFailures: number, totalPulses: number,
 *   providers: Array<{id:string, status:string, configured:boolean, cooldownUntil:string|null}>,
 * }} input
 * @param {string} [path] Injectable for tests; defaults to the real state file.
 */
export function writeHealthSnapshot(input, path = HEALTH_JSON_PATH) {
  writeJsonAtomic(path, {
    version: 1,
    updatedAt: new Date().toISOString(),
    lastRunAt: input.lastPulseAt,
    lastRunStatus: input.lastPulseStatus,
    lastRunDurationMs: input.lastPulseDurationMs,
    consecutiveFailures: input.consecutivePulseFailures,
    totalRuns: input.totalPulses,
    beacon: beaconFor(input.lastPulseAt),
    providers: input.providers,
  });
}

/**
 * @param {string|null} lastPulseAt
 * @param {Date} [now]
 * @returns {'green'|'amber'|'red'|'unknown'}
 */
export function beaconFor(lastPulseAt, now = new Date()) {
  if (!lastPulseAt) return 'unknown';
  const ageMinutes = (now.getTime() - Date.parse(lastPulseAt)) / 60_000;
  if (!Number.isFinite(ageMinutes)) return 'unknown';
  if (ageMinutes > RED_AFTER_MINUTES) return 'red';
  if (ageMinutes > AMBER_AFTER_MINUTES) return 'amber';
  return 'green';
}

export default { writeHealthSnapshot, beaconFor, HEALTH_JSON_PATH, AMBER_AFTER_MINUTES, RED_AFTER_MINUTES };
