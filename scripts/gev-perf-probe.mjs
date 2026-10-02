#!/usr/bin/env node
/**
 * Measures what the live God's Eye View tab asks of the host. It logs in the way a
 * person would, waits for the globe, watches the network for a while, and prints a
 * short report: how much the host sends, whether text is compressed, whether assets
 * can be cached, which requests are slow, and how often the app polls. It also checks
 * that a static asset fetched with no cookie still returns 401.
 *
 * It prints INFO, PASS, and FAIL lines only. It never prints a URL query, a token, or
 * a cookie. Every line goes through `redact`, and each record keeps the path only.
 *
 * Environment:
 *   TITAN_ADMIN_TOKEN  the dashboard login (required, comes from a repo secret)
 *   GEV_DASHBOARD_URL  the tab URL (default: the GitHub Pages tab)
 *   GEV_HOST           the host origin (default: https://titan-gev.onrender.com)
 *   GEV_PROBE_SECONDS  how long to watch after the globe appears (default 45)
 *   GEV_WAIT_SECONDS   how long to wait for a cold host (default 120)
 */
import { pathToFileURL } from 'node:url';
import { ADMIN_TOKEN_KEY, redact, seedAdminToken } from './gev-live-browser.mjs';

/** Keep the origin and the path. Drop the query and the fragment, which can hold a token. */
export function describeUrl(raw) {
  try {
    const url = new URL(raw);
    return { origin: url.origin, host: url.host, path: url.pathname };
  } catch {
    return { origin: '', host: '', path: '' };
  }
}

const TEXT_TYPES = /(javascript|json|css|html|xml|svg|wasm|text\/)/i;
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const tail = (path) => (path.length > 70 ? `...${path.slice(-67)}` : path);

/**
 * Turn raw response records into report lines. A record is
 * { origin, path, status, type, encoding, cacheControl, contentType, bytes, ms }.
 */
export function summarize(records, hostOrigin, seconds) {
  const lines = [];
  const mine = records.filter((r) => r.origin === hostOrigin);
  const others = records.filter((r) => r.origin !== hostOrigin);
  const total = (list) => list.reduce((sum, r) => sum + (r.bytes || 0), 0);

  lines.push(`INFO  host responses: ${mine.length}, ${kib(total(mine))} sent in ${seconds}s of watching`);
  const byType = new Map();
  for (const r of mine) {
    const entry = byType.get(r.type) ?? { n: 0, bytes: 0 };
    entry.n += 1;
    entry.bytes += r.bytes || 0;
    byType.set(r.type, entry);
  }
  lines.push(`INFO  by type: ${[...byType].map(([t, e]) => `${t} ${e.n} (${kib(e.bytes)})`).join(', ') || 'none'}`);

  const plain = mine.filter((r) => TEXT_TYPES.test(r.contentType) && !r.encoding && (r.bytes || 0) > 20 * 1024);
  lines.push(`INFO  text responses over 20 KiB with no compression: ${plain.length}`);
  for (const r of plain.sort((a, b) => b.bytes - a.bytes).slice(0, 6)) lines.push(`INFO    ${kib(r.bytes)}  ${tail(r.path)}`);

  const assets = mine.filter((r) => r.path.startsWith('/assets/'));
  const uncachedAssets = assets.filter((r) => /no-store|no-cache/i.test(r.cacheControl) || !r.cacheControl);
  lines.push(`INFO  /assets/ responses that a browser cannot reuse: ${uncachedAssets.length} of ${assets.length}`);
  const sample = assets[0];
  if (sample) lines.push(`INFO  one asset's cache-control: ${sample.cacheControl || 'none'}`);

  const slow = [...mine].sort((a, b) => b.ms - a.ms).slice(0, 6);
  lines.push('INFO  slowest host responses:');
  for (const r of slow) lines.push(`INFO    ${Math.round(r.ms)} ms  ${r.status}  ${kib(r.bytes || 0)}  ${tail(r.path)}`);

  const polls = new Map();
  for (const r of mine.filter((x) => x.path.startsWith('/api/'))) polls.set(r.path, (polls.get(r.path) ?? 0) + 1);
  lines.push(`INFO  host /api/ requests in the window: ${[...polls.values()].reduce((a, b) => a + b, 0)}`);
  for (const [path, n] of [...polls].sort((a, b) => b[1] - a[1]).slice(0, 8)) lines.push(`INFO    ${n}x  ${tail(path)}`);

  const hosts = new Map();
  for (const r of others) {
    const entry = hosts.get(r.host) ?? { n: 0, bytes: 0 };
    entry.n += 1;
    entry.bytes += r.bytes || 0;
    hosts.set(r.host, entry);
  }
  lines.push(`INFO  other hosts the page talks to: ${others.length} responses, ${kib(total(others))}`);
  for (const [host, e] of [...hosts].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)) lines.push(`INFO    ${host}  ${e.n} responses, ${kib(e.bytes)}`);
  return lines;
}

