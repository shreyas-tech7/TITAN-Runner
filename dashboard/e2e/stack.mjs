// The local stack for the browser tests: the real Worker in workerd, the fakes (GitHub, providers) on a local http server,
// and the static export of the dashboard served under the Pages base path. Everything binds 127.0.0.1.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkerd } from '../../worker/test/helpers/workerd.mjs';
import { startFakeServer } from '../../worker/test/helpers/fakeServer.mjs';
import { ADMIN, FAKE_GEMINI_KEY, FAKE_GROQ_KEY, FakeWorld } from '../../worker/test/helpers/world.mjs';
import { KEK, discordUrl, fakeDiscord } from '../../worker/test/helpers/hub.mjs';

export { ADMIN, FAKE_GEMINI_KEY, FAKE_GROQ_KEY, discordUrl };

export const WORKER_PORT = 8788; // the same number is baked into the build: NEXT_PUBLIC_TITAN_WORKER_URL
export const DASH_PORT = 3000; // an origin that the Worker allows for CORS
export const BASE = '/TITAN-Runner';
export const DASH_URL = `http://127.0.0.1:${DASH_PORT}${BASE}`;

const OUT = fileURLToPath(new URL('../out', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain' };

function staticServer() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404).end('not found');
      return;
    }
    let rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^(\.\.[/\\])+/, '');
    let file = join(OUT, rel);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) file = join(OUT, '404.html');
    const status = file.endsWith('404.html') ? 404 : 200;
    res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
}

/**
 * Start everything. Call `stop()` at the end.
 * With `vault: false` the Worker has no CONNECTOR_KEK, so the vault routes answer 503 and the page shows the setup card.
 */
export async function startStack({ vault = true } = {}) {
  if (!existsSync(join(OUT, 'index.html'))) throw new Error('Build the dashboard first: GITHUB_PAGES_BASE_PATH=/TITAN-Runner NEXT_PUBLIC_TITAN_WORKER_URL=http://127.0.0.1:8788 npm run build');
  const world = new FakeWorld();
  world.providers.host('api.groq.com').valid.add(FAKE_GROQ_KEY);
  world.providers.host('generativelanguage.googleapis.com').valid.add(FAKE_GEMINI_KEY);
  const discordSent = fakeDiscord(world);
  const fake = await startFakeServer(world, ['discord.com']);
  const worker = await startWorkerd({
    port: WORKER_PORT,
    vars: {
      TITAN_ADMIN_TOKEN: ADMIN,
      GITHUB_PAT: 'fake-pat-for-e2e',
      TITAN_TEST_MODE: '1',
      TITAN_TEST_HOST_MAP: JSON.stringify(fake.hostMap),
      TITAN_PROVIDER_CHECK_TIMEOUT_MS: '2000',
      DASHBOARD_URL: DASH_URL,
      ...(vault ? { CONNECTOR_KEK: KEK } : {}),
    },
    timeoutMs: 90_000,
  });
  const dash = staticServer();
  await new Promise((resolve) => dash.listen(DASH_PORT, '127.0.0.1', resolve));
  return {
    world,
    worker,
    discordSent,
    stop: async () => {
      await new Promise((resolve) => dash.close(resolve));
      await worker.stop();
      await fake.stop();
    },
  };
}

/**
 * Open a page of the dashboard, unlock it with the admin token, and wait for a selector. Nothing may leave the machine:
 * a request to another host is recorded and blocked. Returns the page and the list of blocked requests.
 */
export async function openDash(browser, t, path, ready, { theme, viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  const external = [];
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  if (theme) await page.addInitScript((th) => { try { localStorage.setItem('titan-runner:theme', th); } catch { /* blocked */ } }, theme);
  await page.goto(`${DASH_URL}${path}`);
  await page.fill('#admin-token-input', ADMIN);
  await page.click('button:has-text("Unlock")');
  await page.waitForSelector(ready);
  return { page, external };
}

/** Where does a secret value show up in the page? An empty list is the right answer. */
export async function whereIs(page, value) {
  return page.evaluate((v) => {
    const found = [];
    if (document.documentElement.outerHTML.includes(v)) found.push('dom');
    if (document.body.innerText.includes(v)) found.push('text');
    if ([...document.querySelectorAll('input,textarea')].some((i) => i.value.includes(v))) found.push('input value');
    if (JSON.stringify(Object.entries(localStorage)).includes(v)) found.push('localStorage');
    if (JSON.stringify(Object.entries(sessionStorage)).includes(v)) found.push('sessionStorage');
    if (location.href.includes(v)) found.push('url');
    return found;
  }, value);
}
