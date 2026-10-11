/**
 * @file Host status and uptime (RO5).
 *
 * The probe checks the hosts that TITAN depends on and records one of three statuses (contract v1):
 *
 *   up      the host answers
 *   asleep  the host is asleep by design and wakes on a request. This is not an outage.
 *   down    the host does not answer, or answers with an error
 *
 * Hosts, and how each one is checked:
 *   github_actions  the time of the last successful run of the pulse workflow. Stale after 45 minutes means down.
 *   github_status   the public status API of GitHub (githubstatus.com).
 *   hf_space        the Hugging Face API says if the Space runs, sleeps, or is broken. The probe never wakes the Space.
 *   render_1..3     a Render free service. It sleeps after 15 minutes without a request. The probe waits up to 75 seconds.
 *                   An answer that took 15 seconds or more means that the service was asleep and woke up. That is `asleep`.
 *   titan_gev       the TITAN-GEV host on Render. The same rule.
 *   hermes_1..3     a Hermes agent on Railway. The probe asks for the model list with NO key. 200, 401, or 403 means up.
 *
 * A host whose URL secret is not set is skipped. It gets no entry. The URLs stay in secrets. Only host NAMES go to D1,
 * to the mirror, and to an alert. Render free services share 750 instance hours a month, so Render hosts are probed
 * at most every 5.5 hours, and a probe never tries to keep one awake.
 */
import { checkEgress } from '../tools/ssrf.js';

export const PULSE_STALE_MS = 45 * 60_000;
export const RENDER_COLD_MS = 15_000;
export const RENDER_TIMEOUT_MS = 75_000;
export const RENDER_MIN_INTERVAL_MS = 5.5 * 3_600_000;
export const HISTORY_DAYS = 30;
const CODE = { up: 'u', asleep: 'a', down: 'd' };
const STATUS = { u: 'up', a: 'asleep', d: 'down' };

/**
 * The hosts that this run can check. A host without a URL is left out.
 * @param {Record<string, string|undefined>} env
 * @returns {Array<{ name: string, kind: string, url: string|null, minIntervalMs: number }>}
 */
export function configuredHosts(env) {
  const hosts = [
    { name: 'github_actions', kind: 'github-pulse', url: null, minIntervalMs: 0 },
    { name: 'github_status', kind: 'github-status', url: null, minIntervalMs: 0 },
  ];
  const add = (name, kind, url, minIntervalMs = 0) => { if (url && String(url).trim()) hosts.push({ name, kind, url: String(url).trim(), minIntervalMs }); };
  add('hf_space', 'hf-space', env.HOST_URL_HF_SPACE);
  for (const n of [1, 2, 3]) add(`render_${n}`, 'render', env[`HOST_URL_RENDER_${n}`], RENDER_MIN_INTERVAL_MS);
  add('titan_gev', 'render', env.HOST_URL_GEV || env.GEV_URL, RENDER_MIN_INTERVAL_MS);
  for (const n of [1, 2, 3]) add(`hermes_${n}`, 'hermes', env[`HOST_URL_HERMES_${n}`] || env[`HERMES_${n}_BASE_URL`]);
  return hosts;
}

