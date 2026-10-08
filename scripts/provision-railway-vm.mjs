#!/usr/bin/env node
/**
 * @file One-shot Railway free-VM provisioner. Invoked by
 * `.github/workflows/vm-agent.yml` on `repository_dispatch: provision-vm`
 * (fired by the titan-runner-brain Worker's 1-minute tick) or by a manual
 * `workflow_dispatch`. Does one unit of work and exits — nothing here is a
 * long-running process.
 *
 * What a Railway free VM is: `ssh railway.new` returns a Linux box (2 vCPU,
 * 2 GB RAM) with coding agents preinstalled and a live preview URL, with NO
 * account and NO credit card — Railway identifies the caller purely by SSH
 * key (railway.com/free-vm). To stay inside that cardless free path this
 * script generates a THROWAWAY ed25519 keypair in a temp dir per run, uses
 * it for exactly one connection, and never writes it into the repo or a
 * persisted location. A box lives 60 minutes to build, then 24 hours to
 * claim; unclaimed boxes and their files are deleted.
 *
 * This is a new *execution surface*, not a new provider adapter and not a
 * new execution path around the safety net: a brief that will run ON the VM
 * is put past the SAME Reviewer Gate (`src/reviewer/`) `run-subagent-task.mjs`
 * uses, before anything touches Railway. Every string that could reach a log
 * line or a dashboard row passes through `scrubForState()` first — this repo
 * is PUBLIC, so a VM manifest/brief/result is exactly as world-readable as
 * `state/*.json`. The SSH private key and the admin token are never logged.
 */
import { callWorker, callbackAuth, workerBase } from '../src/lib/workerCallback.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { scrubForState } from '../src/lib/secretScrub.js';
import { reviewAction } from '../src/reviewer/index.js';

const VM_ID = process.env.TITAN_VM_ID;
const BRIEF = process.env.TITAN_VM_BRIEF || '';
const RUN_URL = process.env.GITHUB_RUN_URL || '';

const BUILD_WINDOW_MS = 60 * 60 * 1000; // 60 minutes to build
const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours to claim
const SSH_HOST = process.env.TITAN_RAILWAY_SSH_HOST || 'railway.new';
const SSH_TIMEOUT_MS = 90_000;

function safe(value) {
  return scrubForState(String(value ?? ''));
}

/**
 * Extract the preview URL and claim link from a Railway VM's first-connect
 * output. Railway hands an agent session a JSON manifest; the human welcome
 * banner also prints `Try it: https://<name>.up.railway.app` and `Claim:
 * https://railway.com/ssh-signup?code=…`. Pure and network-free so it can be
 * unit-tested (see test/railway-vm.test.js). Tries JSON first, then falls
 * back to a tolerant regex over the banner text.
 *
 * @param {string} output Raw stdout from the `ssh railway.new` session.
 * @returns {{ previewUrl: string|null, claimUrl: string|null, name: string|null,
 *   buildDeadline: string|null, claimDeadline: string|null } | null}
 */
