import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callConnector, connectorTools, describeConnectors, refusal } from '../src/tools/connectorCall.js';
import { MAX_CONNECTOR_CALLS, chatWithConnectors } from '../src/tools/connectorLoop.js';
import { scaffoldConnector } from '../scripts/new-connector.mjs';
import { validate } from '../worker/src/lib/jsonschema.js';
import { actionOf, buildActionRequest, buildTestRequest, shapeResponse, shapeTestResponse } from '../worker/src/connectors/core.js';

const ENV = {
  TITAN_WORKER_URL: 'https://worker.example',
  TITAN_CALLBACK_TOKEN: 'cb_test_token_value_1234567890',
};

test('C9: refusal() requires TITAN_WORKER_URL and TITAN_CALLBACK_TOKEN, and refuses the admin token', () => {
  assert.match(refusal({}), /TITAN_WORKER_URL/);
  assert.match(refusal({ TITAN_WORKER_URL: 'https://worker.example' }), /No callback token/);
  assert.match(
    refusal({ TITAN_WORKER_URL: 'https://worker.example', TITAN_ADMIN_TOKEN: 'adm_only' }),
    /Connector calls need the callback token/,
  );
  assert.equal(refusal(ENV), null);
});

test('C9: callConnector runs a read action with X-Titan-Callback and scrubs any secret or email in the output', async () => {
  const seen = [];
  const fakeKey = ['gsk', '1234567890abcdefghij', '1234567890'].join('_');
  const fakeEmail = ['alice', 'personal.example.org'].join('@');
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        ok: true,
        state: 'done',
        dataClass: 'internal',
        data: { status: 'ready', leakedKey: fakeKey, owner: fakeEmail },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const res = await callConnector(
    { connector: 'github', action: 'list_issues', input: { state: 'open' } },
    { env: ENV, fetchImpl, taskId: 'task-42' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.state, 'done');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://worker.example/internal/connector-call');
  assert.equal(seen[0].headers['X-Titan-Callback'], ENV.TITAN_CALLBACK_TOKEN);
  assert.equal(seen[0].body.taskId, 'task-42');
  assert.ok(!res.text.includes(fakeKey), 'secret must be scrubbed before state or logs');
  assert.ok(!res.text.includes(fakeEmail), 'email address must be scrubbed before state or logs');
  assert.ok(res.text.includes('[REDACTED]'));
});

test('C9: a write action from a sub-agent returns pending_approval and tells the runner not to repeat it', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ state: 'pending_approval', approvalId: 'ap_123456' }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    );
  const res = await callConnector(
    { connector: 'github', action: 'create_issue', input: { title: 'Test' } },
    { env: ENV, fetchImpl },
  );
  assert.equal(res.ok, true);
  assert.equal(res.state, 'pending_approval');
  assert.match(res.text, /pending_approval.*ap_123456.*Do not repeat it/);
});

