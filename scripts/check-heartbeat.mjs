#!/usr/bin/env node
/**
 * Dead-man's switch (task instructions, section G): fails loudly if no
 * pulse has succeeded in the last 24 hours, so silent death is visible.
 * Run by `.github/workflows/deadman.yml` on its own daily schedule —
 * deliberately a separate workflow from the pulse itself, so a pulse that
 * is failing (or a cron GitHub has stopped scheduling) cannot also be the
 * thing responsible for noticing it stopped.
 *
 * Exit code 1 (checked by the workflow, which then opens a `titan-alert`
 * issue) when `state/heartbeat.json`'s `lastPulseAt` is missing or older
 * than 24 hours, OR when `lastPulseStatus` is `"error"` for
 * `MAX_CONSECUTIVE_FAILURES` pulses in a row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_STALE_HOURS = 24;
const MAX_CONSECUTIVE_FAILURES = 8; // ~2 hours at the default 15-minute cadence

const path = join(process.cwd(), 'state', 'heartbeat.json');
let heartbeat;
try {
  heartbeat = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${path}: ${err.message}`);
  process.exit(1);
}

const problems = [];

if (!heartbeat.lastPulseAt) {
  problems.push('No pulse has ever recorded a heartbeat.');
} else {
  const ageHours = (Date.now() - Date.parse(heartbeat.lastPulseAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > MAX_STALE_HOURS) {
    problems.push(`Last pulse was ${ageHours.toFixed(1)}h ago (threshold: ${MAX_STALE_HOURS}h). Either the cron stopped firing or every recent run crashed before writing state.`);
  }
}

if ((heartbeat.consecutivePulseFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
  problems.push(`${heartbeat.consecutivePulseFailures} consecutive pulse failures (last error: ${heartbeat.lastPulseError ?? 'unknown'}).`);
}

if (problems.length > 0) {
  console.error('TITAN-Runner dead-man\'s switch tripped:\n' + problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}

console.log(`Heartbeat OK — last pulse ${heartbeat.lastPulseAt}, status ${heartbeat.lastPulseStatus}.`);
