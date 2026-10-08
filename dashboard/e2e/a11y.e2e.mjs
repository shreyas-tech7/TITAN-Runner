// Accessibility (Wave 12, Section 6): axe finds no violation on each new route, in all four themes, at 1280 and 390 pixels,
// and no page scrolls sideways. The list of routes grows with each release.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { ADMIN, DASH_URL, startStack } from './stack.mjs';

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');
const THEMES = ['eclipse', 'light', 'oled', 'contrast'];
const SIZES = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
const ROUTES = [{ path: '/keys/', ready: 'table.keys-table' }];

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

for (const route of ROUTES) {
  for (const theme of THEMES) {
    for (const size of SIZES) {
      test(`axe: ${route.path} in the ${theme} theme at ${size.width} pixels`, async (t) => {
        const context = await browser.newContext({ viewport: size, serviceWorkers: 'block' });
        t.after(() => context.close());
        const page = await context.newPage();
        await page.route('**/*', (r) => (['127.0.0.1', 'localhost'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
        await page.addInitScript((th) => { try { localStorage.setItem('titan-runner:theme', th); } catch { /* blocked */ } }, theme);
        await page.goto(`${DASH_URL}${route.path}`);
        await page.fill('#admin-token-input', ADMIN);
        await page.click('button:has-text("Unlock")');
        await page.waitForSelector(route.ready);
        await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
        await page.addScriptTag({ path: AXE });
        const results = await page.evaluate(async () => {
          const r = await window.axe.run(document, { resultTypes: ['violations'] });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
        });
        assert.deepEqual(results, [], `axe found violations: ${JSON.stringify(results)}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `horizontal scroll of ${overflow}px`);
      });
    }
  }
}

test('axe: the add key window has no violation', async (t) => {
  const context = await browser.newContext({ viewport: SIZES[0], serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/*', (r) => (['127.0.0.1', 'localhost'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  await page.goto(`${DASH_URL}/keys/`);
  await page.fill('#admin-token-input', ADMIN);
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector('table.keys-table');
  await page.click('button:has-text("Add a key")');
  await page.waitForSelector('[role="dialog"]');
  await page.addScriptTag({ path: AXE });
  const results = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })));
  assert.deepEqual(results, []);
  // The keyboard works: Escape closes the window and focus returns to the button that opened it.
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Add a key');
});
