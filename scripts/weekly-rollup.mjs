#!/usr/bin/env node
/**
 * Keep-alive commit (task instructions, section G/4): GitHub pauses a
 * scheduled workflow after 60 days with no commit activity on the repo, at
 * all — including commits made by other workflows. A completely idle week
 * (no tasks filed, so no pulse ever had anything to commit) would let that
 * clock run out silently. This makes one real, meaningful commit every
 * week: a summary of the week's pulses and runs, not a junk empty commit.
 *
 * Task instructions, section 3 ("Weekly digest"): this rollup also opens a
 * summary issue — pulses run, tasks completed, failures, provider mix,
 * median duration, every number computed from what was actually committed
 * this week, nothing estimated or fabricated. Deduplicated by title against
 * already-open `titan-digest`-labeled issues, the same pattern
 * `deadman.yml`'s alert issue uses, so a workflow re-run never files two.
 *
 * Run by `.github/workflows/keepalive.yml`, weekly. Writes
 * `state/digests/<date>-weekly-summary.md` and lets the workflow's own git
 * steps commit it; the digest issue is created directly via the GitHub API
 * (this script needs `GITHUB_TOKEN`/`GITHUB_REPOSITORY` set, same as the
 * pulse — see the workflow's env block).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listOpenTaskIssues, createIssue } from '../src/github.js';
import { median } from '../src/lib/median.js';

const STATE_DIR = join(process.cwd(), 'state');
const RUNS_DIR = join(STATE_DIR, 'runs');
const DIGESTS_DIR = join(STATE_DIR, 'digests');
const DIGEST_LABEL = 'titan-digest';

function readJsonSafe(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const heartbeat = readJsonSafe(join(STATE_DIR, 'heartbeat.json'), null);
const pulseHistory = readJsonSafe(join(STATE_DIR, 'pulse-history.json'), { pulses: [] });

const weekAgo = Date.now() - 7 * 24 * 3_600_000;

const runFiles = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')) : [];
const recentRuns = runFiles
  .map((f) => readJsonSafe(join(RUNS_DIR, f), null))
  .filter((r) => r && Date.parse(r.createdAt) >= weekAgo);

const complete = recentRuns.filter((r) => r.state === 'complete').length;
const failed = recentRuns.filter((r) => r.state === 'failed').length;

const recentPulses = (pulseHistory.pulses ?? []).filter((p) => Date.parse(p.at) >= weekAgo);
const pulsesThisWeek = recentPulses.length;
// Real committed data only (task brief, section 3) — pulse-history.json is
// the source of truth for per-pulse duration; a checkout from before that
// file existed falls back to run durations, which is still real data, just
// coarser (only pulses that claimed at least one task are represented).
const medianPulseDurationMs = recentPulses.length > 0
  ? median(recentPulses.map((p) => p.durationMs))
  : median(recentRuns.map((r) => r.durationMs));

/** @type {Map<string, number>} pool -> count of successful subtask attempts. */
const providerMix = new Map();
for (const run of recentRuns) {
  for (const task of run.tasks ?? []) {
    for (const attempt of task.attempts ?? []) {
      if (!attempt.ok) continue;
      providerMix.set(attempt.pool, (providerMix.get(attempt.pool) ?? 0) + 1);
    }
  }
}
const providerMixSorted = [...providerMix.entries()].sort((a, b) => b[1] - a[1]);

const now = new Date();
const dateStamp = now.toISOString().slice(0, 10);

const lines = [
  `# Weekly summary — ${dateStamp}`,
  '',
  `This is TITAN-Runner's weekly keep-alive commit — a real, meaningful summary, ` +
    `not an empty commit. GitHub pauses a scheduled workflow after 60 days with no ` +
    `commit activity on the repo; this and the pulse's own state commits are what ` +
    `keeps that clock from ever running out on an idle week.`,
  '',
  `- Pulses run in the last 7 days: **${pulsesThisWeek}** (${heartbeat?.totalPulses ?? 0} total all-time)`,
  `- Median pulse duration this week: ${medianPulseDurationMs != null ? `**${(medianPulseDurationMs / 1000).toFixed(1)}s**` : 'no data yet'}`,
  `- Last pulse: ${heartbeat?.lastPulseAt ?? 'never'} (status: ${heartbeat?.lastPulseStatus ?? 'n/a'})`,
  `- Runs completed in the last 7 days: **${complete}**`,
  `- Runs failed in the last 7 days: **${failed}**`,
  `- Consecutive pulse failures right now: ${heartbeat?.consecutivePulseFailures ?? 0}`,
  '',
];

if (providerMixSorted.length > 0) {
  lines.push('## Provider mix (successful subtask attempts)', '');
  for (const [pool, count] of providerMixSorted) lines.push(`- ${pool}: ${count}`);
  lines.push('');
}

if (recentRuns.length > 0) {
  lines.push('## Runs this week', '');
  for (const r of recentRuns.slice(0, 50)) {
    lines.push(`- \`${r.runId}\` — ${r.taskTitle ?? 'untitled'} — ${r.state} — ${r.tasks?.length ?? 0} subtask(s)`);
  }
  lines.push('');
} else {
  lines.push('No runs this week — the queue was empty. This commit itself is what keeps the cron alive.', '');
}

mkdirSync(DIGESTS_DIR, { recursive: true });
const outPath = join(DIGESTS_DIR, `${dateStamp}-weekly-summary.md`);
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`Wrote ${outPath}`);

const issueTitle = `TITAN-Runner weekly digest — ${dateStamp}`;
let existing = [];
try {
  existing = await listOpenTaskIssues(DIGEST_LABEL);
} catch (err) {
  // Dedupe is best-effort only — a GitHub API failure here just means a
  // possible duplicate digest issue on a retry, never a skipped rollup.
  console.warn(`Could not list existing digest issues (continuing without dedupe check): ${err instanceof Error ? err.message : String(err)}`);
}
if (existing.some((i) => i.title === issueTitle)) {
  console.log('Digest issue already open for this date — not filing a duplicate.');
} else {
  const issueBody = [
    ...lines,
    '---',
    '_This issue was opened automatically by the weekly keep-alive job (`.github/workflows/keepalive.yml`, `scripts/weekly-rollup.mjs`). Close it any time — it is a report, not something to action._',
  ].join('\n');
  const issue = await createIssue(issueTitle, issueBody, [DIGEST_LABEL]);
  if (issue) console.log(`Opened weekly digest issue: ${issue.html_url}`);
  else console.log('No GitHub token/repository configured (or dry-run) — skipped opening the digest issue.');
}
