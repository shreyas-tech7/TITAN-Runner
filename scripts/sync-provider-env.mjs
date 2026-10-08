#!/usr/bin/env node
/**
 * @file Rewrites the generated provider secret blocks from `config/providers.catalog.json`.
 * Run it after you change the catalog: `npm run sync:providers`. The gate `check:providers` fails when a block is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { WORKFLOWS_WITH_PROVIDER_ENV, envExampleBlock, readCatalog, replaceBlock, workflowEnvBlock } from './lib/providerEnv.mjs';

const root = process.cwd();
const catalog = readCatalog(root);
let changed = 0;

for (const name of WORKFLOWS_WITH_PROVIDER_ENV) {
  const path = `${root}/.github/workflows/${name}`;
  const text = readFileSync(path, 'utf8');
  const next = replaceBlock(text, (indent) => workflowEnvBlock(catalog, indent));
  if (next === null) {
    console.error(`sync-provider-env: ${name} has no marker block. Add the BEGIN and END marker lines first.`);
    process.exitCode = 1;
    continue;
  }
  if (next !== text) {
    writeFileSync(path, next);
    changed += 1;
    console.log(`updated ${name}`);
  }
}

const envPath = `${root}/.env.example`;
const envText = readFileSync(envPath, 'utf8');
const envNext = replaceBlock(envText, () => envExampleBlock(catalog));
if (envNext === null) {
  console.error('sync-provider-env: .env.example has no marker block. Add the BEGIN and END marker lines first.');
  process.exitCode = 1;
} else if (envNext !== envText) {
  writeFileSync(envPath, envNext);
  changed += 1;
  console.log('updated .env.example');
}
// The dashboard bundles its own copy of the catalog, because Next cannot import a file outside its folder.
const dashCopy = `${root}/dashboard/lib/providers.catalog.json`;
const source = readFileSync(`${root}/config/providers.catalog.json`, 'utf8');
let current = '';
try {
  current = readFileSync(dashCopy, 'utf8');
} catch {
  // missing
}
if (current !== source) {
  writeFileSync(dashCopy, source);
  changed += 1;
  console.log('updated dashboard/lib/providers.catalog.json');
}
console.log(`sync-provider-env: ${changed} file(s) changed.`);
