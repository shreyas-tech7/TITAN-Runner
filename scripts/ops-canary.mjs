#!/usr/bin/env node
/**
 * @file The nightly provider canary (RO2). It runs in `ops-canary.yml`, around 03:00 America/Chicago, or by hand.
 *
 * It sends the fixed task to every provider of the catalog, marks each one healthy, degraded, down, or not_configured,
 * writes the public mirror `state/ops/health.json`, and posts the results to the Worker (`POST /ops/health`) when
 * TITAN_WORKER_URL and OPS_TOKEN are set. It also reports its calls to the usage ledger.
 *
 * Usage: node scripts/ops-canary.mjs [--only groq,gemini] [--no-post] [--out state/ops/health.json]
 * Exit code 0 even when a provider is down. A down provider is the result, not an error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { healthMirror, runCanary } from '../src/ops/canary.js';
import { buildTargets } from '../src/ops/canaryTargets.js';
import { UsageReporter } from '../src/ops/usageReporter.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

async function main() {
  if (process.env.TITAN_DRY_RUN === '1') {
    console.error('ops-canary: this script makes real calls. It refuses to run under TITAN_DRY_RUN.');
    return 1;
  }
  const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const out = flag('--out') ?? 'state/ops/health.json';
  const usage = new UsageReporter();
  const targets = await buildTargets({ only });
  const results = await runCanary(targets, { usage });
  for (const r of results) console.log(`${r.provider.padEnd(14)} ${r.status.padEnd(15)} ${String(r.latency_ms ?? '-').padStart(6)} ms  ${r.error_class ?? ''}`);

  const mirror = healthMirror(results);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(mirror, null, 2)}\n`);

  const workerUrl = (process.env.TITAN_WORKER_URL ?? '').replace(/\/$/, '');
  const token = process.env.OPS_TOKEN ?? '';
  if (!args.includes('--no-post') && workerUrl && token) {
    try {
      const res = await fetch(`${workerUrl}/ops/health`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ results }), signal: AbortSignal.timeout(10_000),
      });
      console.log(`ops-canary: POST /ops/health answered ${res.status}`);
    } catch (err) {
      console.error(`ops-canary: the Worker was not reachable (${err instanceof Error ? err.message.slice(0, 80) : 'error'}). The mirror is written.`);
    }
  } else {
    console.log('ops-canary: the Worker URL or the ops token is not set, so nothing was posted. The mirror is written.');
  }
  const flushed = await usage.flush();
  console.log(`ops-canary: usage ${flushed.skipped ? `skipped (${flushed.skipped})` : `sent ${flushed.sent}`}`);
  return 0;
}

main().then((c) => process.exit(c), (err) => {
  console.error(`ops-canary: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
