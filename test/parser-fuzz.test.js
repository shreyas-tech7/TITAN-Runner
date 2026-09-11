import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Roadmap G1: the parsers that consume adversarial MODEL text (and issue
 * bodies) must never hang, throw, or emit pathologically wrong output. This
 * is a deterministic, dependency-free fuzz harness — a seeded PRNG plus a
 * corpus of hostile-but-realistic shapes — so every run is reproducible and
 * the whole file stays fast.
 *
 * The invariant is not "correct parse of garbage" (there is no such thing);
 * it is: every call terminates, never throws, and returns a well-shaped
 * result for any input the model could emit.
 */

import { parseTaskOutput, parseEnvelope, extractFileBlocks, normalizePath } from '../src/orchestrator/outputParser.js';
import { tryStrictJson, tryLenientJson, extractBalancedObject, stripTrailingCommas } from '../src/lib/jsonRepair.js';
import { parseTaskYaml } from '../src/lib/taskYaml.js';
import { parseProbeJson } from '../src/orchestrator/capabilityRegistry.js';
import { validateTaskGraph } from '../src/orchestrator/decomposer.js';
import { topoOrder } from '../src/orchestrator/synthesizer.js';

/* ---- deterministic PRNG (mulberry32) ------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0xC0FFEE);
const randInt = (max) => Math.floor(rand() * max);
const pick = (arr) => arr[randInt(arr.length)];

/** Printable + the interesting control/edge bytes a model can emit. */
const ALPHABET = Array.from(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}[]():"\',./\\`-_=+| \n\t\r*#;%&<>!?@$\u0000\u0008\u001f\u007f\u2028\u2029',
);

function randomString(maxLen = 120) {
  const len = randInt(maxLen + 1);
  let out = '';
  for (let i = 0; i < len; i += 1) out += pick(ALPHABET);
  return out;
}

/* ---- seed corpus: strings shaped like what models actually emit ----------- */

const SEEDS = [
  '{"files":[{"path":"a.js","content":"console.log(1)"}],"notes":"done"}',
  '```json\n{"files":[{"path":"src/a.js","content":"x"}],"notes":"ok"}\n```',
  'Sure! Here is the JSON you asked for:\n{"files": [{"path": "b.py", "content": "print(1)"},]}',
  '```\n// file: src/index.js\nconst x = 1;\n```',
  '```python\n# file: main.py\nprint("hi")\n```',
  '<!-- titan-task-v1\ntitle: "Build a thing"\ndescription: |\n  Do the thing\n  carefully\npriority: high\nroutingHint: careful\n-->',
  '{"tasks":[{"id":"a","title":"A","aspect":"architecture","description":"x","dependsOn":[],"estimatedComplexity":"low","deliverable":"y"}]}',
  '{"strengths":["code-generation"],"weaknesses":[],"latencyClass":"fast","contextWindow":4096}',
  '{"a":1,"b":[2,{"c":3}]}',
  '```json\n{"pass": true, "issues": []}\n```',
  '[{"path":"../../etc/passwd","content":"secret"}]',
  'line one\nline two\nline three',
];

function truncations(seed) {
  const out = [];
  for (let i = 0; i < seed.length; i += 3) out.push(seed.slice(0, i));
  out.push(seed.slice(0, Math.floor(seed.length / 2)));
  out.push(seed.slice(-Math.floor(seed.length / 2)));
  return out;
}

/* ---- shared well-shapedness checks --------------------------------------- */

function assertSafeObject(value, label) {
  assert.ok(value !== null && typeof value === 'object', `${label}: should return an object`);
}

/* ---- the fuzz corpus ------------------------------------------------------ */

const inputs = [];
for (const seed of SEEDS) inputs.push(...truncations(seed));
for (let i = 0; i < 400; i += 1) inputs.push(randomString(randInt(200) + 1));
// Deterministic structural nasties: nesting, unbalanced brackets, lone surrogates.
inputs.push('{"a":'.repeat(80), '['.repeat(50), '}'.repeat(50), ']'.repeat(50));
inputs.push('\uD800', '\uDC00', '"unterminated', "'unterminated", '/* unterminated');
inputs.push('{"files": [{"path": "a", "content": "'.repeat(20));
inputs.push('\n'.repeat(100), '\t'.repeat(100), '\u0000'.repeat(64));

