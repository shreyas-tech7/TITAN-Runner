import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdown, changedLinesFromDiff, checkSentence, proseBlocks, splitSentences, stripInline } from '../scripts/check-ste.mjs';

test('stripInline removes code, links, and URLs but keeps the words', () => {
  assert.equal(stripInline('Run `npm test` and read [the docs](https://example.com/x) at https://example.com/y.'), 'Run X and read the docs at URL.');
});

test('splitSentences does not split file names or version numbers', () => {
  assert.deepEqual(splitSentences('Open file.md now. Then read v1.2 notes.'), ['Open file.md now.', 'Then read v1.2 notes.']);
});

test('an em dash and a semicolon are hard failures', () => {
  assert.deepEqual(checkSentence('The Worker saves the key — then it stops.', 'paragraph').hard, ['em dash']);
  assert.deepEqual(checkSentence('Save the key; then stop.', 'paragraph').hard, ['semicolon']);
  assert.deepEqual(checkSentence('Save the key.', 'paragraph').hard, []);
});

test('soft rules: long step, -ing form, contraction, passive, en dash', () => {
  const longStep = Array.from({ length: 21 }, () => 'word').join(' ');
  assert.ok(checkSentence(longStep, 'step').soft.some((m) => m.includes('limit 20')));
  assert.equal(checkSentence(longStep, 'paragraph').soft.length, 0, 'a description may use 25 words');
  assert.ok(checkSentence('The Worker is checking the key.', 'paragraph').soft.some((m) => m.includes('-ing')));
  assert.ok(checkSentence("Don't forget the token.", 'paragraph').soft.includes('contraction'));
  assert.ok(checkSentence('The key is validated by the Worker.', 'paragraph').soft.includes('passive voice'));
  assert.ok(checkSentence('Use A – B.', 'paragraph').soft.includes('en dash'));
  assert.equal(checkSentence("The Worker's key is stored in GitHub.", 'paragraph').soft.includes('contraction'), false, 'a possessive is not a contraction');
});

test('code blocks, tables, quotes, comments, and front matter are skipped', () => {
  const md = ['---', 'title: x; y', '---', '```', 'a; b — c', '```', '| a; b | c |', '> quoted; text', '<!-- note; here -->', 'Clean sentence.'].join('\n');
  const blocks = proseBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'Clean sentence.');
});

test('a numbered item is a step and a bullet is an item', () => {
  const blocks = proseBlocks(['1. Run the tests.', '- The Worker saves the key.', '', 'A paragraph.'].join('\n'));
  assert.deepEqual(blocks.map((b) => b.kind), ['step', 'item', 'paragraph']);
});

test('only changed lines are scored and fail. Old text gives warnings.', () => {
  const md = ['Old text; with a semicolon.', '', 'New clean sentence.'].join('\n');
  const r = analyzeMarkdown(md, { changed: new Set([3]) });
  assert.equal(r.failures.length, 0);
  assert.equal(r.scored, 1);
  assert.equal(r.passed, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /old text/);
  const all = analyzeMarkdown(md, { changed: null });
  assert.equal(all.failures.length, 1);
});

test('the score counts sentences that pass every rule', () => {
  const md = ['Run the tests.', 'The key is validated by the Worker.', 'Save the key.', 'Rotate the token.'].join('\n\n');
  const r = analyzeMarkdown(md, { changed: null });
  assert.equal(r.scored, 4);
  assert.equal(r.passed, 3);
});

test('changedLinesFromDiff reads the added line numbers', () => {
  const diff = ['diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -1,0 +5,2 @@', '+one', '+two', '@@ -9 +12 @@', '-old', '+new'].join('\n');
  const map = changedLinesFromDiff(diff);
  assert.deepEqual([...map.get('x.md')].sort((a, b) => a - b), [5, 6, 12]);
});
