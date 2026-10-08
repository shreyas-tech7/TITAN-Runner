// The local stack for the browser tests: the real Worker in workerd, the fakes (GitHub, providers) on a local http server,
// and the static export of the dashboard served under the Pages base path. Everything binds 127.0.0.1.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkerd } from '../../worker/test/helpers/workerd.mjs';
import { startFakeServer } from '../../worker/test/helpers/fakeServer.mjs';
import { ADMIN, FAKE_GEMINI_KEY, FAKE_GROQ_KEY, FakeWorld } from '../../worker/test/helpers/world.mjs';

export { ADMIN, FAKE_GEMINI_KEY, FAKE_GROQ_KEY };

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

/** Start everything. Call `stop()` at the end. */
export async function startStack() {
  if (!existsSync(join(OUT, 'index.html'))) throw new Error('Build the dashboard first: GITHUB_PAGES_BASE_PATH=/TITAN-Runner NEXT_PUBLIC_TITAN_WORKER_URL=http://127.0.0.1:8788 npm run build');
  const world = new FakeWorld();
  world.providers.host('api.groq.com').valid.add(FAKE_GROQ_KEY);
  world.providers.host('generativelanguage.googleapis.com').valid.add(FAKE_GEMINI_KEY);
  const fake = await startFakeServer(world);
  const worker = await startWorkerd({
    port: WORKER_PORT,
    vars: {
      TITAN_ADMIN_TOKEN: ADMIN,
      GITHUB_PAT: 'fake-pat-for-e2e',
      TITAN_TEST_MODE: '1',
      TITAN_TEST_HOST_MAP: JSON.stringify(fake.hostMap),
      TITAN_PROVIDER_CHECK_TIMEOUT_MS: '2000',
    },
    timeoutMs: 90_000,
  });
  const dash = staticServer();
  await new Promise((resolve) => dash.listen(DASH_PORT, '127.0.0.1', resolve));
  return {
    world,
    worker,
    stop: async () => {
      await new Promise((resolve) => dash.close(resolve));
      await worker.stop();
      await fake.stop();
    },
  };
}
