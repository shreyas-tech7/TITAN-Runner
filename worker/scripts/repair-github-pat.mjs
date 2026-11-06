#!/usr/bin/env node
/**
 * @file Repair the Worker secret GITHUB_PAT from the repository Actions secret GITHUB_PAT.
 *
 * The script never prints a secret. It checks the candidate with GitHub before it changes Cloudflare.
 * In repair mode it also proves that the candidate can write and delete the diagnostic probe secret.
 * After the update it asks the live Worker to run the same checks.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { githubClient } from '../src/lib/github.js';
import { secretRoundTrip } from '../src/keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const DEFAULT_WORKER_URL = 'https://titan-runner-brain.titan-runner.workers.dev';

class RepairError extends Error {}

function fail(message) {
  throw new RepairError(message);
}

function need(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) fail(`Set the repository Actions secret ${name} first.`);
  if (/\s/.test(value)) fail(`The repository Actions secret ${name} must not contain whitespace.`);
  return value;
}

function repoOf(env) {
  const parts = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail('GITHUB_REPOSITORY must hold owner/repo.');
  return { GITHUB_OWNER: parts[0], GITHUB_REPO: parts[1] };
}

function workerUrl(env) {
  const raw = String(env.TITAN_WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('TITAN_WORKER_URL must be a valid https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('TITAN_WORKER_URL must be a bare https origin.');
  }
  return url.origin;
}

async function workerJson(base, admin, path, method, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'X-Titan-Auth': admin, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail(`The live Worker did not answer ${method} ${path}.`);
  }
  if (res.status === 401 || res.status === 403) fail('The repository Actions secret TITAN_ADMIN_TOKEN does not open the live Worker.');
  if (res.status < 200 || res.status >= 300) fail(`The live Worker answered ${method} ${path} with HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    fail(`The live Worker answered ${method} ${path} without JSON.`);
  }
}

function failedSteps(result) {
  return (result?.steps ?? []).filter((s) => !s.ok).map((s) => s.step).join(', ') || 'unknown step';
}

async function checkCandidate(env, candidate, { write }) {
  const candidateEnv = { ...env, ...repoOf(env), GITHUB_PAT: candidate };
  const gh = githubClient(candidateEnv);
  try {
    await gh.getPublicKey({ forWrite: true });
    await gh.listSecrets();
    // The Worker also reads Issues, Actions, and Variables. Check those surfaces before a replacement.
    await gh.listIssues('per_page=1');
    await gh.listWorkflowRuns('worker-deploy.yml', 1);
    await gh.getVariable('TITAN_WORKER_URL');
  } catch {
    fail('GitHub rejected the candidate GITHUB_PAT. Check expiry, repository access, and the permissions in docs/CONFIG.md.');
  }
  if (!write) return;
  const proof = await secretRoundTrip(candidateEnv);
  if (!proof.ok) fail(`The candidate GITHUB_PAT cannot complete the secret write probe: ${failedSteps(proof)}.`);
}

function wranglerBin() {
  const pkg = require.resolve('wrangler/package.json');
  const bin = require(pkg).bin?.wrangler;
  if (!bin) fail('The installed wrangler package has no CLI entry.');
  return join(dirname(pkg), bin);
}

function runWrangler(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], {
      cwd: WORKER_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, 60_000);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    // Capture stderr so a CLI error cannot print request details or a secret into the public log.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new RepairError('Wrangler could not start.')));
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else finish(new RepairError(`Wrangler exited with code ${code ?? 'unknown'} during ${args[0]} ${args[1]}.`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

async function liveVerify(base, admin, fetchImpl, sleep, log) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const diagnosis = await workerJson(base, admin, '/admin/diagnose', 'GET', fetchImpl);
    if (diagnosis?.ok === true) {
      const proof = await workerJson(base, admin, '/admin/diagnose/secret-roundtrip', 'POST', fetchImpl);
      if (proof?.ok !== true) fail(`The live Worker secret write probe failed: ${failedSteps(proof)}.`);
      log('PASS the live Worker accepts GITHUB_PAT and completes the secret write probe.');
      return;
    }
    if (attempt < 8) await sleep(5_000);
  }
  fail('The live Worker still rejects GITHUB_PAT after the update.');
}

/**
 * @param {{ env?: Record<string,string|undefined>, fetchImpl?: typeof fetch, wranglerImpl?: Function, sleep?: Function, log?: Function }} [opts]
 */
export async function repairGithubPat(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wrangler = opts.wranglerImpl ?? ((args, input) => runWrangler(args, input, env));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? console.log;
  const mode = env.REPAIR_MODE ?? 'check';
  if (mode !== 'check' && mode !== 'repair') fail('REPAIR_MODE must be check or repair.');

  const admin = need(env, 'TITAN_ADMIN_TOKEN');
  const base = workerUrl(env);
  repoOf(env);

  // Prove the admin token before any mutation. A wrong admin token must not hide behind a PAT failure.
  const current = await workerJson(base, admin, '/admin/diagnose', 'GET', fetchImpl);
  log(current?.ok === true ? 'PASS the live Worker already accepts its current GITHUB_PAT.' : 'FAIL the live Worker rejects its current GITHUB_PAT.');

  const candidate = env.GITHUB_PAT;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    log('FAIL the repository Actions secret GITHUB_PAT is absent. Add a replacement there, then run this workflow again.');
    return { ok: false, currentOk: current?.ok === true, candidateValid: false, repaired: false };
  }
  need(env, 'GITHUB_PAT');
  await checkCandidate(env, candidate, { write: false });
  log('PASS GitHub accepts the candidate GITHUB_PAT for secret reads.');

  if (mode === 'check') {
    log('Check only. No Cloudflare secret changed.');
    return { ok: true, currentOk: current?.ok === true, candidateValid: true, repaired: false };
  }

  need(env, 'CLOUDFLARE_API_TOKEN');
  need(env, 'CLOUDFLARE_ACCOUNT_ID');
  let listing;
  try {
    listing = await wrangler(['secret', 'list', '--format', 'json']);
  } catch {
    fail('Cloudflare rejected the repository credentials, or the Worker secret list is unavailable.');
  }
  try {
    const names = JSON.parse(listing);
    if (!Array.isArray(names)) throw new Error('bad shape');
  } catch {
    fail('Wrangler did not return a JSON secret name list.');
  }
  log('PASS Cloudflare allows Worker secret management.');

  await checkCandidate(env, candidate, { write: true });
  log('PASS the candidate GITHUB_PAT completes the GitHub secret write probe.');

  await wrangler(['secret', 'put', 'GITHUB_PAT'], candidate);
  log('The Worker secret GITHUB_PAT now holds the validated candidate.');
  await liveVerify(base, admin, fetchImpl, sleep, log);
  return { ok: true, currentOk: current?.ok === true, candidateValid: true, repaired: true };
}

async function main() {
  try {
    const result = await repairGithubPat();
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error(`FAIL ${err instanceof Error ? err.message : 'unknown repair error'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