/** The owner and the name of a Space, from a `*.hf.space` URL, a huggingface.co/spaces URL, or `owner/name`. */
export function parseSpace(value) {
  const v = String(value ?? '').trim().replace(/\/+$/, '');
  let m = v.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (m) return { owner: m[1], name: m[2] };
  m = v.match(/^https:\/\/huggingface\.co\/spaces\/([^/]+)\/([^/?#]+)/i);
  if (m) return { owner: m[1], name: m[2] };
  m = v.match(/^https:\/\/([a-z0-9-]+)\.hf\.space/i);
  if (m) return null; // A hf.space host name joins the owner and the name with a hyphen. It cannot be split safely.
  return null;
}

/** Map the runtime stage of a Space to a status. */
export function spaceStatus(stage) {
  const s = String(stage ?? '').toUpperCase();
  if (s === 'RUNNING') return 'up';
  if (['SLEEPING', 'BUILDING', 'RUNNING_BUILDING', 'APP_STARTING', 'RUNNING_APP_STARTING'].includes(s)) return 'asleep';
  return 'down';
}

/** Map the indicator of the GitHub status API to a status. */
export function githubStatus(indicator) {
  return ['major', 'critical'].includes(String(indicator)) ? 'down' : 'up';
}

async function safeUrl(url, lookup) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  return checkEgress(url, { allowlist: [host], lookup });
}

const elapsed = (clock, since) => Math.round(clock() - since);

/** Remove the URL and its host name from a reason. The URL is a secret, so no text that leaves this module may hold it. */
function scrub(text, url) {
  let out = String(text ?? '').replace(/https?:\/\/\S+/gi, '[url]');
  try {
    const { hostname } = new URL(url);
    if (hostname) out = out.split(hostname).join('[host]').split(hostname.toLowerCase()).join('[host]');
  } catch {
    // A URL that does not parse has no host name to remove.
  }
  return out.slice(0, 80);
}

/**
 * Probe one host.
 * @param {{ name: string, kind: string, url: string|null }} host
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date, clock?: () => number, lookup?: Function, pulse?: () => Promise<{ lastSuccessAt: string|null }|null>, hfToken?: string, renderTimeoutMs?: number }} [deps]
 * @returns {Promise<{ host: string, status: 'up'|'asleep'|'down', latency_ms: number|null, last_check: string, last_pulse_at?: string|null, reason: string }|null>} Null when nothing can be said.
 */
export async function probeHost(host, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());
  const result = (status, latency, reason, extra = {}) => ({ host: host.name, status, latency_ms: latency, last_check: now().toISOString(), reason, ...extra });

  if (host.kind === 'github-pulse') {
    const info = await deps.pulse?.().catch(() => null);
    if (!info) return null; // GitHub did not answer: no evidence, so no entry
    const last = info.lastSuccessAt ? Date.parse(info.lastSuccessAt) : NaN;
    if (!Number.isFinite(last)) return result('down', null, 'no successful pulse found', { last_pulse_at: null });
    const age = now().getTime() - last;
    return result(age > PULSE_STALE_MS ? 'down' : 'up', null, age > PULSE_STALE_MS ? `the last successful pulse is ${Math.round(age / 60_000)} minutes old` : 'the pulse is current', { last_pulse_at: new Date(last).toISOString() });
  }

  if (host.kind === 'github-status') {
    const started = clock();
    try {
      const res = await fetchImpl('https://www.githubstatus.com/api/v2/status.json', { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      if (!res.ok) return null;
      const body = await res.json();
      return result(githubStatus(body?.status?.indicator), elapsed(clock, started), `indicator ${String(body?.status?.indicator ?? 'unknown').slice(0, 20)}`);
    } catch {
      return null;
    }
  }

  if (host.kind === 'hf-space') {
    const space = parseSpace(host.url);
    if (!space) return result('down', null, 'the Space URL secret is not owner/name or a huggingface.co/spaces URL');
    const started = clock();
    try {
      const res = await fetchImpl(`https://huggingface.co/api/spaces/${encodeURIComponent(space.owner)}/${encodeURIComponent(space.name)}`, {
        headers: deps.hfToken ? { authorization: `Bearer ${deps.hfToken}` } : {}, signal: AbortSignal.timeout(15_000), redirect: 'manual',
      });
      const latency = elapsed(clock, started);
      if (res.status === 404) return result('down', latency, 'the Space was not found');
      if (!res.ok) return result('down', latency, `the Hub answered ${res.status}`);
      const body = await res.json();
      const stage = body?.runtime?.stage ?? null;
      return result(spaceStatus(stage), latency, `runtime ${String(stage ?? 'unknown').slice(0, 30)}`);
    } catch {
      return null; // the Hub itself did not answer. That says nothing about the Space.
    }
  }

  if (!host.url) return null;
  const guard = await safeUrl(host.url, deps.lookup);
  if (!guard.ok) return result('down', null, `the URL was refused (${scrub(guard.reason, host.url)})`);

  if (host.kind === 'render') {
    const started = clock();
    try {
      const res = await fetchImpl(host.url, { signal: AbortSignal.timeout(deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS), redirect: 'manual' });
      const latency = elapsed(clock, started);
      await res.arrayBuffer().catch(() => null);
      if (res.status >= 500) return result('down', latency, `answered ${res.status}`);
      return result(latency >= RENDER_COLD_MS ? 'asleep' : 'up', latency, latency >= RENDER_COLD_MS ? 'a cold start: it was asleep and woke up' : `answered ${res.status}`);
    } catch (err) {
      return result('down', elapsed(clock, started), err?.name === 'TimeoutError' ? 'no answer in 75 seconds' : 'no connection');
    }
  }

  if (host.kind === 'hermes') {
    // No key is sent. A running agent answers 401 to the model list. A missing app answers 404.
    const started = clock();
    try {
      const res = await fetchImpl(`${host.url.replace(/\/+$/, '')}/v1/models`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      const latency = elapsed(clock, started);
      await res.arrayBuffer().catch(() => null);
      return [200, 401, 403].includes(res.status) ? result('up', latency, `answered ${res.status}`) : result('down', latency, `answered ${res.status}`);
    } catch {
      return result('down', elapsed(clock, started), 'no connection');
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// History and uptime
// ---------------------------------------------------------------------

/** @typedef {{ version: number, hosts: Record<string, Array<[string, 'u'|'a'|'d']>> }} History */

/** @returns {History} */
export function emptyHistory() {
  return { version: 1, hosts: {} };
}

/** Add the results of one run, and drop what is older than 30 days. @returns {History} */
export function updateHistory(history, results, now = new Date()) {
  const out = { version: 1, hosts: { ...(history?.hosts ?? {}) } };
  const cutoff = now.getTime() - HISTORY_DAYS * 86_400_000;
  for (const r of results) {
    const list = [...(out.hosts[r.host] ?? []), [r.last_check, CODE[r.status]]];
    out.hosts[r.host] = list.filter(([t]) => Date.parse(t) >= cutoff);
  }
  return out;
}

/** The share of checks in a window where the host was up or asleep, as a percent. Null when there is no check. */
export function uptime(history, host, windowMs, now = new Date()) {
  const since = now.getTime() - windowMs;
  const inWindow = (history.hosts[host] ?? []).filter(([t]) => Date.parse(t) >= since);
  if (inWindow.length === 0) return null;
  const good = inWindow.filter(([, c]) => c !== 'd').length;
  return Math.round((good / inWindow.length) * 1000) / 10;
}

/** Whether a host has failed its last two checks. */
export function failedTwice(history, host) {
  const list = history.hosts[host] ?? [];
  return list.length >= 2 && list.at(-1)[1] === 'd' && list.at(-2)[1] === 'd';
}

/** The public mirror: `state/ops/hosts.json`. Host names only. */
export function hostsMirror(history, latest, now = new Date()) {
  const hosts = {};
  for (const name of Object.keys(history.hosts).sort()) {
    const list = history.hosts[name];
    if (list.length === 0) continue;
    const [lastCheck, code] = list.at(-1);
    hosts[name] = {
      status: STATUS[code], last_check: lastCheck,
      uptime_24h: uptime(history, name, 86_400_000, now), uptime_7d: uptime(history, name, 7 * 86_400_000, now), uptime_30d: uptime(history, name, 30 * 86_400_000, now),
    };
    if (name === 'github_actions') hosts[name].last_pulse_at = latest?.[name]?.last_pulse_at ?? null;
  }
  return { contract: '1', generated_at: now.toISOString(), hosts };
}

/**
 * Decide the alerts. Two checks in a row that failed open an alert. The pulse workflow counts at once when it is stale.
 * Anything that is not down closes the alert.
 * @returns {Array<{ action: 'open'|'close', host: string, title: string, body: string }>}
 */
export function alertPlan(history, results) {
  const plan = [];
  for (const r of results) {
    const title = `Host down: ${r.host}`;
    const stale = r.host === 'github_actions' && r.status === 'down';
    if (r.status === 'down' && (stale || failedTwice(history, r.host))) {
      plan.push({
        action: 'open', host: r.host, title,
        body: [`The host ${r.host} is down.`, stale ? `The pulse workflow has no successful run in the last 45 minutes. The last one was at ${r.last_pulse_at ?? 'an unknown time'}.` : 'It failed its last 2 checks in a row.', `Checked at ${r.last_check}.`, 'The dashboard shows the host status panel. This Issue closes by itself when the host is back.'].join('\n\n'),
      });
    } else if (r.status !== 'down') {
      plan.push({ action: 'close', host: r.host, title, body: `The host ${r.host} is ${r.status} again at ${r.last_check}.` });
    }
  }
  return plan;
}

export default { configuredHosts, probeHost, updateHistory, uptime, hostsMirror, alertPlan, failedTwice, spaceStatus, githubStatus, parseSpace };
