import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkProviderCatalog, NO_HARDCODED_LIST_IN } from '../scripts/check-provider-catalog.mjs';
import { WORKFLOWS_WITH_PROVIDER_ENV, envExampleBlock, readCatalog, replaceBlock, workflowEnvBlock } from '../scripts/lib/providerEnv.mjs';
import { DIRECT_PROVIDER_IDS, CUSTOM_PROVIDER_IDS, allSecretNames, getCatalogProvider, keyHintWarning } from '../src/providers/catalog.js';

const root = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8');

function realInput() {
  const workflows = Object.fromEntries(WORKFLOWS_WITH_PROVIDER_ENV.map((n) => [n, read(`.github/workflows/${n}`)]));
  return { catalog: readCatalog(root.replace(/\/$/, '')), workflows, envExample: read('.env.example'), sources: [], dashboardCopy: read('dashboard/lib/providers.catalog.json'), catalogText: read('config/providers.catalog.json') };
}

test('the real catalog, workflows, and .env.example agree', () => {
  assert.deepEqual(checkProviderCatalog(realInput()), []);
});

test('the catalog holds every id that the brief names, in failover order', () => {
  const ids = readCatalog(root.replace(/\/$/, '')).providers.map((p) => p.id);
  for (const id of ['groq', 'together', 'openrouter', 'gemini', 'huggingface', 'opencode', 'omniroute', 'hermes_1', 'hermes_2', 'hermes_3', 'freebuff', 'custom_1', 'custom_2', 'custom_3']) assert.ok(ids.includes(id), id);
  assert.deepEqual(DIRECT_PROVIDER_IDS, ['groq', 'together', 'openrouter', 'gemini', 'huggingface']);
  assert.deepEqual(CUSTOM_PROVIDER_IDS, ['custom_1', 'custom_2', 'custom_3']);
});

test('drift: a catalog secret missing from a workflow env map fails the gate', () => {
  for (const name of WORKFLOWS_WITH_PROVIDER_ENV) {
    const input = realInput();
    input.workflows[name] = input.workflows[name].replace(/^\s*GROQ_API_KEY: .*\n/gm, '');
    const v = checkProviderCatalog(input);
    assert.ok(v.some((m) => m.startsWith(name) && m.includes('GROQ_API_KEY')), `${name}: ${v.join(' | ')}`);
  }
});

test('drift: a catalog secret missing from .env.example fails the gate', () => {
  const input = realInput();
  input.envExample = input.envExample.replace(/^TOGETHER_API_KEY=\n/m, '');
  assert.ok(checkProviderCatalog(input).some((m) => m.includes('.env.example') && m.includes('TOGETHER_API_KEY')));
});

test('drift: a provider looking secret that the catalog does not list fails the gate', () => {
  const input = realInput();
  input.workflows['titan-pulse.yml'] = input.workflows['titan-pulse.yml'].replace('# END provider secrets', 'MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}\n          # END provider secrets');
  assert.ok(checkProviderCatalog(input).some((m) => m.includes('MISTRAL_API_KEY') && m.includes('not in the catalog')));
});

test('drift: a stale generated block fails the gate, and the generator repairs it', () => {
  const input = realInput();
  input.workflows['spawn-subagent.yml'] = input.workflows['spawn-subagent.yml'].replace(/HF_MODEL: .*/g, 'HF_MODEL: ${{ secrets.HF_MODEL }} # edited');
  assert.ok(checkProviderCatalog(input).some((m) => m.includes('spawn-subagent.yml')));
  const fixed = replaceBlock(input.workflows['spawn-subagent.yml'], (indent) => workflowEnvBlock(input.catalog, indent));
  input.workflows['spawn-subagent.yml'] = fixed;
  assert.deepEqual(checkProviderCatalog(input), []);
});

test('drift: a hard-coded provider list in guarded code fails the gate', () => {
  const input = realInput();
  input.sources = [{ path: 'worker/src/keys.js', text: "const KNOWN = ['groq', 'together', 'openrouter'];" }];
  assert.ok(checkProviderCatalog(input).some((m) => m.includes('keeps its own provider id list')));
  assert.ok(NO_HARDCODED_LIST_IN.includes('src/providers/registry.js'));
});

test('drift: the dashboard copy must equal the catalog', () => {
  const input = realInput();
  input.dashboardCopy += ' ';
  assert.ok(checkProviderCatalog(input).some((m) => m.includes('dashboard/lib/providers.catalog.json')));
});

test('catalog rules: duplicate ids, bad secret names, and a missing check date are caught', () => {
  const input = realInput();
  input.catalog.providers.push({ ...input.catalog.providers[0] });
  assert.ok(checkProviderCatalog(input).some((m) => m.includes('duplicate provider id')));
  const bad = realInput();
  bad.catalog.providers[0].secrets.key = 'github_token';
  assert.ok(checkProviderCatalog(bad).some((m) => m.includes('bad secret name')));
  const nodate = realInput();
  delete nodate.catalog.providers[1].freeTierNote.checkedOn;
  assert.ok(checkProviderCatalog(nodate).some((m) => m.includes('check date')));
});

test('the generated blocks contain every secret and every value in .env.example is empty', () => {
  const catalog = readCatalog(root.replace(/\/$/, ''));
  const block = envExampleBlock(catalog);
  for (const name of allSecretNames()) assert.match(block, new RegExp(`^${name}=$`, 'm'));
});

test('the key hint is a soft check: a mismatch gives text, a match gives null, no hint gives null', () => {
  assert.equal(keyHintWarning('groq', 'gsk_abcdef'), null);
  assert.match(keyHintWarning('groq', 'sk-abc'), /gsk_/);
  assert.equal(keyHintWarning('together', 'a'.repeat(64)), null);
  assert.equal(keyHintWarning('custom_1', 'anything'), null);
  assert.equal(keyHintWarning('nope', 'x'), null);
  assert.equal(getCatalogProvider('gemini').validate.auth.name, 'x-goog-api-key');
});

test('every validate route sends the key in a header, never in the query string', () => {
  for (const p of readCatalog(root.replace(/\/$/, '')).providers) {
    if (!p.validate) continue;
    assert.ok(['bearer', 'header'].includes(p.validate.auth.style), p.id);
    assert.ok(!/[?&]key=/.test(p.validate.url), p.id);
  }
});
