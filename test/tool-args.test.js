/**
 * RT4: a tool call is checked against the schema of the tool before any tool code runs.
 * Each case below lists the bad fields that the error must name. The error names every one of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { builtinTools } from '../src/tools/builtin.js';
import { connectorTools, CONNECTOR_CALL_SCHEMA } from '../src/tools/connectorCall.js';
import { checkToolArgs, describeFields, fieldOf } from '../src/tools/argCheck.js';
import { chatWithConnectors } from '../src/tools/connectorLoop.js';

const AUTONOMOUS = { autonomy: 'autonomous' };

function registry() {
  const root = mkdtempSync(join(tmpdir(), 'titan-args-'));
  const r = new ToolRegistry();
  for (const def of builtinTools({ repoRoot: root, workspaceRoot: join(root, '_ws') })) r.register(def);
  for (const def of connectorTools({})) r.register(def);
  return { r, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// [tool, args, the fields that the error must name (in any order)]
const TABLE = [
  ['repo_read_file', {}, ['path']],
  ['repo_read_file', { path: 42 }, ['path']],
  ['repo_read_file', { path: '' }, ['path']],
  ['repo_read_file', { path: 'x'.repeat(241) }, ['path']],
  ['repo_read_file', { path: 'a', maxBytes: 'big' }, ['maxBytes']],
  ['repo_read_file', { path: 'a', maxBytes: 0 }, ['maxBytes']],
  ['repo_read_file', { path: 'a', maxBytes: 1.5 }, ['maxBytes']],
  ['repo_read_file', { path: 7, maxBytes: 'big', extra: true }, ['path', 'maxBytes', 'extra']],
  ['repo_read_file', { nope: 1 }, ['path', 'nope']],
  ['repo_list_files', { depth: 9 }, ['depth']],
  ['repo_list_files', { depth: 'two', path: 5, other: 1 }, ['depth', 'path', 'other']],
  ['repo_search', {}, ['query']],
  ['repo_search', { query: 'x', regex: 'yes' }, ['regex']],
  ['repo_search', { query: ['a'], path: {}, glob: 3 }, ['query', 'path', 'glob']],
  ['workspace_write', { path: 'a' }, ['content']],
  ['workspace_write', { content: 1 }, ['path', 'content']],
  ['http_fetch', {}, ['url']],
  ['http_fetch', { url: 'x' }, ['url']],
  ['http_fetch', { url: 'https://example.com', headers: { a: 'b' } }, ['headers']],
  ['connector_call', {}, ['connector', 'action']],
  ['connector_call', { connector: 'GitHub', action: 'list-issues' }, ['connector', 'action']],
  ['connector_call', { connector: 'github', action: 'comment', input: 'text' }, ['input']],
  ['connector_call', { connector: 'github', action: 'comment', input: [] }, ['input']],
];

for (const [tool, args, expected] of TABLE) {
  test(`RT4 table: ${tool} ${JSON.stringify(args).slice(0, 60)} names ${expected.join(', ')}`, async () => {
    const { r, cleanup } = registry();
    try {
      let ran = false;
      const def = r.get(tool);
      const original = def.run;
      def.run = async (...a) => { ran = true; return original(...a); };
      const res = await r.invoke({ tool, args }, { control: AUTONOMOUS, task: {}, taskId: 't' });
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'TOOL_INVALID_ARGS');
      assert.equal(ran, false, 'the tool code never ran');
      const named = res.error.fields.map((f) => f.field).sort();
      assert.deepEqual([...new Set(named)].sort(), [...expected].sort());
      for (const field of expected) assert.ok(res.error.message.includes(field), `the message names ${field}: ${res.error.message}`);
    } finally {
      cleanup();
    }
  });
}

test('RT4: an unknown tool fails early, names the field tool, and lists the tools that exist', async () => {
  const { r, cleanup } = registry();
  try {
    for (const name of ['nope', 'rm_rf', 'REPO_READ_FILE', '', undefined, 42, null]) {
      const res = await r.invoke({ tool: name, args: {} }, { control: AUTONOMOUS, task: {} });
      assert.equal(res.error.code, 'TOOL_UNKNOWN', String(name));
      assert.deepEqual(res.error.fields.map((f) => f.field), ['tool']);
      assert.match(res.error.message, /repo_read_file/);
    }
    const long = await r.invoke({ tool: 'x'.repeat(500), args: {} }, { control: AUTONOMOUS, task: {} });
    assert.ok(long.error.message.length < 400, 'a long name is cut');
  } finally {
    cleanup();
  }
});

test('RT4: args that is not an object is one error on the field args, and a missing args means an empty object', async () => {
  const { r, cleanup } = registry();
  try {
    for (const bad of ['text', 5, true, null, ['a'], [{ path: 'x' }]]) {
      const res = await r.invoke({ tool: 'repo_read_file', args: bad }, { control: AUTONOMOUS, task: {} });
      assert.equal(res.error.code, 'TOOL_INVALID_ARGS', JSON.stringify(bad));
      assert.deepEqual(res.error.fields.map((f) => f.field), ['args']);
    }
    const missing = await r.invoke({ tool: 'repo_read_file' }, { control: AUTONOMOUS, task: {} });
    assert.deepEqual(missing.error.fields.map((f) => f.field), ['path']);
  } finally {
    cleanup();
  }
});

test('RT4: every bad field is named, with no cut at three', async () => {
  const r = new ToolRegistry();
  const props = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, { type: 'integer' }]));
  r.register({ id: 'wide_tool', description: 'many fields', effect: 'read', schema: { type: 'object', properties: props }, run: async () => 'ok' });
  const args = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, 'text']));
  const res = await r.invoke({ tool: 'wide_tool', args }, { control: AUTONOMOUS, task: {} });
  assert.equal(res.error.fields.length, 8);
  for (let i = 0; i < 8; i += 1) assert.ok(res.error.message.includes(`f${i}`));
});

test('RT4: a schema with no additionalProperties rejects undeclared fields. additionalProperties true allows them', async () => {
  const r = new ToolRegistry();
  r.register({ id: 'strict_tool', description: 'x', effect: 'read', schema: { type: 'object', properties: { a: { type: 'string' } } }, run: async () => 'ok' });
  r.register({ id: 'open_tool', description: 'x', effect: 'read', schema: { type: 'object', additionalProperties: true }, run: async () => 'ok' });
  const strict = await r.invoke({ tool: 'strict_tool', args: { a: 'x', b: 1 } }, { control: AUTONOMOUS, task: {} });
  assert.deepEqual(strict.error.fields.map((f) => f.field), ['b']);
  const open = await r.invoke({ tool: 'open_tool', args: { anything: 1 } }, { control: AUTONOMOUS, task: {} });
  assert.ok(open.ok);
});

test('RT4: a valid call still runs', async () => {
  const { r, cleanup } = registry();
  try {
    const res = await r.invoke({ tool: 'repo_list_files', args: { depth: 1 } }, { control: AUTONOMOUS, task: {} });
    assert.ok(res.ok, JSON.stringify(res.error));
  } finally {
    cleanup();
  }
});

test('RT4: fieldOf and describeFields', () => {
  assert.equal(fieldOf('$'), 'args');
  assert.equal(fieldOf('$.input.items[2]'), 'input.items[2]');
  const bad = checkToolArgs({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, { b: 1 });
  assert.equal(describeFields(bad.fields), 'a: required; b: unexpected property');
});

test('RT4: the connector tool loop checks the arguments before it asks the broker, and names each bad field', async () => {
  let brokerCalls = 0;
  const texts = [
    '```json\n{"tool":"connector_call","args":{"connector":"GitHub","action":"x","extra":1}}\n```',
    'I could not call it.',
  ];
  const seen = [];
  const chat = async (messages) => {
    seen.push(messages.at(-1).content);
    return { text: texts.shift(), tokensUsed: 1 };
  };
  const out = await chatWithConnectors([{ role: 'user', content: 'go' }], 'groq', {
    chat,
    describe: async () => '- github: comment [write]',
    review: async () => ({ verdict: 'allow' }),
    call: async () => { brokerCalls += 1; return { text: 'sent' }; },
  });
  assert.equal(brokerCalls, 0, 'the broker was never asked');
  assert.equal(out.text, 'I could not call it.');
  const feedback = seen.at(-1);
  assert.match(feedback, /invalid arguments/);
  for (const field of ['connector', 'action', 'extra']) assert.ok(feedback.includes(field), `names ${field}: ${feedback}`);
  assert.ok(CONNECTOR_CALL_SCHEMA.additionalProperties === false);
});
