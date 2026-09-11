import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `listOpenTaskIssues` reads config at import time, so a live-path test must
 * set GITHUB_TOKEN/GITHUB_REPOSITORY *before* importing github.js. The
 * top-level dynamic import below does exactly that (node --test runs each
 * test file in its own process, so these env values cannot leak into other
 * test files).
 */
process.env.GITHUB_TOKEN = 'ghp_' + 'a'.repeat(36);
process.env.GITHUB_REPOSITORY = 'owner/repo';
const { listOpenTaskIssues } = await import('../src/github.js');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

test('listOpenTaskIssues paginates until a short page instead of stopping at 50', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    // endsWith distinguishes page 1 from per_page=100 (includes('page=1')
    // would also match the per_page param — the classic footgun).
    if (url.endsWith('page=1')) {
      return jsonResponse(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })));
    }
    if (url.endsWith('page=2')) {
      return jsonResponse([{ number: 201 }, { number: 202 }, { number: 203 }]);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const out = await listOpenTaskIssues('titan-task', fetchFn);
  assert.equal(calls.length, 2); // two pages, then a short page stops the loop
  assert.equal(out.length, 103);
  assert.ok(calls[0].endsWith('per_page=100&page=1'));
  assert.ok(calls[1].endsWith('per_page=100&page=2'));
});
