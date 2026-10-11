/**
 * @file The doorbell (RO6). TITAN has no clock of its own on a free host, so Runner rings it on a schedule.
 *
 * A ring is `POST {TITAN_BACKEND_URL}/api/scheduled/{job}` with the secret DOORBELL_TOKEN as a bearer token and no body.
 * The jobs are:
 *
 *   digest         every day at 06:30 in America/Chicago
 *   weekly-review  every Sunday at 18:00 in America/Chicago
 *   sweep          every 15 minutes
 *
 * Only the status code of the answer is kept. The answer body is never read, so a digest or a note can not reach the
 * logs, the Worker, or this public repository. The backend URL and the token stay in secrets, and neither one goes
 * to a log line. A ring never follows a redirect, so the token goes only to the host that the secret names.
 *
 * GitHub cron uses UTC and Chicago changes its offset twice a year. So each of the two timed jobs has two crons, and
 * `planRun` lets only the one that falls on the right Chicago time go on.
 */
import { checkEgress } from '../tools/ssrf.js';

export const JOBS = Object.freeze(['digest', 'weekly-review', 'sweep']);
export const TIMEZONE = 'America/Chicago';
export const RING_TIMEOUT_MS = 60_000;

/** The cron strings of `doorbell.yml`, and the job that each one rings. A test keeps this table and the file in step. */
export const CRONS = Object.freeze({
  '*/15 * * * *': 'sweep',
  '30 11 * * *': 'digest', // 06:30 CDT
  '30 12 * * *': 'digest', // 06:30 CST
  '0 23 * * 0': 'weekly-review', // Sunday 18:00 CDT
  '0 0 * * 1': 'weekly-review', // Sunday 18:00 CST
});

/** The weekday (Mon=1 to Sun=7) and the hour (0 to 23) in Chicago. */
export function chicagoParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return { day, hour: Number(get('hour')) };
}

/**
 * Decide which job to ring.
 * @param {{ job?: string|null, schedule?: string|null, now?: Date }} input A `job` is a manual run: it always goes on.
 * @returns {{ job: string|null, proceed: boolean, reason: string }}
 */
export function planRun({ job = null, schedule = null, now = new Date() } = {}) {
  if (job) {
    if (!JOBS.includes(job)) return { job: null, proceed: false, reason: `"${String(job).slice(0, 30)}" is not a doorbell job` };
    return { job, proceed: true, reason: 'a manual run' };
  }
  const scheduled = CRONS[String(schedule ?? '').trim()];
  if (!scheduled) return { job: null, proceed: false, reason: 'the schedule is not one of the doorbell crons' };
  const { day, hour } = chicagoParts(now);
  if (scheduled === 'digest' && hour !== 6) return { job: scheduled, proceed: false, reason: `it is hour ${hour} in Chicago, not 06. This cron is the other one of the pair` };
  if (scheduled === 'weekly-review' && !(day === 7 && hour === 18)) return { job: scheduled, proceed: false, reason: `it is day ${day} hour ${hour} in Chicago, not Sunday 18. This cron is the other one of the pair` };
  return { job: scheduled, proceed: true, reason: 'on time' };
}

/** The ring URL, or null when the backend URL is not usable. */
export function ringUrl(backendUrl, job) {
  if (!JOBS.includes(job)) return null;
  let base;
  try {
    base = new URL(String(backendUrl ?? '').trim());
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return null;
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/api/scheduled/${job}`;
}

/**
 * Ring the doorbell once.
 * @param {string} job
 * @param {{ backendUrl?: string, token?: string, fetchImpl?: typeof fetch, lookup?: Function, timeoutMs?: number }} deps
 * @returns {Promise<{ status: 'skipped'|'rung'|'failed', status_code: number|null, reason: string }>}
 *   `skipped` means the secrets are not set. Nothing was sent, and that is not an error.
 */
export async function ringDoorbell(job, deps = {}) {
  if (!deps.backendUrl || !deps.token) return { status: 'skipped', status_code: null, reason: 'TITAN_BACKEND_URL or DOORBELL_TOKEN is not set' };
  const url = ringUrl(deps.backendUrl, job);
  if (!url) return { status: 'failed', status_code: null, reason: 'the backend URL is not a usable https URL' };
  const guard = await checkEgress(url, { allowlist: [new URL(url).hostname.toLowerCase()], lookup: deps.lookup });
  if (!guard.ok) return { status: 'failed', status_code: null, reason: 'the backend URL was refused by the egress guard' };
  const fetchImpl = deps.fetchImpl ?? ((u, init) => globalThis.fetch(u, init));
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? RING_TIMEOUT_MS),
    });
    // The body is dropped on purpose. Only the code is kept.
    res.body?.cancel?.().catch?.(() => {});
    return { status: res.status >= 200 && res.status < 300 ? 'rung' : 'failed', status_code: res.status, reason: `answered ${res.status}` };
  } catch (err) {
    return { status: 'failed', status_code: null, reason: err?.name === 'TimeoutError' ? 'no answer in time' : 'no connection' };
  }
}

export default { JOBS, CRONS, planRun, ringUrl, ringDoorbell, chicagoParts };
