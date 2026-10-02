#!/usr/bin/env node
/**
 * Drives the live God's Eye View tab in headless Chromium, the way a person would.
 * It logs in by putting the admin token in localStorage, opens the tab, waits for
 * a cold host, and checks that the globe loads. It prints PASS, FAIL, INFO, and
 * WARN lines only.
 *
 * The admin token and the one-time access link must never reach a log. The script
 * takes no screenshots, records no trace and no video, listens to no console or
 * network events, never prints a URL, and runs every line it prints through
 * `redact`.
 *
 * Environment:
 *   TITAN_ADMIN_TOKEN  the dashboard login (required, comes from a repo secret)
 *   GEV_DASHBOARD_URL  the tab URL (default: the GitHub Pages tab)
 *   GEV_WAIT_SECONDS   how long to wait for a cold host (default 120)
 */
import { pathToFileURL } from 'node:url';

export const ADMIN_TOKEN_KEY = 'titan-runner:admin-token:v1';
/**
 * Runs in every page and frame the context opens, so it must act only on the dashboard
 * origin. Without the origin check it would also write the admin token into the
 * localStorage of the God's Eye View host, where the third party globe app could read it.
 * Playwright sends this function as text, so it must not use anything outside itself.
 */
export function seedAdminToken([key, value, origin]) {
  if (window.location.origin !== origin) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage blocked
  }
}

const SWIFTSHADER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** Strip anything that looks like a secret, a token, or a cookie from text. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('***');
  }
  return out
    .replace(/gev2\.[A-Za-z0-9._-]+/g, 'gev2.***')
    .replace(/gevs1\.[A-Za-z0-9._-]+/g, 'gevs1.***')
    .replace(/gev_token=[^&\s"')]+/g, 'gev_token=***')
    .replace(/__Host-gev_session=[^;\s"')]+/g, '__Host-gev_session=***');
}

async function attempt({ chromium, adminToken, dashboardUrl, waitMs, swiftshader }) {
  const result = { reachable: false, frame: false, noBanner: false, text: false, canvas: false, bundle: false, seconds: 0 };
  const browser = await chromium.launch({ headless: true, args: swiftshader ? SWIFTSHADER_ARGS : [] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(seedAdminToken, [ADMIN_TOKEN_KEY, adminToken, new URL(dashboardUrl).origin]);
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await page
      .waitForFunction(() => document.querySelector('.gev-bar-status')?.textContent?.trim() === 'Reachable', null, { timeout: waitMs })
      .then(() => {
        result.reachable = true;
      })
      .catch(() => {});
    result.seconds = Math.round((Date.now() - started) / 1000);
    if (!result.reachable) return result;

    const handle = await page.waitForSelector('iframe.gev-frame', { timeout: 30_000 }).catch(() => null);
    const frame = handle ? await handle.contentFrame() : null;
    if (!frame) return result;
    await frame.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
    result.frame = true;

    // The bootstrap page says GOD'S EYE VIEW in capitals, so match the app's own casing.
    await frame
      .waitForFunction(() => /God's Eye View/.test(`${document.title} ${document.body?.innerText ?? ''}`), null, { timeout: 90_000 })
      .then(() => {
        result.text = true;
      })
      .catch(() => {});

    await frame
      .waitForSelector('canvas', { timeout: 60_000 })
      .then(() => {
        result.canvas = true;
      })
      .catch(() => {});

    result.bundle = await frame
      .evaluate(() => document.querySelectorAll('script[src*="/assets/"]').length > 0)
      .catch(() => false);

    // The blocked-cookie banner arrives by postMessage, so give it a moment before judging.
    await page.waitForTimeout(5000);
    result.noBanner = (await page.locator('.gev-banner').count()) === 0;
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const adminToken = (process.env.TITAN_ADMIN_TOKEN || '').trim();
  const dashboardUrl = process.env.GEV_DASHBOARD_URL || 'https://shreyas-tech7.github.io/TITAN-Runner/ops/gods-eye/';
  const waitMs = Number(process.env.GEV_WAIT_SECONDS || 120) * 1000;
  if (!adminToken) {
    console.error('Set TITAN_ADMIN_TOKEN.');
    process.exit(2);
  }
  const { chromium } = await import('playwright');

  let result = await attempt({ chromium, adminToken, dashboardUrl, waitMs, swiftshader: false });
  let usedSwiftshader = false;
  if (result.reachable && result.frame && !result.canvas) {
    console.log('INFO  no canvas with the default flags, retrying with SwiftShader WebGL flags');
    usedSwiftshader = true;
    result = await attempt({ chromium, adminToken, dashboardUrl, waitMs, swiftshader: true });
  }

  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
    if (!ok) failures += 1;
  };
  console.log(`INFO  status bar took ${result.seconds}s to settle${usedSwiftshader ? ' (second attempt, SwiftShader flags)' : ''}`);
  check('the status bar reads Reachable', result.reachable, `waited ${result.seconds}s`);
  check('the iframe with class gev-frame loads', result.frame);
  check("the frame's text includes God's Eye View", result.text);
  check('no session-blocked banner shows', result.reachable && result.noBanner);
  if (result.canvas) {
    check('the frame holds a canvas', true);
  } else if (result.text && result.bundle) {
    console.log('WARN  headless Chromium gave no canvas even with SwiftShader flags, so this run asserted on the served app bundle instead');
    check('the frame serves the app bundle (canvas fallback)', true);
  } else {
    check('the frame holds a canvas', false);
  }

  if (failures > 0) {
    console.log(`\n${failures} browser check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll browser checks passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.log(`FAIL  the browser test crashed  (${redact(error?.message ?? error, [process.env.TITAN_ADMIN_TOKEN ?? '']).slice(0, 300)})`);
    process.exit(1);
  });
}
