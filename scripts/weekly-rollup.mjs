#!/usr/bin/env node
/**
 * Keep-alive commit (task instructions, section G): GitHub pauses a
 * scheduled workflow after 60 days with no commit activity on the repo, at
 * all — including commits made by other workflows. A completely idle week
 * (no tasks filed, so no pulse ever had anything to commit) would let that
 * clock run out silently. This makes one real, meaningful commit every
 * week: a summary of the week's pulses and runs, not a junk empty commit.
 *
 * Run by `.github/workflows/keepalive.yml`, weekly. Writes
 * `state/digests/<date>-weekly-summary.md` and lets the workflow's own git
 * steps commit it — this script only ever touches the filesystem.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_DIR = join(process.cwd(), 'state');
const RUNS_DIR = join(STATE_DIR, 'runs');
const DIGESTS_DIR = join(STATE_DIR, 'digests');

const heartbeat = existsSync(join(STATE_DIR, 'heartbeat.json'))
  ? JSON.parse(readFileSync(join(STATE_DIR, 'heartbeat.json'), 'utf8'))
  : null;

const runFiles = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')) : [];
const weekAgo = Date.now() - 7 * 24 * 3_600_000;
const recentRuns = runFiles
  .map((f) => {
    try {
      return JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8'));
    } catch {
      return null;
    }
  })
  .filter((r) => r && Date.parse(r.createdAt) >= weekAgo);

const complete = recentRuns.filter((r) => r.state === 'complete').length;
const failed = recentRuns.filter((r) => r.state === 'failed').length;

const now = new Date();
const lines = [
  `# Weekly summary — ${now.toISOString().slice(0, 10)}`,
  '',
  `This is TITAN-Runner's weekly keep-alive commit — a real, meaningful summary, ` +
    `not an empty commit. GitHub pauses a scheduled workflow after 60 days with no ` +
    `commit activity on the repo; this and the pulse's own state commits are what ` +
    `keeps that clock from ever running out on an idle week.`,
  '',
  `- Pulses run this run of the script sees so far: **${heartbeat?.totalPulses ?? 0}** total`,
  `- Last pulse: ${heartbeat?.lastPulseAt ?? 'never'} (status: ${heartbeat?.lastPulseStatus ?? 'n/a'})`,
  `- Runs completed in the last 7 days: **${complete}**`,
  `- Runs failed in the last 7 days: **${failed}**`,
  `- Consecutive pulse failures right now: ${heartbeat?.consecutivePulseFailures ?? 0}`,
  '',
];

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
const outPath = join(DIGESTS_DIR, `${now.toISOString().slice(0, 10)}-weekly-summary.md`);
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`Wrote ${outPath}`);
