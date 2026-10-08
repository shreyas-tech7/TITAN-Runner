// Browser tests for the Connectors page, the approvals, the MCP tokens, and the Health Center (Wave 12, Release 2, Section 7.3).
// Chromium drives the real static export against the real Worker in workerd. A fake Discord stands behind the Worker.
// Run: npm run e2e (build first).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ADMIN, discordUrl, openDash, startStack, whereIs } from './stack.mjs';

let stack;
let browser;
const SECRET_SUFFIX = 'Zq9'.repeat(8);
const SECRET_URL = discordUrl(SECRET_SUFFIX);

before(async () => {
  stack = await startStack();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

/** Call the Worker from the test process, the way a tool or a sub-agent would. */
async function api(path, { method = 'GET', body, headers = { 'X-Titan-Auth': ADMIN } } = {}) {
  const res = await fetch(`${stack.worker.url}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** A Discord connection must exist. The first test makes one in the page. Another test may need one when it runs alone. */
async function ensureDiscord() {
  const list = await api('/connectors');
  if (list.body.connectors.find((c) => c.id === 'discord_webhook').connections.length > 0) return;
  const out = await api('/connectors/discord_webhook/connect', { method: 'POST', body: { label: 'Alerts channel', fields: { url: SECRET_URL } } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
}

test('the Connectors page lists the catalog, searches it, and filters by category', async (t) => {
  const { page, external } = await openDash(browser, t, '/connectors/', 'ul.connector-grid');
  const total = await page.locator('li.connector-card').count();
  assert.ok(total >= 15, `at least 15 connectors, got ${total}`);
  await page.fill('#connector-search', 'discord');
  assert.equal(await page.locator('li.connector-card').count(), 1);
  assert.match(await page.locator('li[data-connector="discord_webhook"]').innerText(), /Not connected/);
  await page.fill('#connector-search', '');
  await page.click('button.chip-button:has-text("Notify")');
  const notify = await page.locator('li.connector-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-connector')));
  assert.ok(notify.includes('discord_webhook') && notify.includes('telegram') && !notify.includes('github'));
  await page.fill('#connector-search', 'zzzz-no-match');
  assert.match(await page.locator('.empty').innerText(), /No connector matches/);
  assert.deepEqual(external, [], 'no request left the machine');
});

test('scenario 1: connect a Discord webhook, see the test pass, send a test message, and the secret is nowhere in the page', async (t) => {
  const { page } = await openDash(browser, t, '/connectors/', 'ul.connector-grid');
  await page.fill('#connector-search', 'discord');
  await page.click('button[aria-label="Connect Discord webhook"]');
  await page.waitForSelector('[role="dialog"] #connect-url');
  assert.equal(await page.getAttribute('#connect-url', 'type'), 'password');
  await page.fill('#connect-url', SECRET_URL);
  await page.click('button:has-text("Connect and test")');
  await page.waitForSelector('text=Connected.');
  assert.match(await page.locator('[role="dialog"]').innerText(), /The test passed in \d+ ms/);
  assert.deepEqual(await whereIs(page, SECRET_SUFFIX), [], 'the webhook secret is not in the page after the result');
  await page.click('button:has-text("Open details")');
  await page.waitForSelector('[role="dialog"][aria-labelledby="drawer-title"]');
  const drawer = page.locator('[role="dialog"][aria-labelledby="drawer-title"]');
  await drawer.locator('section[aria-label="State"]').waitFor();
  assert.match(await drawer.innerText(), /Connected/);
  assert.match(await drawer.innerText(), /Stored secrets: url\. TITAN never shows their values\./);
  assert.match(await drawer.locator('li[data-action="send"]').innerText(), /Write/);
  assert.equal(await drawer.locator('li[data-action="send"] details.try-it').count(), 0, 'a write action has no Try it box');
  assert.deepEqual(await whereIs(page, SECRET_SUFFIX), []);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'detached' });

  await page.click('button:has-text("Notifications")');
  await page.waitForSelector('li[data-channel]');
  const before = stack.discordSent.length;
  await page.click('li[data-channel] button:has-text("Send test")');
  await page.waitForSelector('text=The test message went to');
  assert.equal(stack.discordSent.length, before + 1);
  assert.match(JSON.stringify(stack.discordSent.at(-1)), /TITAN test notification/);
  await page.click('li[data-channel] button:has-text("Add default rules")');
  await page.waitForSelector('text=Added 6 default rules');
  assert.equal(await page.locator('tr[data-rule]').count(), 6);
  assert.deepEqual(await whereIs(page, SECRET_SUFFIX), []);
});

test('scenario 7: a write action from a sub-agent waits in Approvals, and Approve runs it one time', async (t) => {
  await ensureDiscord();
  const sent = stack.discordSent.length;
  const call = await api('/internal/connector-call', { method: 'POST', body: { connector: 'discord_webhook', action: 'send', input: { text: 'hello from a sub-agent' }, taskId: 't-e2e-1' } });
  assert.equal(call.status, 202, JSON.stringify(call.body));
  assert.equal(call.body.state, 'pending_approval');
  assert.equal(stack.discordSent.length, sent, 'nothing is sent before the approval');

  const { page } = await openDash(browser, t, '/connectors/?tab=approvals', 'li[data-approval]');
  const item = page.locator('li[data-approval]').first();
  assert.match(await item.innerText(), /Discord webhook: Send a message/);
  assert.match(await item.innerText(), /internal:t-e2e-1/);
  await item.locator('button:has-text("Approve")').click();
  await page.waitForSelector('text=Approved and done');
  assert.equal(stack.discordSent.length, sent + 1);
  assert.match(JSON.stringify(stack.discordSent.at(-1)), /hello from a sub-agent/);
  assert.equal(await page.locator('li[data-approval]').count(), 0, 'the approval left the waiting list');
  const decided = await api('/approvals?status=executed');
  assert.equal(decided.body.approvals.length >= 1, true);
  assert.deepEqual(decided.body.approvals[0].result, { ok: true, status: 204 });
  assert.ok(!('input' in decided.body.approvals[0]) && !('input_json' in decided.body.approvals[0]), 'the answer has no input field');
});

test('a denied call never runs', async (t) => {
  await ensureDiscord();
  const sent = stack.discordSent.length;
  const call = await api('/internal/connector-call', { method: 'POST', body: { connector: 'discord_webhook', action: 'send', input: { text: 'do not send me' } } });
  assert.equal(call.status, 202);
  const { page } = await openDash(browser, t, '/connectors/?tab=approvals', 'li[data-approval]');
  await page.locator('li[data-approval]').first().locator('button:has-text("Deny")').click();
  await page.waitForSelector('text=Denied:');
  assert.equal(stack.discordSent.length, sent);
});

test('a connection opens in the drawer with a call log, and Disconnect deletes it after a confirm', async (t) => {
  await ensureDiscord();
  const { page } = await openDash(browser, t, '/connectors/', 'ul.connector-grid');
  await page.fill('#connector-search', 'discord');
  await page.click('button[aria-label="Open Discord webhook"]');
  const drawer = page.locator('[role="dialog"][aria-labelledby="drawer-title"]');
  await drawer.waitFor();
  await page.waitForSelector('[aria-label="Call log"] table');
  assert.match(await drawer.locator('[aria-label="Call log"]').innerText(), /send/);
  await drawer.locator('button:has-text("Test now")').click();
  await page.waitForSelector('text=The test passed in');
  await drawer.locator('button:has-text("Disconnect")').click();
  assert.match(await drawer.innerText(), /This cannot be undone\./);
  await drawer.locator('button:has-text("Yes, disconnect")').click();
  await drawer.waitFor({ state: 'detached' });
  await page.waitForSelector('li[data-connector="discord_webhook"][data-state="none"]');
  const list = await api('/connectors');
  assert.equal(list.body.connectors.find((c) => c.id === 'discord_webhook').connections.length, 0);
  assert.equal(JSON.stringify(list.body).includes(SECRET_SUFFIX), false);
});

test('an MCP token is shown one time, works against /mcp, and stops working after Revoke', async (t) => {
  const { page } = await openDash(browser, t, '/connectors/?tab=mcp', '#mcp-label');
  assert.match(await page.locator('pre[aria-label="Claude Code command"]').innerText(), /claude mcp add --transport http titan http:\/\/127\.0\.0\.1:8788\/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"/);
  await page.fill('#mcp-label', 'e2e tool');
  await page.click('button:has-text("Make token")');
  const shown = page.locator('[data-testid="new-mcp-token"]');
  await shown.waitFor();
  const token = (await shown.innerText()).trim();
  assert.match(token, /^titan_mcp_[A-Za-z0-9_-]{20,}$/);
  assert.equal((await page.locator('pre[aria-label="Claude Code command"]').innerText()).includes(token), false, 'the command card never holds a real token');

  const rpc = (method, params) => fetch(`${stack.worker.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  assert.equal(init.status, 200);
  const list = await (await rpc('tools/list', {})).json();
  assert.ok(list.result.tools.some((x) => x.name === 'titan_status'));
  assert.ok(!list.result.tools.some((x) => x.name === 'titan_queue_task'), 'a token without tasks:write does not see the write tool');

  await page.click('button:has-text("I copied it. Hide it.")');
  assert.deepEqual(await whereIs(page, token), [], 'the token is gone from the page');
  await page.locator('tr[data-token]', { hasText: 'e2e tool' }).locator('button:has-text("Revoke")').click();
  await page.locator('tr[data-token]', { hasText: 'e2e tool' }).locator('button:has-text("Yes, revoke")').click();
  await page.waitForSelector('tr[data-token]:has-text("e2e tool"):has-text("Revoked")');
  assert.equal((await rpc('tools/list', {})).status, 401);
});

test('the Health Center shows a row for each part and a full diagnosis with a report that holds no secret', async (t) => {
  const { page, external } = await openDash(browser, t, '/health/', 'li[data-health="worker"]');
  for (const id of ['worker', 'd1', 'pulse', 'pages', 'callback', 'queue', 'vault', 'key:groq', 'key:gemini', 'vms']) {
    assert.equal(await page.locator(`li[data-health="${id}"]`).count(), 1, `the row ${id}`);
  }
  assert.equal(await page.locator('li[data-health^="key:"]').count(), 14, 'one row for each provider in the catalog');
  assert.match(await page.locator('li[data-health="key:groq"]').innerText(), /Not tested/, 'a missing key is not green');
  assert.match(await page.locator('li[data-health="key:groq"]').innerText(), /Add this key on the Keys page\./);
  assert.match(await page.locator('li[data-health="worker"]').innerText(), /Working/);
  assert.match(await page.locator('li[data-health="vault"]').innerText(), /Working/);
  await page.click('button:has-text("Run full diagnosis")');
  await page.waitForSelector('pre[aria-label="Diagnosis report"]');
  const report = await page.locator('pre[aria-label="Diagnosis report"]').innerText();
  assert.match(report, /TITAN full diagnosis/);
  assert.ok(!report.includes(ADMIN), 'the report holds no admin token');
  assert.ok(!report.includes(SECRET_SUFFIX));
  assert.ok(await page.locator('tr[data-diagnosis="mcp"]').count() === 1);
  assert.deepEqual(external, []);
});

test('the home page shows the setup checklist with a ring, and the commands for connectors in the palette', async (t) => {
  const { page } = await openDash(browser, t, '/', 'section[aria-label="Setup"]');
  const setup = page.locator('section[aria-label="Setup"]');
  assert.match(await setup.innerText(), /of 6 done/);
  assert.equal(await setup.locator('li[data-setup]').count(), 6);
  assert.equal(await setup.locator('svg[role="img"]').count(), 1);
  assert.match(await setup.locator('li[data-setup="worker"]').innerText(), /Done/);
  assert.match(await setup.locator('li[data-setup="providers"]').innerText(), /To do/);
  await page.keyboard.press('Control+k');
  await page.fill('.palette input', 'connect');
  assert.match(await page.locator('.palette').innerText(), /Connect a tool/);
  await page.fill('.palette input', 'test all');
  assert.match(await page.locator('.palette').innerText(), /Test all connectors/);
  assert.match(await page.locator('footer .version-footer').innerText(), /Dashboard e2e1234/);
  assert.match(await page.locator('footer .version-footer').innerText(), /Worker/);
});

test('the top tabs show the new pages in the order of the brief', async (t) => {
  const { page } = await openDash(browser, t, '/health/', 'nav.top-tabs');
  const labels = await page.locator('nav.top-tabs a').allInnerTexts();
  assert.deepEqual(labels, ['Dashboard', 'Connectors', 'Keys', 'Health', "God's Eye View"]);
  assert.equal(await page.getAttribute('nav.top-tabs a[aria-current="page"]', 'href'), '/TITAN-Runner/health/');
});
