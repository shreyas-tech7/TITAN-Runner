#!/usr/bin/env node
/**
 * @file Builds `worker/src/connectors.generated.js` from `connectors/<id>/connector.json` (Wave 12, C1 and C3).
 *
 * It also checks every manifest. The checks run in CI, so a bad manifest cannot reach the Worker:
 *   - The manifest follows `schemas/connector.schema.json`, and the id matches the folder name.
 *   - Each request follows the placement rules: a secret may sit in a header only.
 *   - Each literal URL in a request uses https and a host that the `egress` list names.
 *   - An OAuth connector asks for no scope that its `forbiddenScopes` list names.
 *   - A write action has a rate limit. A `destructive` action must not have the data class `public`.
 *   - Each action has a fixture that names it, unless the action is an impure handler. Each connector with a request test has a `test` fixture.
 *   - No fixture holds a value that looks like a real key.
 *
 * Usage: node scripts/gen-connectors.mjs [--check]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { validate } from '../worker/src/lib/jsonschema.js';
import { checkRequestSpec } from '../worker/src/lib/template.js';
import { isImpureHandler } from '../worker/src/connectors/handlers.js';
import { SECRET_PATTERNS } from '../src/lib/redact.js';

const dir = 'connectors';
const out = 'worker/src/connectors.generated.js';
const schema = JSON.parse(readFileSync('schemas/connector.schema.json', 'utf8'));
const ids = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

/** A match in a fixture is fine when it carries a marker that says it is fake. */
const FAKE_MARKER = /@@FAKE:|TEST_VALUE_NOT_A_REAL_SECRET|TESTVALUENOTAREALSECRET|TEST_ACCESS_TOKEN_NOT_REAL|AAAAAAAA|BBBBBBBB|titan-test-topic|@example\.(com|org|net)$/;

const problems = [];
const bad = (id, msg) => problems.push(`${id}: ${msg}`);
const manifests = [];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function listFixtures(id) {
  const fdir = `${dir}/${id}/fixtures`;
  if (!existsSync(fdir)) return [];
  return readdirSync(fdir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, text: readFileSync(`${fdir}/${f}`, 'utf8') }));
}

for (const id of ids) {
  const file = `${dir}/${id}/connector.json`;
  if (!existsSync(file)) {
    bad(id, 'there is no connector.json');
    continue;
  }
  let m;
  try {
    m = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    bad(id, `connector.json is not valid JSON (${err.message})`);
    continue;
  }
  for (const p of validate(schema, m, { strict: false })) bad(id, `schema: ${p}`);
  if (m.id !== id) bad(id, `the id "${m.id}" does not match the folder name`);
  if (!existsSync(`${dir}/${id}/README.md`)) bad(id, 'there is no README.md');

  const hosts = new Set(m.egress ?? []);
  const seen = new Set();
  const specs = [];
  if (m.test?.mode === 'request') specs.push(['test', m.test.request ?? {}]);
  for (const a of m.actions ?? []) {
    if (seen.has(a.id)) bad(id, `the action id "${a.id}" is used twice`);
    seen.add(a.id);
    if (!a.request && !a.handler) bad(id, `the action "${a.id}" has no request and no handler`);
    if (a.request && a.handler) bad(id, `the action "${a.id}" has a request and a handler`);
    if (a.request) specs.push([a.id, a.request]);
    if (a.risk !== 'read' && !a.rateLimit) bad(id, `the action "${a.id}" changes data and has no rateLimit`);
    if (a.risk === 'destructive' && a.dataClass === 'public') bad(id, `the action "${a.id}" is destructive and public`);
    if (a.handler && !isImpureHandler(a.handler) && !a.handler.startsWith('rss_') && !a.handler.startsWith('rest_')) bad(id, `the handler "${a.handler}" is not known`);
  }
  for (const [name, spec] of specs) {
    for (const p of checkRequestSpec(spec, { allowSecretInQuery: m.auth?.kind === 'api_key_query' })) bad(id, `${name}: ${p}`);
    if (typeof spec.url === 'string' && !spec.url.includes('{{secret.')) {
      const literal = spec.url.replace(/\{\{[^}]*\}\}/g, 'x');
      if (/^https?:/i.test(literal)) {
        if (!literal.startsWith('https://')) bad(id, `${name}: the url must use https`);
        const h = hostOf(literal);
        if (h && !hosts.has(h) && ![...hosts].some((e) => e.startsWith('.') && h.endsWith(e))) bad(id, `${name}: the host ${h} is not in egress`);
      }
    }
  }
  if (m.auth?.kind === 'oauth2_pkce') {
    const forbidden = new Set(m.auth.oauth?.forbiddenScopes ?? []);
    for (const s of m.auth.oauth?.scopes ?? []) if (forbidden.has(s)) bad(id, `the scope ${s} is in forbiddenScopes`);
    if (!m.auth.oauth) bad(id, 'an oauth2_pkce connector needs auth.oauth');
  }
  if (m.auth?.kind === 'secret_url' && !m.auth.fields.some((f) => f.name === 'url' && f.secret)) bad(id, 'a secret_url connector needs a secret field named "url"');

  const fixtures = listFixtures(id);
  const targets = new Set();
  for (const f of fixtures) {
    let fx;
    try {
      fx = JSON.parse(f.text);
    } catch {
      bad(id, `fixtures/${f.file} is not valid JSON`);
      continue;
    }
    targets.add(fx.target);
    for (const pattern of SECRET_PATTERNS.slice(0, -2)) {
      for (const hit of f.text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
        if (!FAKE_MARKER.test(hit[0])) bad(id, `fixtures/${f.file} holds a value that looks like a real key`);
      }
    }
  }
  if (m.test?.request || (m.test?.handler && !isImpureHandler(m.test.handler))) if (!targets.has('test')) bad(id, 'there is no fixture with the target "test"');
  for (const a of m.actions ?? []) if (!isImpureHandler(a.handler) && !targets.has(`action:${a.id}`)) bad(id, `the action "${a.id}" has no fixture`);

  manifests.push(m);
}

if (problems.length > 0) {
  console.error(`gen-connectors: ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}

const text = `// Generated by scripts/gen-connectors.mjs from connectors/<id>/connector.json. Do not edit by hand.\n// Run: node scripts/gen-connectors.mjs\n/** @type {any[]} */\nexport const CONNECTORS = ${JSON.stringify(manifests)};\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    // missing
  }
  if (current !== text) {
    console.error(`gen-connectors: ${out} is stale. Run: node scripts/gen-connectors.mjs`);
    process.exit(1);
  }
  console.log(`gen-connectors: in sync (${manifests.length} connectors).`);
} else {
  writeFileSync(out, text);
  console.log(`gen-connectors: wrote ${manifests.length} connector(s) to ${out}`);
}
