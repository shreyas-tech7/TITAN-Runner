#!/usr/bin/env node
/**
 * Secretless checks for the God's Eye View host and the live dashboard build.
 * It needs no token and no secret. It prints PASS and FAIL lines only.
 *
 *   GEV_HOST=https://titan-gev.onrender.com node scripts/gev-secretless-check.mjs
 *
 * Environment:
 *   GEV_HOST          the TITAN-GEV host origin (required)
 *   GEV_DASHBOARD_URL the live dashboard tab URL (default: the GitHub Pages tab)
 *   GEV_WAKE_SECONDS  how long to wait for a sleeping host (default 180)
 */
const host = (process.env.GEV_HOST || '').replace(/\/+$/, '');
const dashboardUrl = process.env.GEV_DASHBOARD_URL || 'https://shreyas-tech7.github.io/TITAN-Runner/ops/gods-eye/';
const wakeSeconds = Number(process.env.GEV_WAKE_SECONDS || 180);

if (!/^https:\/\/[^/]+$/.test(host)) {
  console.error('Set GEV_HOST to the host origin, for example https://titan-gev.onrender.com');
  process.exit(2);
}

const dashboardOrigin = new URL(dashboardUrl).origin;
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

async function get(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

// A sleeping free host needs a minute or two. Wake it and time the wait.
const started = Date.now();
let health = null;
let attempts = 0;
while (!health && Date.now() - started < wakeSeconds * 1000) {
  attempts += 1;
  try {
    const response = await get(`${host}/healthz`, { origin: dashboardOrigin });
    if (response.status === 200) health = response;
  } catch {
    // not awake yet
  }
  if (!health) await new Promise((resolve) => setTimeout(resolve, 5000));
}
const waited = Math.round((Date.now() - started) / 1000);
check('the host answers /healthz with 200', health !== null, `no answer after ${waited}s`);
if (!health) process.exit(1);
console.log(`INFO  healthz took ${waited}s over ${attempts} attempt(s)${attempts > 1 ? ', so the host was cold' : ', so the host was already awake'}`);

const unauthenticated = await get(`${host}/`, { 'sec-fetch-dest': 'iframe' });
check('no token returns 401', unauthenticated.status === 401, String(unauthenticated.status));

const csp = unauthenticated.headers.get('content-security-policy') || '';
const ancestors = /(?:^|;\s*)frame-ancestors\s+([^;]*)/i.exec(csp)?.[1].trim().split(/\s+/) ?? [];
check('frame-ancestors names only the dashboard origin', ancestors.length === 1 && ancestors[0] === dashboardOrigin, csp.slice(0, 120));
check('X-Frame-Options is absent', unauthenticated.headers.get('x-frame-options') === null);

// The dashboard is static, so its only frame policy is one meta tag.
const page = await get(dashboardUrl);
check('the live tab page loads', page.status === 200, String(page.status));
const metas = [...page.text.matchAll(/<meta\b[^>]*>/gi)]
  .map((match) => match[0])
  .filter((tag) => /http-equiv\s*=\s*["']?content-security-policy["']?/i.test(tag));
const frameSrcMetas = metas.filter((tag) => /frame-src/i.test(tag));
check('the live build carries exactly one frame-src meta policy', frameSrcMetas.length === 1, `found ${frameSrcMetas.length}`);
const content = /content\s*=\s*"([^"]*)"/i.exec(frameSrcMetas[0] ?? '')?.[1].trim() ?? '';
check('that policy allows only the host origin', content === `frame-src ${host}`, content.slice(0, 120));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll secretless checks passed.');
