#!/usr/bin/env node
/**
 * @file Tells the Worker that a pulse finished (Wave 12, R1). The pulse keeper reads this heartbeat. A failed call must
 * never fail the pulse, so this script always exits 0.
 */
import { callWorker } from '../src/lib/workerCallback.js';

const res = await callWorker('/internal/pulse-heartbeat', {
  body: { pulseId: process.env.GITHUB_RUN_ID ? `run-${process.env.GITHUB_RUN_ID}` : undefined, status: process.env.PULSE_FAILED === '1' ? 'failed' : 'ok' },
  timeoutMs: 10_000,
});
console.log(res.ok ? `pulse-heartbeat: the Worker took the heartbeat (${res.kind} token).` : `pulse-heartbeat: the Worker did not take the heartbeat (${res.status ?? res.error ?? 'no status'}). The pulse goes on.`);
process.exit(0);
