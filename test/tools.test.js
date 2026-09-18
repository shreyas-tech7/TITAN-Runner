import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, MAX_TOOL_OUTPUT_CHARS } from '../src/tools/registry.js';
import { builtinTools } from '../src/tools/builtin.js';
import { parseToolCall } from '../src/tools/callParser.js';
import { isPrivateAddress, checkEgress, parseAllowlist } from '../src/tools/ssrf.js';

const AUTONOMOUS = { killSwitch: false, safeMode: false, autonomy: 'autonomous' };

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'titan-tools-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Hello\nA readme with the word needle in it.\n');
  writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1; // needle\n');
  writeFileSync(join(root, '.git', 'config'), '[core]\n');
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'needle');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, 'package.json'), '{"name":"x"}');
  return root;
}

function registryFor(root, extra = {}) {
  const r = new ToolRegistry();
  for (const def of builtinTools({ repoRoot: root, workspaceRoot: join(root, '_ws'), ...extra })) r.register(def);
  return r;
}

test('parseToolCall accepts exactly one fenced {tool,args} block and nothing else', () => {
  assert.deepEqual(parseToolCall('```json\n{"tool":"repo_read_file","args":{"path":"README.md"}}\n```'), { tool: 'repo_read_file', args: { path: 'README.md' } });
  assert.deepEqual(parseToolCall('{"tool":"repo_list_files"}'), { tool: 'repo_list_files', args: {} });
  assert.equal(parseToolCall('Here is my answer.\n```json\n{"tool":"repo_read_file","args":{}}\n```'), null, 'prose around it is an answer');
  assert.equal(parseToolCall('```json\n{"files":[{"path":"a","content":"b"}]}\n```'), null, 'a files envelope is not a call');
  assert.equal(parseToolCall('```json\n{"tool":"Bad Name!","args":{}}\n```'), null);
  assert.equal(parseToolCall('```json\n{"tool":"x","args":[1]}\n```'), null);
  assert.equal(parseToolCall('plain prose'), null);
  assert.equal(parseToolCall(''), null);
});

