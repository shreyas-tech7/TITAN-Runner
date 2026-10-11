import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectTexts, scanTexts } from '../scripts/scan-issues.mjs';

const REPO = 'owner/repo';

function fakePages(map) {
  return async (url) => {
    const u = new URL(url);
    const key = u.pathname + (u.searchParams.get('state') ? `?state=${u.searchParams.get('state')}` : '');
    const page = Number(u.searchParams.get('page'));
    return page === 1 ? (map[key] ?? []) : [];
  };
}

test('collectTexts reads issues, pull requests, and the comments of those items only', async () => {
  const getPage = fakePages({
    '/repos/owner/repo/issues?state=open': [
      { number: 1, title: 'A task', body: 'body one' },
      { number: 2, title: 'A pull', body: null, pull_request: {} },
    ],
    '/repos/owner/repo/issues/comments': [
      { id: 10, issue_url: 'https://api.github.com/repos/owner/repo/issues/1', html_url: 'https://github.com/owner/repo/issues/1#c10', body: 'comment ten' },
      { id: 11, issue_url: 'https://api.github.com/repos/owner/repo/issues/99', html_url: 'https://github.com/owner/repo/issues/99#c11', body: 'closed item comment' },
    ],
    '/repos/owner/repo/pulls/comments': [
      { id: 20, pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/2', html_url: 'https://github.com/owner/repo/pull/2#r20', body: 'review text' },
    ],
  });
  const texts = await collectTexts({ repository: REPO, getPage });
  assert.deepEqual(texts.map((t) => t.name), ['issue-1', 'issue-2', 'comment-10', 'review-comment-20']);
  assert.equal(texts[1].link, 'https://github.com/owner/repo/pull/2');
  assert.ok(!texts.some((t) => t.text.includes('closed item comment')));
});

test('collectTexts pages through a long list', async () => {
  const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ number: from + i, title: 't', body: 'b' }));
  const calls = [];
  const getPage = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith('/issues') && u.searchParams.get('page') === '1') return rows(1, 100);
    if (u.pathname.endsWith('/issues') && u.searchParams.get('page') === '2') return rows(101, 5);
    return [];
  };
  const texts = await collectTexts({ repository: REPO, getPage });
  assert.equal(texts.filter((t) => t.name.startsWith('issue-')).length, 105);
});

test('scanTexts maps a finding back to its link and never carries the matched value', () => {
  const texts = [
    { name: 'issue-1', link: 'https://github.com/owner/repo/issues/1', text: 'clean text' },
    { name: 'comment-10', link: 'https://github.com/owner/repo/issues/1#c10', text: 'LEAKY-VALUE' },
  ];
  const run = (cmd, args) => {
    const dir = args[1];
    const reportPath = args[args.indexOf('--report-path') + 1];
    const names = readdirSync(dir);
    assert.deepEqual(names.sort(), ['comment-10.txt', 'issue-1.txt']);
    assert.ok(args.includes('--redact=100'));
    const hit = names.find((n) => readFileSync(join(dir, n), 'utf8').includes('LEAKY'));
    writeFileSync(reportPath, JSON.stringify([{ RuleID: 'titan-groq-key', File: join(dir, hit), Secret: 'REDACTED', Match: 'REDACTED' }]));
    return { status: 0 };
  };
  const result = scanTexts(texts, { run });
  assert.equal(result.ok, false);
  assert.deepEqual(result.matches, [{ rule: 'titan-groq-key', link: 'https://github.com/owner/repo/issues/1#c10' }]);
  assert.ok(!JSON.stringify(result).includes('LEAKY'));
});

test('scanTexts is clean when the report is empty and throws when gitleaks fails', () => {
  const texts = [{ name: 'issue-1', link: 'x', text: 'hello' }];
  const clean = scanTexts(texts, { run: (c, args) => { writeFileSync(args[args.indexOf('--report-path') + 1], '[]'); return { status: 0 }; } });
  assert.equal(clean.ok, true);
  assert.throws(() => scanTexts(texts, { run: () => ({ status: 2 }) }), /status 2/);
});
