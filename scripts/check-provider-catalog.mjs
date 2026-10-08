#!/usr/bin/env node
/**
 * @file Drift gate for `config/providers.catalog.json` (Wave 12, K1, decision W12-D5).
 *
 * The catalog is the one source of truth for model providers. This gate fails when:
 *   - the catalog itself is malformed (duplicate ids, a bad secret name, a missing key secret);
 *   - a catalog secret is missing from the env map of titan-pulse.yml, spawn-subagent.yml, or provider-selftest.yml;
 *   - a workflow env map holds a provider-looking secret that the catalog does not list;
 *   - a catalog secret is missing from `.env.example`;
 *   - a generated block differs from what `npm run sync:providers` would write;
 *   - a hard-coded provider list sits in code that must read the catalog.
 *
 * Usage: node scripts/check-provider-catalog.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { WORKFLOWS_WITH_PROVIDER_ENV, envExampleBlock, readCatalog, replaceBlock, workflowEnvBlock } from './lib/providerEnv.mjs';

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_LOOKING = /^(?!TITAN_|GITHUB_|CLOUDFLARE_|GEV_)[A-Z0-9_]+_(?:API_KEY|MODEL|BASE_URL|CHAT_PATH|SPECIALIZATION|LABEL)$/;
const REQUIRED_FIELDS = ['id', 'label', 'kind', 'verifiable', 'usedBy', 'secrets', 'keyHint', 'validate', 'getKeyUrl', 'freeTierNote'];

/** Files that must read the catalog and must not keep their own provider id list. */
export const NO_HARDCODED_LIST_IN = [
  'worker/src/index.js',
  'worker/src/keys.js',
  'worker/src/lib',
  'dashboard/lib/workerApi.ts',
  'dashboard/components',
  'dashboard/app',
  'src/providers/registry.js',
  'scripts/run-subagent-task.mjs',
  'scripts/provider-selftest.mjs',
];
const HARDCODED_LIST = /['"]groq['"]\s*,\s*['"]together['"]/;

/**
 * @param {{ catalog: any, workflows: Record<string,string>, envExample: string, sources?: Array<{ path: string, text: string }> }} input
 * @returns {string[]} violations
 */
export function checkProviderCatalog({ catalog, workflows, envExample, sources = [], dashboardCopy = null, catalogText = null }) {
  const v = [];
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
  if (providers.length === 0) return ['the catalog has no providers'];

  const ids = new Set();
  const secrets = new Set();
  for (const p of providers) {
    for (const f of REQUIRED_FIELDS) if (!(f in p)) v.push(`catalog: ${p.id ?? '?'} is missing the field "${f}"`);
    if (ids.has(p.id)) v.push(`catalog: duplicate provider id "${p.id}"`);
    ids.add(p.id);
    if (!p.secrets?.key) v.push(`catalog: ${p.id} has no key secret`);
    for (const name of Object.values(p.secrets ?? {})) {
      if (!SECRET_NAME.test(name) || name.startsWith('GITHUB_')) v.push(`catalog: ${p.id} has a bad secret name "${name}"`);
      if (secrets.has(name)) v.push(`catalog: secret name "${name}" is used twice`);
      secrets.add(name);
    }
    if (p.verifiable && !p.validate) v.push(`catalog: ${p.id} is verifiable but has no validate block`);
    if (!p.verifiable && !p.unverifiableReason) v.push(`catalog: ${p.id} is not verifiable but gives no reason`);
    if (!p.freeTierNote?.checkedOn) v.push(`catalog: ${p.id} has no check date on its free tier note`);
  }
  for (const id of ['groq', 'together', 'openrouter', 'gemini', 'huggingface', 'opencode', 'omniroute', 'hermes_1', 'hermes_2', 'hermes_3', 'freebuff', 'custom_1', 'custom_2', 'custom_3']) {
    if (!ids.has(id)) v.push(`catalog: the required id "${id}" is missing`);
  }

  for (const name of WORKFLOWS_WITH_PROVIDER_ENV) {
    const text = workflows[name];
    if (text === undefined) {
      v.push(`${name}: file not found`);
      continue;
    }
    for (const secret of secrets) {
      if (!new RegExp(`^\\s*${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}\\s*$`, 'm').test(text)) {
        v.push(`${name}: the catalog secret ${secret} is not in the env map`);
      }
    }
    for (const m of text.matchAll(/^\s*([A-Z0-9_]+):\s*\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}\s*$/gm)) {
      if (PROVIDER_LOOKING.test(m[1]) && !secrets.has(m[1])) v.push(`${name}: ${m[1]} looks like a provider secret but is not in the catalog`);
    }
    const synced = replaceBlock(text, (indent) => workflowEnvBlock(catalog, indent));
    if (synced === null) v.push(`${name}: the generated provider block markers are missing`);
    else if (synced !== text) v.push(`${name}: the generated provider block is stale. Run npm run sync:providers`);
  }

  for (const secret of secrets) {
    if (!new RegExp(`^${secret}=`, 'm').test(envExample)) v.push(`.env.example: the catalog secret ${secret} is missing`);
  }
  const envSynced = replaceBlock(envExample, () => envExampleBlock(catalog));
  if (envSynced === null) v.push('.env.example: the generated provider block markers are missing');
  else if (envSynced !== envExample) v.push('.env.example: the generated provider block is stale. Run npm run sync:providers');

  if (dashboardCopy !== null && catalogText !== null && dashboardCopy !== catalogText) {
    v.push('dashboard/lib/providers.catalog.json differs from config/providers.catalog.json. Run npm run sync:providers');
  }

  for (const { path, text } of sources) {
    if (HARDCODED_LIST.test(text)) v.push(`${path}: keeps its own provider id list. Read the catalog instead`);
  }
  return v;
}

function listFiles(root, rel) {
  const full = `${root}/${rel}`;
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [rel];
  return readdirSync(full).flatMap((n) => (n === 'node_modules' ? [] : listFiles(root, `${rel}/${n}`)));
}

function main() {
  const root = process.cwd();
  const catalog = readCatalog(root);
  const workflows = {};
  for (const name of WORKFLOWS_WITH_PROVIDER_ENV) {
    const path = `${root}/.github/workflows/${name}`;
    if (existsSync(path)) workflows[name] = readFileSync(path, 'utf8');
  }
  const envExample = readFileSync(`${root}/.env.example`, 'utf8');
  const sources = NO_HARDCODED_LIST_IN.flatMap((rel) => listFiles(root, rel))
    .filter((p) => /\.(js|mjs|ts|tsx)$/.test(p))
    .map((p) => ({ path: p, text: readFileSync(`${root}/${p}`, 'utf8') }));
  const catalogText = readFileSync(`${root}/config/providers.catalog.json`, 'utf8');
  const copyPath = `${root}/dashboard/lib/providers.catalog.json`;
  const dashboardCopy = existsSync(copyPath) ? readFileSync(copyPath, 'utf8') : '';
  const violations = checkProviderCatalog({ catalog, workflows, envExample, sources, dashboardCopy, catalogText });
  if (violations.length > 0) {
    console.error('Provider catalog check failed:');
    for (const m of violations) console.error(`  - ${m}`);
    process.exit(1);
  }
  const count = catalog.providers.length;
  const secretCount = catalog.providers.reduce((n, p) => n + Object.keys(p.secrets).length, 0);
  console.log(`check-provider-catalog: ${count} providers and ${secretCount} secrets agree with the workflows and .env.example.`);
}

if (process.argv[1] && /check-provider-catalog\.mjs$/.test(process.argv[1])) main();