test('registry: unknown tool, invalid args, and a destructive pattern are refused before anything runs; output is capped and redacted', async () => {
  const root = repo();
  try {
    const r = registryFor(root);
    r.register({ id: 'big', description: 'big output', effect: 'read', schema: { type: 'object' }, run: async () => 'word '.repeat(MAX_TOOL_OUTPUT_CHARS / 5 + 500) });
    r.register({ id: 'leaky', description: 'leaks', effect: 'read', schema: { type: 'object' }, run: async () => 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab here' });
    const ctx = { control: AUTONOMOUS, task: {}, taskId: 't1' };
    assert.equal((await r.invoke({ tool: 'nope', args: {} }, ctx)).error.code, 'TOOL_UNKNOWN');
    assert.equal((await r.invoke({ tool: 'repo_read_file', args: { nope: 1 } }, ctx)).error.code, 'TOOL_INVALID_ARGS');
    assert.equal((await r.invoke({ tool: 'repo_read_file', args: { path: 42 } }, ctx)).error.code, 'TOOL_INVALID_ARGS');
    const destructive = await r.invoke({ tool: 'workspace_write', args: { path: 'notes.txt', content: 'run rm -rf / now' } }, ctx);
    assert.equal(destructive.error.code, 'TOOL_DENIED');
    assert.match(destructive.error.message, /reviewer gate/);
    const big = await r.invoke({ tool: 'big', args: {} }, ctx);
    assert.ok(big.ok && big.output.length < MAX_TOOL_OUTPUT_CHARS + 100 && big.output.includes('[truncated'));
    const leaky = await r.invoke({ tool: 'leaky', args: {} }, ctx);
    assert.ok(!leaky.output.includes('ghp_ABCDEFGHIJ'), leaky.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry: policy gates by effect and autonomy, approval parks with a key, and a non-idempotent effect is replayed from the ledger', async () => {
  const root = repo();
  try {
    const r = registryFor(root);
    let runs = 0;
    r.register({ id: 'send_thing', description: 'external, not idempotent', effect: 'external', idempotent: false, schema: { type: 'object' }, run: async () => { runs += 1; return `sent #${runs}`; } });
    const ledger = {};
    const events = [];
    const ev = { append: (type, data) => events.push({ type, ...data }) };
    const dry = await r.invoke({ tool: 'send_thing', args: { to: 'x' } }, { control: { ...AUTONOMOUS, autonomy: 'dry-run' }, task: {}, ledger, events: ev });
    assert.equal(dry.error.code, 'TOOL_DENIED');
    const gated = await r.invoke({ tool: 'send_thing', args: { to: 'x' } }, { control: { ...AUTONOMOUS, autonomy: 'propose' }, task: {}, ledger, events: ev });
    assert.equal(gated.error.code, 'APPROVAL_REQUIRED');
    assert.match(gated.error.approvalKey, /^tool:send_thing:[0-9a-f]{8}$/);
    assert.equal(runs, 0);
    const approved = await r.invoke({ tool: 'send_thing', args: { to: 'x' } }, { control: { ...AUTONOMOUS, autonomy: 'propose' }, task: { approvals: { [gated.error.approvalKey]: { decision: 'approved', by: 'owner' } } }, ledger, events: ev });
    assert.ok(approved.ok);
    assert.equal(runs, 1);
    const again = await r.invoke({ tool: 'send_thing', args: { to: 'x' } }, { control: AUTONOMOUS, task: {}, ledger, events: ev });
    assert.ok(again.ok && again.cached, 'replayed, not re-sent');
    assert.equal(runs, 1);
    assert.ok(events.some((e) => e.type === 'policy.decision' && e.outcome === 'approve' && e.audit));
    assert.ok(events.some((e) => e.type === 'tool.call' && e.outcome === 'replayed'));
    const read = await r.invoke({ tool: 'repo_read_file', args: { path: 'README.md' } }, { control: { ...AUTONOMOUS, autonomy: 'dry-run' }, task: {} });
    assert.ok(read.ok, 'reads are allowed even in dry-run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry: a tool that hangs is timed out and reported as a tool_error', async () => {
  const r = new ToolRegistry();
  r.register({ id: 'slow', description: 'hangs', effect: 'read', timeoutMs: 30, schema: { type: 'object' }, run: () => new Promise(() => {}) });
  const res = await r.invoke({ tool: 'slow', args: {} }, { control: AUTONOMOUS });
  assert.equal(res.error.code, 'TOOL_TIMEOUT');
  assert.equal(res.error.class, 'tool_error');
});

test('repo_read_file / repo_list_files / repo_search are jailed to the checkout: no .git, node_modules, .env, traversal, or symlink escape', async () => {
  const root = repo();
  const outside = mkdtempSync(join(tmpdir(), 'titan-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(outside, join(root, 'link'));
    const r = registryFor(root);
    const ctx = { control: AUTONOMOUS, task: {} };
    const ok = await r.invoke({ tool: 'repo_read_file', args: { path: 'README.md' } }, ctx);
    assert.ok(ok.ok && ok.output.includes('# Hello'));
    assert.ok((await r.invoke({ tool: 'repo_read_file', args: { path: 'package.json' } }, ctx)).ok, 'manifests may be read');
    for (const bad of ['.git/config', 'node_modules/x/index.js', '.env', '../etc/passwd', 'link/secret.txt', '/etc/passwd', 'src/../../x']) {
      const res = await r.invoke({ tool: 'repo_read_file', args: { path: bad } }, ctx);
      assert.equal(res.ok, false, bad);
      assert.match(res.error.message, /refused|no such/, bad);
    }
    const list = await r.invoke({ tool: 'repo_list_files', args: {} }, ctx);
    assert.ok(list.ok && list.output.includes('src/a.js') && !list.output.includes('node_modules') && !list.output.includes('.git/'));
    const search = await r.invoke({ tool: 'repo_search', args: { query: 'needle' } }, ctx);
    assert.ok(search.ok && search.output.includes('README.md:2') && search.output.includes('src/a.js:1') && !search.output.includes('node_modules'), search.output);
    const rx = await r.invoke({ tool: 'repo_search', args: { query: 'export const \\w+', regex: true, glob: '*.js' } }, ctx);
    assert.ok(rx.ok && rx.output.includes('src/a.js') && !rx.output.includes('README'), rx.output);
    const badRx = await r.invoke({ tool: 'repo_search', args: { query: '(', regex: true } }, ctx);
    assert.equal(badRx.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace_write lands in the task workspace under the state dir, never in the checkout, and is jailed too', async () => {
  const root = repo();
  try {
    const r = registryFor(root);
    const ctx = { control: AUTONOMOUS, task: {}, taskId: 'issue-7' };
    const res = await r.invoke({ tool: 'workspace_write', args: { path: 'notes/draft.md', content: 'hello' } }, ctx);
    assert.ok(res.ok, res.error?.message);
    assert.equal(readFileSync(join(root, '_ws', 'issue-7', 'notes', 'draft.md'), 'utf8'), 'hello');
    assert.equal(existsSync(join(root, 'notes')), false);
    const esc = await r.invoke({ tool: 'workspace_write', args: { path: '../../README.md', content: 'pwned' } }, ctx);
    assert.equal(esc.ok, false);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8').includes('pwned'), false);
    const denied = await r.invoke({ tool: 'workspace_write', args: { path: 'x.txt', content: 'x' } }, { control: { ...AUTONOMOUS, autonomy: 'dry-run' }, task: {}, taskId: 'issue-7' });
    assert.equal(denied.error.code, 'TOOL_DENIED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SSRF guard: private, loopback, link-local, CGNAT, mapped, and multicast addresses are all non-public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('SSRF guard: https only, allowlist required, DNS resolved and checked, redirects refused', async () => {
  const lookups = { 'api.example.com': [{ address: '93.184.216.34' }], 'evil.example.com': [{ address: '93.184.216.34' }, { address: '10.0.0.5' }], 'meta.example.com': [{ address: '169.254.169.254' }] };
  const lookup = async (host) => { if (!lookups[host]) throw new Error('ENOTFOUND'); return lookups[host]; };
  const allowlist = parseAllowlist('api.example.com, .example.com');
  assert.equal((await checkEgress('http://api.example.com/x', { allowlist, lookup })).ok, false);
  assert.match((await checkEgress('https://user:pw@api.example.com/x', { allowlist, lookup })).reason, /credentials/);
  assert.match((await checkEgress('https://93.184.216.34/x', { allowlist, lookup })).reason, /literal IP/);
  assert.match((await checkEgress('https://other.org/x', { allowlist, lookup })).reason, /allowlist/);
  assert.match((await checkEgress('https://evil.example.com/x', { allowlist, lookup })).reason, /non-public/);
  assert.match((await checkEgress('https://meta.example.com/latest', { allowlist, lookup })).reason, /non-public/);
  assert.match((await checkEgress('https://gone.example.com/x', { allowlist, lookup })).reason, /resolve/);
  assert.equal((await checkEgress('https://api.example.com/x', { allowlist: [], lookup })).ok, false, 'empty allowlist allows nothing');
  const ok = await checkEgress('https://api.example.com/x?y=1', { allowlist, lookup });
  assert.ok(ok.ok && ok.addresses[0] === '93.184.216.34');

  const root = repo();
  try {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, redirect: init.redirect });
      if (url.includes('/redirect')) return { status: 302, ok: false, text: async () => '' };
      return { status: 200, ok: true, text: async () => 'body '.repeat(20_000) };
    };
    const r = registryFor(root, { allowlist, lookup, fetchImpl });
    const ctx = { control: AUTONOMOUS, task: {} };
    const got = await r.invoke({ tool: 'http_fetch', args: { url: 'https://api.example.com/data' } }, ctx);
    assert.ok(got.ok && got.output.includes('[truncated'), got.error?.message);
    assert.equal(calls[0].redirect, 'manual');
    const redirected = await r.invoke({ tool: 'http_fetch', args: { url: 'https://api.example.com/redirect' } }, ctx);
    assert.equal(redirected.ok, false);
    assert.match(redirected.error.message, /redirect/);
    const blocked = await r.invoke({ tool: 'http_fetch', args: { url: 'https://meta.example.com/latest' } }, ctx);
    assert.equal(blocked.ok, false);
    assert.equal(calls.length, 2, 'the blocked URL was never fetched');
    const safe = await r.invoke({ tool: 'http_fetch', args: { url: 'https://api.example.com/data' } }, { control: { ...AUTONOMOUS, safeMode: true }, task: {} });
    assert.equal(safe.error.code, 'TOOL_DENIED', 'safe mode: no external effects');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
