#!/usr/bin/env node
/**
 * @file The host probe (RO5). It runs in `ops-hosts.yml` every 3 hours, or by hand.
 *
 * It checks each host that has a URL secret (see `src/ops/hosts.js`), keeps a 30 day history in
 * `state/ops/hosts-history.json`, writes the public mirror `state/ops/hosts.json` with the uptime of 24 hours, 7 days,
 * and 30 days, and posts the same to the Worker (`POST /ops/hosts`). A host that fails 2 checks in a row opens an Issue
 * with the label host-alert (and a Discord message when DISCORD_WEBHOOK_URL is set). The Issue closes on recovery.
 *
 * Only host NAMES leave this script. A URL never goes to the history, the mirror, the Worker, an Issue, or a log.
 *
 * Usage: node scripts/ops-hosts.mjs [--force] [--no-post] [--no-alerts] [--only name,name]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createGitHubClient } from '../src/github.js';
import { ensureAlert, resolveAlert } from '../src/ops/alerts.js';
import { alertPlan, configuredHosts, emptyHistory, hostsMirror, probeHost, updateHistory } from '../src/ops/hosts.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const HISTORY = 'state/ops/hosts-history.json';
const MIRROR = 'state/ops/hosts.json';

function readHistory() {
  try {
    const h = JSON.parse(readFileSync(HISTORY, 'utf8'));
    return h && typeof h === 'object' && h.hosts ? h : emptyHistory();
  } catch {
    return emptyHistory();
  }
}

async function discord(text) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    // Host names only. The message holds no URL.
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 400) }), signal: AbortSignal.timeout(8_000) });
  } catch {
    console.error('ops-hosts: the Discord message could not be sent.');
  }
}

async function main() {
  const now = new Date();
  const history = readHistory();
  const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const github = createGitHubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
  const all = configuredHosts(process.env).filter((h) => !only || only.includes(h.name));

  // A Render host is probed at most every 5.5 hours, so the probe does not keep a free service awake.
  const due = all.filter((h) => {
    if (args.includes('--force') || h.minIntervalMs === 0) return true;
    const last = history.hosts[h.name]?.at(-1)?.[0];
    return !last || now.getTime() - Date.parse(last) >= h.minIntervalMs;
  });
  const skipped = all.filter((h) => !due.includes(h)).map((h) => h.name);
  console.log(`ops-hosts: ${all.length} host(s) have a URL (or need none). Probing ${due.length}${skipped.length ? `, waiting for the interval: ${skipped.join(', ')}` : ''}.`);

  const probes = await Promise.all(due.map((h) => probeHost(h, {
    pulse: () => github.getLastSuccessfulRun('titan-pulse.yml'),
    hfToken: process.env.HF_API_KEY,
  })));
  const results = probes.filter(Boolean);
  for (const r of results) console.log(`${r.host.padEnd(16)} ${r.status.padEnd(7)} ${String(r.latency_ms ?? '-').padStart(6)} ms  ${r.reason}`);
  for (const h of due) if (!results.some((r) => r.host === h.name)) console.log(`${h.name.padEnd(16)} no evidence (the check could not reach its source)`);

  const next = updateHistory(history, results, now);
  const latest = Object.fromEntries(results.map((r) => [r.host, r]));
  const prior = existsSync(MIRROR) ? (() => { try { return JSON.parse(readFileSync(MIRROR, 'utf8')); } catch { return null; } })() : null;
  const mirror = hostsMirror(next, { github_actions: { last_pulse_at: latest.github_actions?.last_pulse_at ?? prior?.hosts?.github_actions?.last_pulse_at ?? null } }, now);
  mkdirSync('state/ops', { recursive: true });
  writeFileSync(HISTORY, `${JSON.stringify(next)}\n`);
  writeFileSync(MIRROR, `${JSON.stringify(mirror, null, 2)}\n`);

  if (!args.includes('--no-alerts') && github.ready()) {
    for (const a of alertPlan(next, results)) {
      try {
        if (a.action === 'open') {
          const res = await ensureAlert(github, { label: 'host-alert', title: a.title, body: a.body });
          console.log(`ops-hosts: alert for ${a.host}: ${res.action}${res.number ? ` #${res.number}` : ''}`);
          if (res.action === 'opened') await discord(`Host down: ${a.host}. It failed its checks. See the host-alert Issue in the TITAN-Runner repo.`);
        } else {
          const res = await resolveAlert(github, { label: 'host-alert', title: a.title, comment: a.body });
          if (res.action === 'closed') {
            console.log(`ops-hosts: alert for ${a.host}: closed #${res.number}`);
            await discord(`Host recovered: ${a.host} is back.`);
          }
        }
      } catch (err) {
        console.error(`ops-hosts: the alert for ${a.host} failed (${err instanceof Error ? err.message.slice(0, 120) : 'error'}).`);
      }
    }
  }

  const workerUrl = (process.env.TITAN_WORKER_URL ?? '').replace(/\/$/, '');
  const token = process.env.OPS_TOKEN ?? '';
  const checks = Object.entries(mirror.hosts).map(([host, v]) => ({ host, ...v }));
  if (!args.includes('--no-post') && workerUrl && token && checks.length > 0) {
    try {
      const res = await fetch(`${workerUrl}/ops/hosts`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ checks }), signal: AbortSignal.timeout(10_000) });
      console.log(`ops-hosts: POST /ops/hosts answered ${res.status}`);
    } catch {
      console.error('ops-hosts: the Worker was not reachable. The mirror is written.');
    }
  } else {
    console.log('ops-hosts: nothing was posted to the Worker.');
  }
  return 0;
}

main().then((c) => process.exit(c), (err) => {
  console.error(`ops-hosts: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
