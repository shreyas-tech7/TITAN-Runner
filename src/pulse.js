#!/usr/bin/env node
/**
 * @file The pulse — this repo's entrypoint. Run by
 * `.github/workflows/titan-pulse.yml` on a cron, or by hand via
 * `npm run pulse` / `npm run pulse:dry` / `titan simulate`.
 *
 * The engine lives in `src/engine/pulse.js` (`runPulse(deps)`); this file
 * only reads the environment, wires the simulation fakes when
 * `TITAN_FAKE_PROVIDER` / `TITAN_FAKE_GITHUB` are set (see fakes/wire.js),
 * prints the summary, and sets the exit code. It never touches git itself
 * unless `TITAN_CHECKPOINT=git` (the workflow's setting) — the dry-run and
 * the tests stay git-free.
 */
import { runPulse } from './engine/pulse.js';
import { fakeDepsFromEnv } from './fakes/wire.js';

export { runPulse };

async function main() {
  const fakes = fakeDepsFromEnv(process.env);
  const summary = await runPulse(fakes ?? {});
  console.log(JSON.stringify(summary));
  if (summary.error) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && /[\\/]pulse\.js$/.test(process.argv[1]);
if (invokedDirectly) await main();
