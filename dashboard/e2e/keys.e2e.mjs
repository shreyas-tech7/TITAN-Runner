// Browser tests for the Keys page (Wave 12, K12 and Section 7.2). Chromium drives the real static export against the real
// Worker in workerd, with fake GitHub and fake providers. Run: npm run e2e (build first).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ADMIN, DASH_URL, FAKE_GEMINI_KEY, FAKE_GROQ_KEY, startStack } from './stack.mjs';

let stack;
let browser;

before(async () => {
  stack = await startStack();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

async function openKeys(t, { theme } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  const external = [];
  // Nothing may leave the machine. A request to another host is recorded and blocked.
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  if (theme) await page.addInitScript((th) => { document.documentElement.dataset.theme = th; }, theme);
  await page.goto(`${DASH_URL}/keys/`);
  await page.fill('#admin-token-input', ADMIN);
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector('table.keys-table');
  return { page, external };
}

const row = (page, id) => page.locator(`tr[data-provider="${id}"]`);

async function addKey(page, providerId, key, extras = {}) {
  await page.click('button:has-text("Add a key")');
  await page.waitForSelector('[role="dialog"]');
  await page.selectOption('#add-key-provider', { value: providerId });
  for (const [name, value] of Object.entries(extras)) await page.fill(`#add-key-${name}`, value);
  await page.fill('#add-key-value', key);
  await page.click('button:has-text("Save and verify")');
}

async function whereIsTheKey(page, key) {
  return page.evaluate((k) => {
    const found = [];
    if (document.documentElement.outerHTML.includes(k)) found.push('dom');
    if (document.body.innerText.includes(k)) found.push('text');
    if ([...document.querySelectorAll('input,textarea')].some((i) => i.value.includes(k))) found.push('input value');
    if (JSON.stringify(Object.entries(localStorage)).includes(k)) found.push('localStorage');
    if (JSON.stringify(Object.entries(sessionStorage)).includes(k)) found.push('sessionStorage');
    if (location.href.includes(k)) found.push('url');
    return found;
  }, key);
}

test('the Keys page lists every provider, shows keys set outside as outside, and flags a misspelled secret', async (t) => {
  stack.world.github.setByHand('GEMINI_API_KEY', FAKE_GEMINI_KEY);
  stack.world.github.setByHand('GROK_API_KEY', FAKE_GROQ_KEY);
  const { page, external } = await openKeys(t);
  await page.waitForSelector('tr[data-provider="gemini"]');
  assert.equal(await page.locator('table.keys-table tbody tr').count(), 14);
  assert.match(await row(page, 'gemini').innerText(), /set outside/);
  assert.match(await row(page, 'groq').innerText(), /Missing/);
  assert.match((await page.locator('.banner').allInnerTexts()).join('\n'), /GROK_API_KEY[\s\S]*GROQ_API_KEY/);
  assert.deepEqual(external, [], 'no request left the machine');
  stack.world.github.secrets.delete('GROK_API_KEY');
});

test('scenario 2: a valid key is saved, tested by a runner, and shows Proven', async (t) => {
  const { page } = await openKeys(t);
  await addKey(page, 'groq', FAKE_GROQ_KEY);
  await page.waitForSelector('text=A runner is testing it now', { timeout: 15_000 });
  const steps = await page.locator('.flow-step').allInnerTexts();
  assert.ok(steps[0].includes('Done') && steps[3].includes('Done'), steps.join(' | '));
  assert.equal(stack.world.github.open('GROQ_API_KEY'), FAKE_GROQ_KEY);
  const dispatch = stack.world.github.dispatches.find((d) => d.event_type === 'provider-selftest');
  assert.ok(dispatch);
  // The key is nowhere in the page after the submit, and the field is empty.
  assert.deepEqual(await whereIsTheKey(page, FAKE_GROQ_KEY), []);
  // A runner answers. The test plays the runner and posts the proof with the admin token (legacy mode).
  const proof = await fetch('http://127.0.0.1:8788/internal/provider-proof', {
    method: 'POST',
    headers: { 'X-Titan-Auth': ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'groq', requestId: dispatch.client_payload.requestId, ok: true, model: 'llama-3.3-70b-versatile', latencyMs: 412 }),
  });
  assert.equal(proof.status, 200);
  await page.waitForSelector('text=A runner used this key with success', { timeout: 15_000 });
  await page.click('button:has-text("Done")');
  await page.reload();
  await page.fill('#admin-token-input', ADMIN).catch(() => {});
  await page.waitForSelector('table.keys-table');
  assert.match(await row(page, 'groq').innerText(), /Proven/);
  assert.match(await row(page, 'groq').innerText(), /llama-3\.3-70b-versatile/);
  assert.match(await row(page, 'groq').innerText(), /••••yyyy/);
  assert.deepEqual(await whereIsTheKey(page, FAKE_GROQ_KEY), []);
});

test('scenario 3: a wrong key shows "The provider rejected this key" and saves nothing', async (t) => {
  const { page } = await openKeys(t);
  const before = stack.world.github.secrets.size;
  const wrong = ['gsk', 'WRONG', 'q'.repeat(20)].join('_');
  await addKey(page, 'together', wrong);
  await page.waitForSelector('text=The provider rejected this key');
  assert.equal(stack.world.github.secrets.size, before);
  assert.deepEqual(await whereIsTheKey(page, wrong), []);
  assert.equal(await page.locator('#add-key-value').count(), 0, 'the key field is gone after the result');
});

test('scenario 4: a rate limited provider asks "Save anyway?" and then shows Saved, not verified', async (t) => {
  const limited = ['gsk', 'RATE', 'r'.repeat(20)].join('_');
  stack.world.providers.host('api.together.xyz').rateLimited.add(limited);
  const { page } = await openKeys(t);
  await addKey(page, 'together', limited);
  await page.waitForSelector('text=The provider did not answer');
  await page.waitForSelector('text=Save anyway?');
  assert.equal(stack.world.github.secrets.has('TOGETHER_API_KEY'), false);
  await page.click('button:has-text("Save anyway")');
  await page.waitForSelector('text=A runner is testing it now', { timeout: 15_000 });
  assert.equal(stack.world.github.open('TOGETHER_API_KEY'), limited);
  assert.deepEqual(await whereIsTheKey(page, limited), []);
  await page.click('button:has-text("Close, the test keeps going")');
  await page.waitForSelector('tr[data-provider="together"][data-state="saved_unverified"]', { timeout: 15_000 });
  assert.match(await row(page, 'together').innerText(), /Saved, not verified/);
});

test('scenario 5: a token without the Secrets permission shows the permission name and no key', async (t) => {
  const { page } = await openKeys(t);
  stack.world.github.fail.publicKey = 403;
  const key = ['AIza', 'Sy', 'Z'.repeat(10), 'e2e', 'k'.repeat(15)].join('');
  stack.world.providers.host('generativelanguage.googleapis.com').valid.add(key);
  await addKey(page, 'gemini', key);
  await page.waitForSelector('[role="alert"]:has-text("Secrets: Read and write")');
  assert.deepEqual(await whereIsTheKey(page, key), []);
  stack.world.github.fail.publicKey = null;
});

test('scenario 6: remove needs the typed provider id, deletes the secret, and the event list shows it', async (t) => {
  const { page } = await openKeys(t);
  await row(page, 'groq').locator('button:has-text("Remove")').click();
  const confirm = page.locator('button:has-text("Remove key")');
  assert.equal(await confirm.isDisabled(), true);
  await page.fill('#remove-key-confirm', 'groq');
  assert.equal(await confirm.isDisabled(), false);
  await confirm.click();
  await page.waitForSelector('tr[data-provider="groq"][data-state="missing"]', { timeout: 15_000 });
  assert.ok(stack.world.github.deleted.includes('GROQ_API_KEY'));
  await page.waitForSelector('[aria-label="Key events"] >> text=remove');
});

test('the page has no horizontal scroll at 390 pixels and the table becomes cards', async (t) => {
  const { page } = await openKeys(t);
  await page.setViewportSize({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  assert.equal(await page.locator('table.keys-table thead').evaluate((el) => getComputedStyle(el).position), 'absolute');
});
