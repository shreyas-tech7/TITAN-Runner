/**
 * @file How a workflow calls the titan-runner-brain Worker (Wave 12, K8).
 *
 * Callbacks use the callback token (`TITAN_CALLBACK_TOKEN`, header `X-Titan-Callback`). The Worker makes it and writes
 * the secret, so no person handles it. A script falls back to the admin token only when the callback token is empty,
 * which is the case until the Worker makes the first one. Every call is best effort: a failed call returns a result and
 * never throws, so a broken callback cannot fail a pulse or a task by itself.
 */

/** @param {NodeJS.ProcessEnv} [env] @returns {{ headers: Record<string,string>, kind: 'callback'|'admin' } | null} */
export function callbackAuth(env = process.env) {
  const cb = (env.TITAN_CALLBACK_TOKEN ?? '').trim();
  if (cb) return { headers: { 'X-Titan-Callback': cb }, kind: 'callback' };
  const admin = (env.TITAN_ADMIN_TOKEN ?? '').trim();
  if (admin) return { headers: { 'X-Titan-Auth': admin }, kind: 'admin' };
  return null;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function workerBase(env = process.env) {
  return (env.TITAN_WORKER_URL ?? '').trim().replace(/\/+$/, '');
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number|null, kind?: string, json?: any, error?: string }>}
 */
export async function callWorker(path, opts = {}) {
  const env = opts.env ?? process.env;
  const base = workerBase(env);
  const auth = callbackAuth(env);
  if (!base || !auth) return { ok: false, status: null, error: 'TITAN_WORKER_URL or a callback token is not set' };
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${base}${path}`, {
      method: opts.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    let json;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, kind: auth.kind, json };
  } catch (err) {
    return { ok: false, status: null, kind: auth.kind, error: err instanceof Error ? err.message : 'network error' };
  }
}
