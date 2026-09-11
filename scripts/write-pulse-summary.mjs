#!/usr/bin/env node
/**
 * Prints a markdown job summary for one pulse, read straight back out of
 * whatever `src/pulse.js` just wrote to `state/`. Run by titan-pulse.yml
 * with its stdout redirected into `$GITHUB_STEP_SUMMARY` (task brief,
 * Track B: "Write a readable run summary to $GITHUB_STEP_SUMMARY on every
 * pulse, success or failure") — `if: always()` in the workflow, so this
 * runs and reads whatever heartbeat.json/health.json look like even when
 * the pulse itself failed.
 *
 * Usage: node scripts/write-pulse-summary.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STATE_DIR = join(process.cwd(), 'state');

function readJsonSafe(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}

const heartbeat = readJsonSafe(join(STATE_DIR, 'heartbeat.json'));
const health = readJsonSafe(join(STATE_DIR, 'health.json'));
const history = readJsonSafe(join(STATE_DIR, 'pulse-history.json'));

const lastPulse = history?.pulses?.[history.pulses.length - 1] ?? null;

const lines = ['## TITAN Pulse summary', ''];

if (!heartbeat) {
  lines.push('_No `state/heartbeat.json` found — the pulse likely failed before it could write anything._');
} else {
  const statusEmoji = heartbeat.lastPulseStatus === 'ok' ? '✅' : '❌';
  lines.push(`${statusEmoji} **${heartbeat.lastPulseStatus ?? 'unknown'}** in ${heartbeat.lastPulseDurationMs ?? '?'}ms at ${heartbeat.lastPulseAt ?? '?'}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Tasks claimed | ${heartbeat.lastPulseTasksClaimed ?? 0} |`);
  lines.push(`| Tasks completed | ${heartbeat.lastPulseTasksCompleted ?? 0} |`);
  lines.push(`| Tasks failed | ${heartbeat.lastPulseTasksFailed ?? 0} |`);
  lines.push(`| Consecutive failures | ${heartbeat.consecutivePulseFailures ?? 0} |`);
  lines.push(`| Total pulses ever | ${heartbeat.totalPulses ?? 0} |`);
  if (heartbeat.lastPulseError) lines.push(`| Error | \`${heartbeat.lastPulseError}\` |`);
}

if (health) {
  const beaconEmoji = { green: '🟢', amber: '🟡', red: '🔴', unknown: '⚪' }[health.beacon] ?? '⚪';
  lines.push('', `**Beacon**: ${beaconEmoji} ${health.beacon}`, '');
  if (Array.isArray(health.providers) && health.providers.length > 0) {
    lines.push('| Provider | Status | Configured |', '|---|---|---|');
    for (const p of health.providers) {
      lines.push(`| ${p.id} | ${p.status} | ${p.configured ? 'yes' : 'no'} |`);
    }
  }
}

if (lastPulse) {
  lines.push('', `_This pulse: ${lastPulse.durationMs}ms, ${lastPulse.status}._`);
}

console.log(lines.join('\n'));
