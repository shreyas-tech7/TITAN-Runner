#!/usr/bin/env node
/**
 * @file Commits and pushes `state/` from a workflow (RT2, RT3, RT7). Every workflow that writes state calls this.
 *
 * It does what the pulse checkpointer does, for any workflow:
 *   1. It checks every file under `state/` against its strict schema, and refuses to publish a bad tree.
 *   2. It stages only `state/` and commits through the Reviewer Gate (`src/reviewer/githubGate.js`).
 *      The gate refuses a path outside `state/` and any added line that looks like a secret.
 *   3. It pulls with rebase, then pushes. On a conflict it builds the commit again on top of the remote tip.
 *      It tries three times and then fails, so a lost push shows up as a red run.
 *
 * Every workflow that calls it also joins the concurrency group `titan-state`, so two of them never push at once.
 *
 * Usage: node scripts/publish-state.mjs --message "chore(ops): canary" [--ref main] [--no-validate]
 * Exit code: 0 when the state is published or there is nothing to publish. 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import { Checkpointer } from '../src/engine/checkpointer.js';
import { checkStateDir } from './check-state.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

async function main() {
  const message = flag('--message');
  if (!message) {
    console.error('publish-state: --message is required.');
    return 1;
  }
  const ref = flag('--ref') || process.env.GITHUB_REF_NAME || execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!args.includes('--no-validate')) {
    const { problems } = checkStateDir('state');
    if (problems.length > 0) {
      for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
      console.error(`publish-state: ${problems.length} state problem(s). Nothing was published.`);
      return 1;
    }
  }
  const cp = new Checkpointer({ mode: 'git', stateDir: 'state', repoRoot: process.cwd(), ref, minIntervalMs: 0, message });
  const result = await cp.checkpoint('publish', { force: true });
  if (result.skipped === 'nothing changed') {
    console.log('publish-state: nothing to publish.');
    return 0;
  }
  if (!result.committed || !result.pushed) {
    console.error(`publish-state: the state was ${result.committed ? 'committed but not pushed' : 'not committed'} (${result.skipped ?? 'push failed after three tries'}).`);
    return 1;
  }
  console.log(`publish-state: pushed to ${ref}.`);
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`publish-state: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