test('S7: personal data is refused both when the broker blocks it (403) and if a response is marked personal', async () => {
  const brokerRefused = async () =>
    new Response(
      JSON.stringify({
        error: 'personal_data_forbidden',
        message: 'A sub-agent cannot run a personal action.',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  const r1 = await callConnector(
    { connector: 'gmail', action: 'list_unread', input: {} },
    { env: ENV, fetchImpl: brokerRefused },
  );
  assert.equal(r1.ok, false);
  assert.equal(r1.state, 'error');
  assert.match(r1.text, /personal_data_forbidden/);

  const leakedPersonal = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        state: 'done',
        dataClass: 'personal',
        data: { subject: 'Private bank statement' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const r2 = await callConnector(
    { connector: 'gmail', action: 'list_unread', input: {} },
    { env: ENV, fetchImpl: leakedPersonal },
  );
  assert.equal(r2.ok, false);
  assert.equal(r2.state, 'error');
  assert.match(r2.text, /personal_data_forbidden/);
  assert.ok(!r2.text.includes('Private bank statement'), 'personal payload must never survive');
});

test('C9: describeConnectors formats available connectors and connectorTools exposes both tools', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        connections: [
          {
            connector: 'github',
            label: 'main repo',
            actions: [
              { id: 'list_issues', risk: 'read' },
              { id: 'create_issue', risk: 'write' },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const desc = await describeConnectors({ env: ENV, fetchImpl });
  assert.equal(desc, '- github (main repo): list_issues [read], create_issue [write]');

  const tools = connectorTools({ env: ENV, fetchImpl });
  assert.deepEqual(
    tools.map((t) => t.id),
    ['connector_list', 'connector_call'],
  );
  assert.equal(await tools[0].run(), desc);
});

test('C9: chatWithConnectors screens tool calls with the Reviewer Gate and caps calls at MAX_CONNECTOR_CALLS', async () => {
  const replies = [
    '```json\n{"tool":"connector_call","args":{"connector":"github","action":"list_issues","input":{"state":"open"}}}\n```',
    '```json\n{"tool":"connector_call","args":{"connector":"github","action":"create_issue","input":{"title":"rm -rf /"}}}\n```',
    '```json\n{"tool":"connector_call","args":{"connector":"github","action":"list_prs","input":{}}}\n```',
    '```json\n{"tool":"connector_call","args":{"connector":"github","action":"list_runs","input":{}}}\n```',
    'Final answer after 3 tool calls.',
  ];
  let idx = 0;
  let lastMessages = null;
  const calls = [];
  const res = await chatWithConnectors(
    [{ role: 'user', content: 'Check the repo' }],
    'groq',
    {
      taskId: 'task-99',
      describe: async () => '- github (repo): list_issues [read]',
      review: async ({ args }) =>
        args.action === 'create_issue'
          ? { verdict: 'block', reason: 'unsafe title' }
          : { verdict: 'allow' },
      call: async (args) => {
        calls.push(args.action);
        return { ok: true, state: 'done', text: `result for ${args.action}` };
      },
      chat: async (messages) => {
        lastMessages = messages;
        const text = replies[idx++];
        return { text, provider: 'groq', model: 'llama', tokensUsed: 10 };
      },
    },
  );

  assert.equal(MAX_CONNECTOR_CALLS, 3);
  assert.equal(res.text, 'Final answer after 3 tool calls.');
  assert.equal(res.tokensUsed, 50);
  assert.deepEqual(calls, ['list_issues', 'list_prs']);
  assert.ok(
    lastMessages.some((m) => m.content.includes('blocked by the Reviewer Gate: unsafe title')),
    'blocked call is reported to the conversation without calling the broker',
  );
  assert.ok(
    lastMessages.some((m) => m.content.includes('No more tool calls are allowed.')),
    '4th call is refused by the loop cap',
  );
});

test('C10: scaffoldConnector creates a valid manifest, README, and fixtures that pass schema and core checks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'titan-conn-'));
  try {
    assert.throws(() => scaffoldConnector('Bad-Id', tmp), /must match/);
    const { folder } = scaffoldConnector('acme_status', tmp);
    assert.throws(() => scaffoldConnector('acme_status', tmp), /already exists/);

    const schema = JSON.parse(readFileSync('schemas/connector.schema.json', 'utf8'));
    const manifest = JSON.parse(readFileSync(join(folder, 'connector.json'), 'utf8'));
    const readme = readFileSync(join(folder, 'README.md'), 'utf8');
    const fxTest = JSON.parse(readFileSync(join(folder, 'fixtures', 'test.json'), 'utf8'));
    const fxAction = JSON.parse(readFileSync(join(folder, 'fixtures', 'status.json'), 'utf8'));

    assert.deepEqual(validate(schema, manifest, { strict: false }), []);
    assert.ok(readme.length > 200);

    const conn = { config: fxTest.connection.config, secrets: fxTest.connection.secrets };
    const reqTest = buildTestRequest(manifest, conn);
    assert.equal(reqTest.url, fxTest.expect.request.url);
    const shapedTest = shapeTestResponse(manifest, {
      status: fxTest.response.status,
      text: JSON.stringify(fxTest.response.body),
      contentType: fxTest.response.contentType,
    });
    assert.equal(shapedTest.ok, true);
    assert.deepEqual(shapedTest.data, fxTest.output);

    const action = actionOf(manifest, 'status');
    const reqAction = buildActionRequest(manifest, action, { ...conn, input: {} });
    assert.equal(reqAction.url, fxAction.expect.request.url);
    const shapedAction = shapeResponse(manifest, action, {
      status: fxAction.response.status,
      text: JSON.stringify(fxAction.response.body),
      contentType: fxAction.response.contentType,
    });
    assert.equal(shapedAction.ok, true);
    assert.deepEqual(shapedAction.data, fxAction.output);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