export function parseRailwayManifest(output) {
  if (typeof output !== 'string' || !output.trim()) return null;

  // 1. A JSON manifest anywhere in the stream (agent-session shape). Scan
  // each {...} candidate rather than assuming the whole stream is one JSON
  // document — the banner text is interleaved with it.
  for (const match of output.matchAll(/\{[\s\S]*?\}/g)) {
    let obj;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      continue;
    }
    const previewUrl = firstString(obj, ['preview_url', 'previewUrl', 'url', 'preview']);
    const claimUrl = firstString(obj, ['claim_url', 'claimUrl', 'claim', 'signup_url']);
    if (previewUrl || claimUrl) {
      return {
        previewUrl: previewUrl ?? null,
        claimUrl: claimUrl ?? null,
        name: firstString(obj, ['name', 'box', 'box_name', 'vm']) ?? nameFromUrl(previewUrl),
        buildDeadline: firstString(obj, ['build_deadline', 'buildDeadline', 'expires_at']) ?? null,
        claimDeadline: firstString(obj, ['claim_deadline', 'claimDeadline']) ?? null,
      };
    }
  }

  // 2. Banner fallback.
  const previewMatch = output.match(/https?:\/\/[a-z0-9-]+\.up\.railway\.app[^\s"'<>]*/i);
  const claimMatch = output.match(/https?:\/\/railway\.com\/ssh-signup\?code=[^\s"'<>]+/i);
  if (!previewMatch && !claimMatch) return null;
  const previewUrl = previewMatch ? previewMatch[0] : null;
  return {
    previewUrl,
    claimUrl: claimMatch ? claimMatch[0] : null,
    name: nameFromUrl(previewUrl),
    buildDeadline: null,
    claimDeadline: null,
  };
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function nameFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/https?:\/\/([a-z0-9-]+)\.up\.railway\.app/i);
  return m ? m[1] : null;
}

/** Whether an SSH transcript is Railway's soft, retryable capacity message
 * rather than a real error. That attempt does not count against the daily
 * 3-per-IP limit, so it is reported as `failed` with a clear "try again"
 * reason, never treated as a hard crash. */
export function isCapacityMessage(output) {
  return /Anonymous trials are temporarily disabled/i.test(String(output ?? ''));
}

async function reportVmStatus(patch) {
  if (!workerBase() || !callbackAuth() || !VM_ID) {
    console.error('provision-railway-vm: TITAN_WORKER_URL, a callback token, or the vm id is not set, so the status cannot go back.');
    return;
  }
  const res = await callWorker('/internal/vm-status', { body: { id: VM_ID, ...patch } });
  if (!res.ok) console.error(`provision-railway-vm: status callback rejected: ${res.status ?? safe(res.error)}`);
}

/** One SSH connection to railway.new with a throwaway key. Returns the
 * captured transcript. The key never leaves the temp dir and is deleted in
 * `finally`. */
function connectToRailway() {
  const dir = mkdtempSync(join(tmpdir(), 'titan-railway-'));
  const keyPath = join(dir, 'id_ed25519');
  const knownHosts = join(dir, 'known_hosts');
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyPath], { stdio: 'ignore' });
    const result = spawnSync(
      'ssh',
      [
        '-i', keyPath,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'ConnectTimeout=30',
        '-o', 'BatchMode=yes',
        SSH_HOST,
        // A no-op remote command: the value is in the welcome banner /
        // manifest Railway prints on connect, not in any command output.
        'true',
      ],
      { encoding: 'utf8', timeout: SSH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const transcript = `${result.stdout || ''}\n${result.stderr || ''}`;
    return { transcript, code: result.status, error: result.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (!VM_ID) {
    console.error('provision-railway-vm: no vm id in the dispatch payload — nothing to do.');
    process.exitCode = 1;
    return;
  }

  await reportVmStatus({ status: 'provisioning', run_url: RUN_URL });

  // A brief that will run ON the VM is put past the SAME Reviewer Gate the
  // sub-agent path uses, before Railway is touched at all.
  if (BRIEF.trim()) {
    const review = await reviewAction({
      toolId: 'railway-vm',
      args: { host: SSH_HOST },
      description: BRIEF,
      effect: 'external',
    });
    if (review.verdict === 'block') {
      const summary = `Blocked by the Reviewer Gate: ${safe(review.reason ?? 'no reason given')}`;
      console.error(`provision-railway-vm: ${summary}`);
      await reportVmStatus({ status: 'failed', result_summary: summary.slice(0, 1800), run_url: RUN_URL });
      process.exitCode = 1;
      return;
    }
  }

  let transcript = '';
  try {
    const conn = connectToRailway();
    transcript = conn.transcript || '';
    if (conn.error) {
      const summary = `SSH to ${SSH_HOST} failed: ${safe(conn.error.message || conn.error)}`;
      console.error(`provision-railway-vm: ${summary}`);
      await reportVmStatus({ status: 'failed', result_summary: summary.slice(0, 1800), run_url: RUN_URL });
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    const summary = `SSH provisioning threw: ${safe(err instanceof Error ? err.message : err)}`;
    console.error(`provision-railway-vm: ${summary}`);
    await reportVmStatus({ status: 'failed', result_summary: summary.slice(0, 1800), run_url: RUN_URL });
    process.exitCode = 1;
    return;
  }

  if (isCapacityMessage(transcript)) {
    const summary = 'Railway anonymous trials are temporarily capacity-limited right now — retryable, not counted against the daily 3-per-IP limit. The next request will try again.';
    console.error(`provision-railway-vm: ${summary}`);
    await reportVmStatus({ status: 'failed', result_summary: summary, run_url: RUN_URL });
    process.exitCode = 1;
    return;
  }

  const manifest = parseRailwayManifest(transcript);
  if (!manifest || !manifest.previewUrl) {
    const summary = `Connected but could not find a preview URL in Railway's response. First 200 chars: ${safe(transcript).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    console.error(`provision-railway-vm: ${summary}`);
    await reportVmStatus({ status: 'failed', result_summary: summary.slice(0, 1800), run_url: RUN_URL });
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const buildDeadline = manifest.buildDeadline || new Date(now + BUILD_WINDOW_MS).toISOString();
  const claimDeadline = manifest.claimDeadline || new Date(now + CLAIM_WINDOW_MS).toISOString();
  const summary = safe(
    `Live Railway VM${manifest.name ? ` "${manifest.name}"` : ''} (2 vCPU / 2 GB). ` +
      `Preview ${manifest.previewUrl}. Claim within 24h to keep it.`,
  ).slice(0, 1800);

  console.log(`provision-railway-vm: ${summary}`);
  await reportVmStatus({
    status: 'live',
    preview_url: safe(manifest.previewUrl),
    claim_url: manifest.claimUrl ? safe(manifest.claimUrl) : undefined,
    build_deadline: buildDeadline,
    claim_deadline: claimDeadline,
    run_url: RUN_URL,
    result_summary: summary,
  });
}

// Only run the provisioning flow when executed as the workflow entrypoint —
// importing this module (the parser unit test) must not open an SSH session.
const invokedDirectly = process.argv[1] && /provision-railway-vm\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  await main();
}
