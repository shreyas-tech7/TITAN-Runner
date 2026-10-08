// Fixture tests for every connector (Wave 12, C3). Each fixture in connectors/<id>/fixtures/ holds a connection, an input,
// the request that the broker must build, a recorded answer, and the result that the broker must return.
// Nothing here uses the network. The tests call the pure core only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONNECTORS } from '../src/connectors.generated.js';
import { expandFakes } from './helpers/fakeValues.mjs';
import { actionOf, allowedHosts, buildActionRequest, buildTestRequest, shapeResponse, shapeTestResponse } from '../src/connectors/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'connectors');

function headerOf(headers, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function hostOf(url) {
  return new URL(url).hostname.toLowerCase();
}

let count = 0;
for (const manifest of CONNECTORS) {
  let files = [];
  try {
    files = readdirSync(join(root, manifest.id, 'fixtures')).filter((f) => f.endsWith('.json')).sort();
  } catch {
    // some connectors have no request to test
  }
  for (const file of files) {
    const fx = expandFakes(JSON.parse(readFileSync(join(root, manifest.id, 'fixtures', file), 'utf8')));
    count += 1;
    test(`${manifest.id}: ${fx.name}`, () => {
      const conn = { config: fx.connection.config ?? {}, secrets: fx.connection.secrets ?? {} };
      for (const f of manifest.auth.fields) {
        const v = (f.secret ? conn.secrets : conn.config)[f.name];
        if (v !== undefined && f.pattern) assert.match(v, new RegExp(f.pattern), `the fake value of ${f.name} follows the field pattern`);
      }
      const isTest = fx.target === 'test';
      const action = isTest ? null : actionOf(manifest, fx.target.replace(/^action:/, ''));
      assert.ok(isTest || action, `the fixture names an action that ${manifest.id} does not have`);

      const build = () => (isTest ? buildTestRequest(manifest, conn) : buildActionRequest(manifest, action, { ...conn, input: fx.input ?? {} }));
      if (fx.expectBuildError) {
        assert.throws(build, (err) => String(err.message).includes(fx.expectBuildError));
        return;
      }
      const req = build();
      assert.ok(req, 'the request is built');

      // The request.
      assert.equal(req.method, fx.expect.request.method);
      assert.equal(req.url, fx.expect.request.url);
      for (const [name, value] of Object.entries(fx.expect.request.headers ?? {})) assert.equal(headerOf(req.headers, name), value, `header ${name}`);
      assert.ok(headerOf(req.headers, 'accept'), 'every request has an Accept header');
      const want = fx.expect.request.body;
      if (want === null || want === undefined) assert.equal(req.body, undefined, 'no body');
      else if (typeof want === 'string') assert.equal(req.body, want);
      else {
        assert.deepEqual(JSON.parse(req.body), want);
        assert.match(headerOf(req.headers, 'content-type') ?? '', /json/);
      }

      // The host rules. The host of the request must be one that the manifest allows.
      const { hosts, dynamic } = allowedHosts(manifest, conn.config, conn.secrets);
      assert.deepEqual(dynamic, fx.expect.hosts ?? []);
      assert.ok(hosts.some((h) => (h.startsWith('.') ? hostOf(req.url).endsWith(h) : hostOf(req.url) === h)), `the host ${hostOf(req.url)} is allowed`);

      // A secret sits in a header only, except for the kinds that the manifest declares.
      if (!['secret_url', 'telegram_bot', 'api_key_query'].includes(manifest.auth.kind)) {
        for (const value of Object.values(conn.secrets)) {
          assert.ok(!req.url.includes(value), 'a secret is not in the URL');
          assert.ok(!(req.body ?? '').includes(value), 'a secret is not in the body');
        }
      }

      // The answer.
      const text = typeof fx.response.body === 'string' ? fx.response.body : JSON.stringify(fx.response.body);
      const res = { status: fx.response.status, text, contentType: fx.response.contentType, input: req.input };
      const result = isTest ? shapeTestResponse(manifest, res) : shapeResponse(manifest, action, res);
      if (fx.expectFailure) {
        assert.equal(result.ok, false, 'the result is a failure');
        assert.ok(String(result.error).includes(fx.expectFailure), `the error says "${fx.expectFailure}" (got "${result.error}")`);
        return;
      }
      assert.equal(result.ok, true, `the result is ok (got ${JSON.stringify(result)})`);
      assert.deepEqual(result.data, fx.output);
      const flat = JSON.stringify(result.data);
      for (const value of Object.values(conn.secrets)) assert.ok(!flat.includes(value), 'the result holds no secret');
    });
  }
}

test('there are at least fifteen fixtures', () => {
  assert.ok(count >= 15, `found ${count}`);
});

test('every connector has a README and a version', () => {
  for (const m of CONNECTORS) {
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
    assert.ok(readFileSync(join(root, m.id, 'README.md'), 'utf8').length > 200, `${m.id} README is too short`);
  }
});
