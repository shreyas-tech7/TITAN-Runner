#!/usr/bin/env node
/**
 * Writes the state-file schemas from `src/state/schema.js` to `schemas/*.schema.json`
 * so the data contract is a set of plain files a dashboard, a script, or a
 * reviewer can read without importing the engine. `test/contract.test.js`
 * fails when the files and the code disagree; run this script to update them.
 *
 *   node scripts/export-schemas.mjs          write
 *   node scripts/export-schemas.mjs --check  exit 1 when anything differs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_FILES } from '../src/state/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'schemas');
const check = process.argv.includes('--check');
let differing = 0;
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(SCHEMA_FILES)) {
  const path = join(dir, `${name}.schema.json`);
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === text) continue;
  differing += 1;
  if (check) console.error(`schemas/${name}.schema.json is out of date`);
  else writeFileSync(path, text);
}
if (check && differing > 0) {
  console.error('run `node scripts/export-schemas.mjs` and commit the result');
  process.exit(1);
}
console.log(check ? 'schemas: in sync' : `schemas: ${differing} file(s) written`);