test('G1: every parser terminates, never throws, and returns a well-shaped result over the fuzz corpus', async () => {
  for (const input of inputs) {
    // outputParser — async three-tier parse.
    const parsed = await parseTaskOutput(input);
    assertSafeObject(parsed, 'parseTaskOutput');
    assert.ok([1, 2, 3, null].includes(parsed.tier), 'parseTaskOutput tier');
    assert.ok(Array.isArray(parsed.files), 'parseTaskOutput files');
    assert.equal(typeof parsed.malformed, 'boolean', 'parseTaskOutput malformed');

    // outputParser — sync two-tier parse.
    const env = parseEnvelope(input);
    assertSafeObject(env, 'parseEnvelope');
    assert.ok(Array.isArray(env.files), 'parseEnvelope files');

    // legacy file-block extractor.
    const blocks = extractFileBlocks(input);
    assert.ok(Array.isArray(blocks), 'extractFileBlocks');
    for (const b of blocks) {
      assert.equal(typeof b.path, 'string', 'block path');
      assert.equal(typeof b.content, 'string', 'block content');
    }

    // path normalisation — never empty, never escapes.
    const path = normalizePath(input);
    assert.equal(typeof path, 'string', 'normalizePath type');
    assert.ok(path.length > 0, 'normalizePath never empty');
    assert.ok(!path.startsWith('/'), 'normalizePath no absolute');
    assert.ok(!path.split('/').includes('..'), 'normalizePath no parent traversal');

    // jsonRepair primitives.
    assert.equal(typeof stripTrailingCommas(input), 'string', 'stripTrailingCommas');
    const balanced = extractBalancedObject(input, 0);
    assert.ok(balanced === null || typeof balanced === 'string', 'extractBalancedObject');
    const coerce = (v) => (v && typeof v === 'object' ? v : null);
    const strict = tryStrictJson(input, coerce);
    assert.ok(strict === null || typeof strict === 'object', 'tryStrictJson');
    const lenient = tryLenientJson(input, coerce);
    assert.ok(lenient === null || typeof lenient === 'object', 'tryLenientJson');

    // task YAML (issue body) — null or an object.
    const yaml = parseTaskYaml(input);
    assert.ok(yaml === null || typeof yaml === 'object', 'parseTaskYaml');

    // probe JSON (capability registry) — null or any JSON value (a bare
    // number/string in the input parses to that primitive; callers re-check
    // `typeof === 'object'` themselves).
    const probe = parseProbeJson(input);
    assert.ok(
      probe === null || typeof probe === 'object' || typeof probe === 'string' || typeof probe === 'number' || typeof probe === 'boolean',
      'parseProbeJson',
    );

    // graph validator — {ok, errors[]} for anything, including non-arrays.
    const graph = validateTaskGraph(input, 8);
    assertSafeObject(graph, 'validateTaskGraph');
    assert.equal(typeof graph.ok, 'boolean', 'validateTaskGraph ok');
    assert.ok(Array.isArray(graph.errors), 'validateTaskGraph errors');
  }
});

test('G1: validateTaskGraph and topoOrder handle non-array and hostile graph shapes', () => {
  assert.equal(validateTaskGraph(null, 8).ok, false);
  assert.equal(validateTaskGraph('nope', 8).ok, false);
  assert.equal(validateTaskGraph(undefined, 8).ok, false);
  assert.deepEqual(validateTaskGraph([], 8).errors, ['"tasks" must be a non-empty array']);

  // topoOrder's contract is an array of task-like objects; fuzz that shape.
  for (let i = 0; i < 200; i += 1) {
    const n = randInt(8);
    const tasks = [];
    for (let j = 0; j < n; j += 1) {
      tasks.push({ id: `t${j}`, dependsOn: Array.from({ length: randInt(3) }, () => `t${randInt(n)}`) });
    }
    const ordered = topoOrder(tasks);
    assert.ok(Array.isArray(ordered), 'topoOrder array');
    assert.equal(ordered.length, n, 'topoOrder preserves every node');
    // Every node appears exactly once (termination + no silent loss).
    const ids = ordered.map((t) => t.id).sort();
    assert.deepEqual(ids, tasks.map((t) => t.id).sort(), 'topoOrder node set');
  }
});

test('G1: known-hostile inputs are neutralised, not crashed', async () => {
  // Path traversal must never escape normalisation.
  assert.ok(!normalizePath('../../etc/passwd').split('/').includes('..'));
  assert.equal(normalizePath(''), 'untitled-file.txt');

  // A deeply-nested object must parse or be declined, never overflow.
  const deep = '{"a":'.repeat(2000) + '1' + '}'.repeat(2000);
  const parsed = await parseTaskOutput(deep);
  assertSafeObject(parsed, 'deep parseTaskOutput');
});
