#!/usr/bin/env node
/**
 * @file Refreshes the public mirror `state/ops/quota.json` from the Worker (RO1), and makes the other three mirrors
 * exist (health, eval, hosts) so TITAN can read a valid file before the first canary, eval, or probe has run.
 * The Worker holds the usage of TITAN and Runner together, so its quota answer is the one to mirror.
 *
 * Usage: node scripts/ops-sync.mjs
 * It does nothing to the quota mirror when TITAN_WORKER_URL or OPS_TOKEN is not set, or when the Worker does not answer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** The quota mirror is rewritten when the numbers change, or when the file is older than this. It keeps the history quiet. */
const REFRESH_MS = 6 * 3_600_000;

const EMPTY = {
  'state/ops/health.json': (now) => ({ contract: '1', generated_at: now, providers: {} }),
  'state/ops/eval.json': (now) => ({ contract: '1', generated_at: now, models: {} }),
  'state/ops/hosts.json': (now) => ({ contract: '1', generated_at: now, hosts: {} }),
  'state/ops/quota.json': (now) => ({ contract: '1', generated_at: now, providers: {} }),
};

async function main() {
  const now = new Date().toISOString();
  mkdirSync('state/ops', { recursive: true });
  for (const [path, make] of Object.entries(EMPTY)) {
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(make(now), null, 2)}\n`);
      console.log(`ops-sync: made the empty mirror ${path}`);
    }
  }
  const workerUrl = (process.env.TITAN_WORKER_URL ?? '').replace(/\/$/, '');
  const token = process.env.OPS_TOKEN ?? '';
  if (!workerUrl || !token) {
    console.log('ops-sync: the Worker URL or the ops token is not set, so the quota mirror stays as it is.');
    return 0;
  }
  try {
    const res = await fetch(`${workerUrl}/ops/quota`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.error(`ops-sync: GET /ops/quota answered ${res.status}, so the quota mirror stays as it is.`);
      return 0;
    }
    const body = await res.json();
    if (body?.contract !== '1' || typeof body.providers !== 'object') throw new Error('the answer does not have the shape of contract v1');
    const next = { contract: '1', generated_at: body.generated_at, providers: body.providers };
    let previous = null;
    try { previous = JSON.parse(readFileSync('state/ops/quota.json', 'utf8')); } catch { previous = null; }
    const same = previous && JSON.stringify(previous.providers) === JSON.stringify(next.providers);
    const fresh = previous && Date.now() - Date.parse(previous.generated_at) < REFRESH_MS;
    if (same && fresh) {
      console.log('ops-sync: the quota numbers did not change, so the mirror stays as it is.');
      return 0;
    }
    writeFileSync('state/ops/quota.json', `${JSON.stringify(next, null, 2)}\n`);
    console.log(`ops-sync: wrote state/ops/quota.json (${Object.keys(body.providers).length} provider(s)).`);
  } catch (err) {
    console.error(`ops-sync: the Worker was not reachable (${err instanceof Error ? err.message.slice(0, 80) : 'error'}), so the quota mirror stays as it is.`);
  }
  return 0;
}

main().then((c) => process.exit(c), (err) => {
  console.error(`ops-sync: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
