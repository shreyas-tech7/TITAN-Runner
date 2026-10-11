/**
 * RT3: nothing writes to GitHub except through the Reviewer Gate.
 *
 * The runner side of the gate is `src/reviewer/githubGate.js`. The Worker side is `worker/src/lib/githubGate.js`.
 * This test reads the source and fails when a file outside the gate sends a write: a REST call with a write
 * method, a `git push`, a `git commit`, or a `repository_dispatch`. A new write path must go through the gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createGitHubClient } from '../src/github.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['src', 'scripts', 'bin', 'worker/src'];
const GATE_FILES = new Set([
  'src/reviewer/githubGate.js',
  'src/reviewer/githubGatePolicy.js',
  'worker/src/lib/githubGate.js',
]);
/** Generated or data files. They hold manifests, not code that sends a request. */
const SKIP = new Set(['worker/src/connectors.generated.js', 'worker/src/migrations.generated.js']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'fakes') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(m?js)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source text without comments, so a comment about `git push` does not count. */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

const FILES = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
  .map((f) => ({ abs: f, rel: relative(ROOT, f).replaceAll('\\', '/') }))
  .filter((f) => !GATE_FILES.has(f.rel) && !SKIP.has(f.rel));

test('the scan sees the source tree', () => {
  assert.ok(FILES.length > 100, `scanned ${FILES.length} files`);
});

test('no file outside the gate runs git push, git commit, git commit-tree, or git tag', () => {
  const bad = [];
  for (const f of FILES) {
    const text = code(f.abs);
    // Plain shell text.
    if (/\bgit\s+(push|commit|tag)\b/.test(text)) bad.push(`${f.rel}: shell text`);
    // An argument vector that holds a write verb. Only arrays that go to git count: the first argument of
    // execFile or spawn, or the argument of a `git(` helper.
    const calls = [
      ...text.matchAll(/(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"`]git['"`]\s*,\s*\[([^\]]{0,300})\]/g),
      ...text.matchAll(/\bgit\(\s*\[([^\]]{0,300})\]/g),
    ];
    for (const m of calls) {
      const items = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
      if (items.some((i) => ['push', 'commit', 'commit-tree', 'tag'].includes(i))) bad.push(`${f.rel}: argv ${JSON.stringify(items.slice(0, 5))}`);
    }
  }
  assert.deepEqual(bad, [], 'route these through gatedCommit and gatedPush in src/reviewer/githubGate.js');
});

test('no file outside the gate sends a write to the GitHub REST API', () => {
  const bad = [];
  for (const f of FILES) {
    const text = code(f.abs);
    const talksToGithub = /api\.github\.com|\/repos\/\$\{|github\.com\/repos/.test(text);
    if (talksToGithub && /method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test(text)) bad.push(`${f.rel}: a write method next to a GitHub URL`);
    if (/\/dispatches\b|repository_dispatch\b|actions\/secrets\//.test(text) && !['worker/src/lib/github.js'].includes(f.rel)) bad.push(`${f.rel}: dispatch or secret path`);
  }
  assert.deepEqual(bad, [], 'route these through createRestWriter in src/reviewer/githubGate.js');
});

test('src/github.js sends reads itself and hands every write to the gate', () => {
  const text = code(join(ROOT, 'src/github.js'));
  const call = text.slice(text.indexOf('async function call('), text.indexOf('async function listOpenTaskIssues'));
  assert.ok(call.includes("if (method !== 'GET') return write(method, path, body);"));
  assert.ok(call.indexOf("return write(") < call.indexOf('fetchImpl('), 'the gate branch comes before the read fetch');
  assert.equal((text.match(/fetchImpl\(/g) ?? []).length, 1, 'one direct fetch, and it is the read');
  assert.ok(!/headers:[^}]*content-type/i.test(call), 'the read fetch carries no body type');
});

test('the default client blocks a write that breaks a rule, and never calls fetch for it', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body });
    return new Response(JSON.stringify({ number: 1, html_url: 'x' }), { status: 201 });
  };
  const client = createGitHubClient({ token: 't', repository: 'owner/repo', fetchImpl });
  await assert.rejects(() => client.createPullRequest({ title: 't', head: 'feature', base: 'main', draft: false }), /Reviewer Gate/);
  await assert.rejects(() => client.createIssue('t', 'b', ['bug']), /Reviewer Gate/);
  await assert.rejects(() => client.addLabels(1, ['wontfix']), /Reviewer Gate/);
  await assert.rejects(() => client.removeLabel(1, 'security'), /Reviewer Gate/);
  assert.equal(sent.length, 0, 'nothing left the machine');
  await client.addLabels(1, ['titan-ignored']);
  await client.removeLabel(1, 'titan-task');
  await client.closeIssue(2);
  assert.deepEqual(sent.map((s) => s.method), ['POST', 'DELETE', 'PATCH']);
});

test('the GitHub workflows of the repo do not call the GitHub write API with a shell tool', () => {
  const dir = join(ROOT, '.github/workflows');
  const bad = [];
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (/\bgh\s+(issue|pr|release|repo)\s+(create|comment|close|edit|merge|delete)\b|\bgh\s+api\b[^\n]*(-X|--method)\s*(POST|PUT|PATCH|DELETE)/.test(text)) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
