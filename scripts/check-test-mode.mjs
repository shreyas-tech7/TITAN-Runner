#!/usr/bin/env node
/**
 * @file Fails if the deployed Worker config can ever turn on the test mode flag (Wave 12, 7.1).
 * `TITAN_TEST_MODE` lets the Worker call fake hosts on 127.0.0.1. It must exist in local `.dev.vars` files only.
 */
import { readFileSync, readdirSync } from 'node:fs';

const TOML = 'worker/wrangler.toml';
const violations = [];

const toml = readFileSync(TOML, 'utf8');
if (/TITAN_TEST_(MODE|HOST_MAP)/.test(toml.replace(/^\s*#.*$/gm, ''))) violations.push(`${TOML} sets a test flag`);

for (const f of readdirSync('.github/workflows').filter((n) => /\.ya?ml$/.test(n))) {
  const text = readFileSync(`.github/workflows/${f}`, 'utf8').replace(/^\s*#.*$/gm, '');
  if (/TITAN_TEST_MODE/.test(text) && /wrangler\s+(deploy|secret|versions)/.test(text)) violations.push(`.github/workflows/${f} mentions the test flag next to a deploy`);
  if (/--var\s+TITAN_TEST/.test(text)) violations.push(`.github/workflows/${f} passes a test flag with --var`);
}

if (violations.length > 0) {
  console.error('check-test-mode failed:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('check-test-mode: the deployed Worker config never sets TITAN_TEST_MODE.');
