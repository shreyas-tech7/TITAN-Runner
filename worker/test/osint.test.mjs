// Pure-function coverage for the OSINT catalog parser (POST /admin/osint/ingest)
// and its abuse-resistance invariant — the two things worth locking down
// with a real regression test rather than trusting manual inspection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAwesomeOsintList } from '../src/index.js';

test('parses categories and tool entries from an awesome-list-shaped README', () => {
  const markdown = `
# Awesome OSINT List

## Table of Contents
- [People Search](#people-search)

## People Search
- [Tool One](https://example.com/one) - Finds things about people.
- [Tool Two](https://example.com/two) — Another finder, em-dash separated.

## Domain & IP
- [Tool Three](https://example.com/three): colon separated description.
- [Relative Link](/local/path) - should be skipped, not an absolute URL.
`;
  const tools = parseAwesomeOsintList(markdown);
  assert.equal(tools.length, 3);
  assert.deepEqual(tools[0], {
    name: 'Tool One',
    category: 'People Search',
    url: 'https://example.com/one',
    description: 'Finds things about people.',
  });
  assert.equal(tools[1].description, 'Another finder, em-dash separated.');
  assert.equal(tools[2].category, 'Domain & IP');
  assert.ok(!tools.some((t) => t.name === 'Relative Link'));
});

test('a boilerplate heading (Table of Contents) is never used as a tool category', () => {
  const markdown = `
## Table of Contents
- [Not A Tool](https://example.com/toc) - this is really a TOC entry.
`;
  const tools = parseAwesomeOsintList(markdown);
  // Still parsed as an item (the parser can't tell a TOC list apart from a
  // tool list by shape alone) — what matters is it never gets miscategorized
  // as belonging to a category literally named "Table of Contents" being
  // treated as if it were a real, prior tool category.
  assert.equal(tools[0].category, 'Uncategorized');
});

test('an unparseable line is skipped rather than thrown on', () => {
  const markdown = `
## Category
- not a valid markdown link line at all
- [Valid](https://example.com/valid) - fine
`;
  const tools = parseAwesomeOsintList(markdown);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Valid');
});