async function main() {
  const adminToken = (process.env.TITAN_ADMIN_TOKEN || '').trim();
  const dashboardUrl = process.env.GEV_DASHBOARD_URL || 'https://shreyas-tech7.github.io/TITAN-Runner/ops/gods-eye/';
  const hostOrigin = new URL(process.env.GEV_HOST || 'https://titan-gev.onrender.com').origin;
  const probeMs = Number(process.env.GEV_PROBE_SECONDS || 45) * 1000;
  const waitMs = Number(process.env.GEV_WAIT_SECONDS || 120) * 1000;
  if (!adminToken) {
    console.error('Set TITAN_ADMIN_TOKEN.');
    process.exit(2);
  }
  const say = (line) => console.log(redact(line, [adminToken]));
  const { chromium, request } = await import('playwright');

  const browser = await chromium.launch({ headless: true });
  const records = [];
  let failures = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(seedAdminToken, [ADMIN_TOKEN_KEY, adminToken, new URL(dashboardUrl).origin]);
    const pending = [];
    context.on('response', (response) => {
      pending.push(
        (async () => {
          const req = response.request();
          const where = describeUrl(response.url());
          const headers = response.headers();
          let bytes = 0;
          try {
            bytes = (await req.sizes()).responseBodySize;
          } catch {
            bytes = Number(headers['content-length']) || 0;
          }
          const timing = req.timing();
          records.push({
            ...where,
            status: response.status(),
            type: req.resourceType(),
            encoding: headers['content-encoding'] || '',
            cacheControl: headers['cache-control'] || '',
            contentType: headers['content-type'] || '',
            bytes,
            ms: timing.responseEnd > 0 ? timing.responseEnd : 0,
          });
        })().catch(() => {}),
      );
    });

    const page = await context.newPage();
    const started = Date.now();
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const reachable = await page
      .waitForFunction(() => document.querySelector('.gev-bar-status')?.textContent?.trim() === 'Reachable', null, { timeout: waitMs })
      .then(() => true)
      .catch(() => false);
    say(`INFO  status bar ${reachable ? 'settled' : 'did not settle'} after ${Math.round((Date.now() - started) / 1000)}s`);
    if (!reachable) {
      say('FAIL  the tab never reached Reachable, so there is nothing to measure');
      process.exit(1);
    }

    const handle = await page.waitForSelector('iframe.gev-frame', { timeout: 30_000 }).catch(() => null);
    const frame = handle ? await handle.contentFrame() : null;
    if (frame) {
      await frame.waitForSelector('canvas', { timeout: 60_000 }).catch(() => {});
      await frame
        .evaluate(() => {
          window.__gevLongTasks = { n: 0, ms: 0, max: 0 };
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              window.__gevLongTasks.n += 1;
              window.__gevLongTasks.ms += e.duration;
              window.__gevLongTasks.max = Math.max(window.__gevLongTasks.max, e.duration);
            }
          }).observe({ entryTypes: ['longtask'] });
        })
        .catch(() => {});
    }
    const watchStart = Date.now();
    await page.waitForTimeout(probeMs);
    const watched = Math.round((Date.now() - watchStart) / 1000);
    await Promise.allSettled(pending);

    for (const line of summarize(records, hostOrigin, watched)) say(line);
    const lt = frame ? await frame.evaluate(() => window.__gevLongTasks).catch(() => null) : null;
    if (lt) say(`INFO  main thread in the globe frame: ${lt.n} long tasks, ${Math.round(lt.ms)} ms in total, longest ${Math.round(lt.max)} ms`);

    // The gate must hold for static files too. Fetch assets with a fresh context that has no cookie.
    const assets = records
      .filter((r) => r.origin === hostOrigin && r.path.startsWith('/assets/') && r.status === 200)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 4);
    const bare = await request.newContext();
    for (const asset of assets) {
      const res = await bare.get(`${hostOrigin}${asset.path}`, { failOnStatusCode: false, maxRedirects: 0 });
      const edge = res.headers()['cf-cache-status'] || 'none';
      const ok = res.status() === 401;
      if (!ok) failures += 1;
      say(`${ok ? 'PASS' : 'FAIL'}  an asset fetched with no cookie returns 401  (${res.status()}, cf-cache-status ${edge}, ${tail(asset.path)})`);
    }
    await bare.dispose();
    if (assets.length === 0) say('INFO  no /assets/ responses were seen, so the no-cookie asset check was skipped');
  } finally {
    await browser.close();
  }
  if (failures > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.log(`FAIL  the probe crashed  (${redact(error?.message ?? error, [process.env.TITAN_ADMIN_TOKEN ?? '']).slice(0, 300)})`);
    process.exit(1);
  });
}
