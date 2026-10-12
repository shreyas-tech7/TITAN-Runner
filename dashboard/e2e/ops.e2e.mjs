// Browser tests for the Ops page (RD1) and the sign-in with a session (RT5). Chromium drives the real static export
// against the real Worker in workerd. The public mirrors are served from fixtures, so every panel has data to show.
// Run: npm run e2e (build first, with the base path and the Worker address of the stack).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { ADMIN, DASH_URL, startStack, whereIs } from './stack.mjs';

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');
const THEMES = ['eclipse', 'light', 'oled', 'contrast'];
const SIZES = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
const SESSION_KEY = 'titan-runner:session:v1';
const OLD_KEY = 'titan-runner:admin-token:v1';

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const FILES = {
  'ops/health.json': {
    contract: '1', generated_at: ago(90),
    providers: {
      groq: { 'llama-3.3-70b-versatile': { status: 'healthy', latency_ms: 310, checked_at: ago(90), error_class: null } },
      gemini: { 'gemini-2.5-flash': { status: 'degraded', latency_ms: 9200, checked_at: ago(90), error_class: 'slow' } },
      openrouter: { free: { status: 'down', latency_ms: null, checked_at: ago(90), error_class: 'rate_limited' } },
      together: { m: { status: 'not_configured', latency_ms: null, checked_at: ago(90), error_class: 'no_key' } },
    },
  },
  'ops/quota.json': {
    contract: '1', generated_at: ago(30),
    providers: {
      groq: { 'llama-3.3-70b-versatile': { limit_day: 1000, used_day: 742, limit_month: null, used_month: 9120, remaining_pct: 25.8, resets_at: '2026-10-13T00:00:00.000Z', exhausted: false, limit_source: 'https://console.groq.com/docs/rate-limits', limit_confidence: 'observed' } },
      gemini: { 'gemini-2.5-flash': { limit_day: null, used_day: 61, limit_month: null, used_month: 802, remaining_pct: null, resets_at: '2026-10-13T00:00:00.000Z', exhausted: false, limit_source: null, limit_confidence: 'unknown' } },
    },
  },
  'ops/eval.json': {
    contract: '1', generated_at: ago(3 * 24 * 60), eval_version: 'v1',
    models: {
      'llama-3.3-70b-versatile': {
        'code-generation': { score: 0.92, tasks_run: 2, run_at: ago(3 * 24 * 60), eval_version: 'v1' },
        'security-review': { score: 0.4, tasks_run: 1, run_at: ago(3 * 24 * 60), eval_version: 'v1' },
      },
    },
  },
  'ops/hosts.json': {
    contract: '1', generated_at: ago(30),
    hosts: {
      github_actions: { status: 'up', last_check: ago(30), uptime_24h: 100, uptime_7d: 99.6, uptime_30d: 99.1, last_pulse_at: ago(8) },
      render_1: { status: 'asleep', last_check: ago(30), uptime_24h: 100, uptime_7d: 100, uptime_30d: null },
      hermes_1: { status: 'down', last_check: ago(30), uptime_24h: 62.5, uptime_7d: 91.4, uptime_30d: 96.2 },
    },
  },
};
const LESSONS = [{ id: 'les_1', signature: 's', first_seen: ago(500), last_seen: ago(20), count: 4, task_type: 'code', what_failed: 'A task met a 429 from a free provider.', likely_cause: 'Two tasks shared one provider.', suggested_fix: 'Spread the steps.', source: 'template' }]
  .map((l) => JSON.stringify(l)).join('\n');

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

/** Open a page, serve the mirrors from the fixtures, and block every request that leaves the machine. */
async function open(t, path, { size = SIZES[0], theme, unlock = true, adminToken = ADMIN } = {}) {
  const context = await browser.newContext({ viewport: size, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  const external = [];
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.route(/\/state\/ops\/[a-z-]+\.json(\?.*)?$/, (route) => {
    const name = `ops/${new URL(route.request().url()).pathname.split('/').pop()}`;
    return FILES[name] ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FILES[name]) }) : route.continue();
  });
  await page.route(/\/state\/lessons\.jsonl(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: LESSONS }));
  if (theme) await page.addInitScript((th) => { try { localStorage.setItem('titan-runner:theme', th); } catch { /* blocked */ } }, theme);
  await page.goto(`${DASH_URL}${path}`);
  if (unlock) {
    await page.fill('#admin-token-input', adminToken);
    await page.click('button:has-text("Unlock")');
    await page.waitForSelector('.ops-page');
  }
  return { page, external };
}

