#!/usr/bin/env node
/**
 * @file Rings the TITAN doorbell once (RO6). It runs in `doorbell.yml`.
 *
 * Usage:
 *   node scripts/ops-doorbell.mjs --schedule "30 11 * * *"   a scheduled run: the Chicago time decides if it goes on
 *   node scripts/ops-doorbell.mjs --job sweep                a manual run: it always goes on
 *
 * Reads TITAN_BACKEND_URL and DOORBELL_TOKEN. When one is not set it prints one line and stops with code 0.
 * It reports the status code (and nothing else) to the Worker with `POST /ops/doorbell` when TITAN_WORKER_URL and
 * OPS_TOKEN are set. The output holds the job and the status code. It never holds the URL, the token, or an answer.
 */
import { planRun, ringDoorbell } from '../src/ops/doorbell.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

async function main() {
  const plan = planRun({ job: flag('--job'), schedule: flag('--schedule') });
  if (!plan.proceed) {
    console.log(`ops-doorbell: no ring (${plan.reason}).`);
    return plan.job === null && flag('--job') ? 1 : 0;
  }
  const ring = await ringDoorbell(plan.job, { backendUrl: process.env.TITAN_BACKEND_URL, token: process.env.DOORBELL_TOKEN });
  if (ring.status === 'skipped') {
    console.log(`ops-doorbell: skipped the ${plan.job} ring (${ring.reason}).`);
    return 0;
  }
  console.log(`ops-doorbell: ${plan.job} -> ${ring.status_code ?? 'no answer'} (${ring.status}, ${ring.reason})`);

  const workerUrl = (process.env.TITAN_WORKER_URL ?? '').replace(/\/$/, '');
  const token = process.env.OPS_TOKEN ?? '';
  if (workerUrl && token) {
    try {
      const res = await fetch(`${workerUrl}/ops/doorbell`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ job: plan.job, status_code: ring.status_code, at: new Date().toISOString() }), signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.log(`ops-doorbell: the Worker answered ${res.status} to the log call.`);
    } catch {
      console.log('ops-doorbell: the Worker was not reachable, so the status code was not logged.');
    }
  }
  return 0;
}

main().then((c) => process.exit(c), () => {
  console.error('ops-doorbell: stopped by an unexpected error.');
  process.exit(1);
});
