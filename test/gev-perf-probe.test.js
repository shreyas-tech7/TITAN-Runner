import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUrl, summarize } from '../scripts/gev-perf-probe.mjs';

const HOST = 'https://titan-gev.onrender.com';

test('describeUrl keeps the path and drops the query and fragment', () => {
  const out = describeUrl(`${HOST}/?gev_token=gev2.1.2.abcdefgh.sigsig#frag`);
  assert.deepEqual(out, { origin: HOST, host: 'titan-gev.onrender.com', path: '/' });
  assert.deepEqual(describeUrl('not a url'), { origin: '', host: '', path: '' });
});

const record = (over) => ({
  origin: HOST, host: 'titan-gev.onrender.com', path: '/assets/a.js', status: 200, type: 'script',
  encoding: '', cacheControl: '', contentType: 'application/javascript', bytes: 300 * 1024, ms: 120, ...over,
});

test('summarize reports compression, cacheability, slow responses, polling, and other hosts', () => {
  const lines = summarize(
    [
      record({}),
      record({ path: '/assets/b.css', type: 'stylesheet', contentType: 'text/css', encoding: 'br', cacheControl: 'public, max-age=3600', bytes: 40 * 1024 }),
      record({ path: '/api/flights', type: 'fetch', contentType: 'application/json', bytes: 5 * 1024, ms: 900 }),
      record({ path: '/api/flights', type: 'fetch', contentType: 'application/json', bytes: 5 * 1024, ms: 700 }),
      record({ origin: 'https://tile.example', host: 'tile.example', path: '/t/1.png', type: 'image', contentType: 'image/png', bytes: 20 * 1024 }),
    ],
    HOST,
    45,
  ).join('\n');
  assert.match(lines, /host responses: 4, .* in 45s/);
  assert.match(lines, /no compression: 1\b/);
  assert.match(lines, /cannot reuse: 1 of 2/);
  assert.match(lines, /2x {2}\/api\/flights/);
  assert.match(lines, /900 ms/);
  assert.match(lines, /tile\.example {2}1 responses/);
});

test('summarize never prints a query string or a token', () => {
  const lines = summarize([record({ path: '/assets/a.js' })], HOST, 1).join('\n');
  assert.equal(lines.includes('?'), false);
  assert.equal(/gev2\.|gev_token|__Host-gev/.test(lines), false);
});