test('the sign-in starts a session, and the admin token is kept nowhere in the page', async (t) => {
  const { page, external } = await open(t, '/ops/');
  assert.deepEqual(await whereIs(page, ADMIN), [], 'the admin token must not stay in the DOM or in storage');
  const stored = await page.evaluate(([session, old]) => ({ session: sessionStorage.getItem(session), old: sessionStorage.getItem(old) ?? localStorage.getItem(old) }), [SESSION_KEY, OLD_KEY]);
  assert.ok(stored.session && stored.session.length >= 20 && stored.session !== ADMIN, 'a session token is kept');
  assert.equal(stored.old, null);
  const others = external.filter((u) => !u.startsWith('https://api.github.com/'));
  assert.deepEqual(others, [], `nothing else leaves the machine, but these were blocked: ${others.join(', ')}`);
});

test('an admin token from an older version of the page is removed when the page loads', async (t) => {
  const context = await browser.newContext({ viewport: SIZES[0], serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/*', (r) => (['127.0.0.1', 'localhost'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort()));
  await page.addInitScript(([key, value]) => { sessionStorage.setItem(key, value); }, [OLD_KEY, ADMIN]);
  await page.goto(`${DASH_URL}/ops/`);
  await page.waitForSelector('#admin-token-input');
  assert.equal(await page.evaluate((k) => sessionStorage.getItem(k) ?? localStorage.getItem(k), OLD_KEY), null);
});

test('a wrong token is refused in words, and no session is kept', async (t) => {
  const { page } = await open(t, '/ops/', { unlock: false });
  await page.fill('#admin-token-input', 'not-the-admin-token');
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector('.field-error');
  assert.match(await page.textContent('.field-error'), /That token was rejected by the Worker\./);
  assert.equal(await page.evaluate((k) => sessionStorage.getItem(k) ?? localStorage.getItem(k), SESSION_KEY), null);
});

test('the five panels show the mirrors, and the Security panel shows the sign-in log and the scan', async (t) => {
  const { page } = await open(t, '/ops/');
  const text = async (label) => page.locator(`section[aria-label="${label}"]`).innerText();
  const health = await text('Provider health');
  assert.match(health, /1 healthy, 1 degraded, 1 down, 1 not set up\./);
  assert.match(health, /rate limited/);
  const quota = await text('Quota meter');
  assert.match(quota, /742 of 1,000 today/);
  assert.match(quota, /61 today, limit unknown/);
  assert.match(await text('Eval scores'), /llama-3\.3-70b-versatile/);
  const hosts = await text('Host status');
  assert.match(hosts, /GitHub Actions pulse/);
  assert.match(hosts, /Asleep/);
  assert.match(hosts, /62\.5%/);
  assert.match(await text('Lessons'), /A task met a 429 from a free provider\./);
  await page.waitForSelector('section[aria-label="Security"] table');
  const security = await text('Security');
  assert.match(security, /Signed in/, 'the sign-in of this test is in the log');
  assert.match(security, /Secret scan: No run yet/, 'the scan status could not be read, and the panel says so');
});

test('the Ops tab is in the tab bar of every page, and it marks the current page', async (t) => {
  const { page } = await open(t, '/ops/');
  assert.equal(await page.locator('a.top-tab[aria-current="page"]').innerText(), 'Ops');
  assert.equal(await page.locator('a.top-tab[href$="/ops/"], a.top-tab[href$="/ops"]').count(), 1);
});

test('when the session ends the page locks and says so, and a new sign-in works', async (t) => {
  const { page } = await open(t, '/ops/');
  await page.waitForSelector('section[aria-label="Security"] table');
  // End the session on the Worker, as an idle limit would.
  const status = await page.evaluate(async ([key, url]) => {
    const token = sessionStorage.getItem(key);
    const res = await fetch(`${url}/auth/logout`, { method: 'POST', headers: { 'X-Titan-Auth': token, 'Content-Type': 'application/json' }, body: '{}' });
    return res.status;
  }, [SESSION_KEY, 'http://127.0.0.1:8788']);
  assert.equal(status, 200);
  await page.click('section[aria-label="Security"] button:has-text("Refresh")');
  await page.waitForSelector('[data-testid="session-ended"]');
  assert.match(await page.textContent('[data-testid="session-ended"]'), /Your session ended\. Sign in again\./);
  assert.equal(await page.evaluate((k) => sessionStorage.getItem(k) ?? localStorage.getItem(k), SESSION_KEY), null);
  await page.fill('#admin-token-input', ADMIN);
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector('.ops-page');
});

test('the lock button ends the session on the Worker', async (t) => {
  const { page } = await open(t, '/ops/');
  const session = await page.evaluate((k) => sessionStorage.getItem(k), SESSION_KEY);
  await page.click('button:has-text("Lock dashboard")');
  await page.waitForSelector('#admin-token-input');
  const res = await fetch('http://127.0.0.1:8788/auth/session', { headers: { 'X-Titan-Auth': session } });
  assert.equal(res.status, 401, 'the session no longer works');
});

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`axe: /ops/ in the ${theme} theme at ${size.width} pixels, and no sideways scroll`, async (t) => {
      const { page } = await open(t, '/ops/', { size, theme });
      await page.waitForSelector('section[aria-label="Security"] table');
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
