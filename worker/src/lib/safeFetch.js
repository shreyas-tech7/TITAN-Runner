/**
 * @file The one outbound guard of the Worker (Wave 12, S4, decision W12-D9).
 *
 * Every outbound call goes through `safeFetch()`. It permits:
 *   - the https scheme only, on the default port, with no user name or password in the URL;
 *   - hosts from an allowlist only (an exact host, or `.suffix` for subdomains);
 *   - public hosts only: no IP literal, no single label host, no local or internal name, and, for a host
 *     that a person typed, an optional DNS check over HTTPS that refuses a private address.
 * It never follows a redirect, because a public host could bounce the call to a private address. It stops
 * after a time limit and after a size limit. It never writes an auth header to a log.
 *
 * Tests: with `TITAN_TEST_MODE=1`, the variable `TITAN_TEST_HOST_MAP` (JSON) maps a real host to a local
 * fake origin such as `http://127.0.0.1:9100/prefix`. The allowlist check still runs on the real host.
 * `scripts/check-test-mode.mjs` fails CI if `wrangler.toml` ever sets the flag.
 */

export class SafeFetchError extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number }} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
    this.status = extra.status ?? null;
  }
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.test', '.invalid'];

/** @param {string} host Lowercase host name. @returns {boolean} True when the host looks like an IP address. */
export function looksLikeIp(host) {
  if (host.includes(':')) return true; // IPv6 literal
  if (/^\d+$/.test(host)) return true; // decimal form of an IPv4 address
  if (/^0x[0-9a-f]+$/i.test(host)) return true; // hex form
  return /^\d{1,3}(\.\d{1,3}){1,3}$/.test(host); // dotted forms, including short ones
}

/** @param {string} ip @returns {boolean} True when the address is not publicly routable. */
export function isPrivateAddress(ip) {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return a >= 224;
  }
  const lower = ip.toLowerCase();
  if (!lower.includes(':')) return true;
  if (lower === '::' || lower === '::1') return true;
  if (/^fe[89ab]/.test(lower) || /^f[cd]/.test(lower) || lower.startsWith('ff')) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8');
}

/** @param {string} host @param {string[]} allow */
export function hostAllowed(host, allow) {
  return allow.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('.') ? host === e.slice(1) || host.endsWith(e) : host === e;
  });
}

/**
 * Check a URL against the rules, without any network call.
 * @param {string|URL} input
 * @param {string[]} allow
 * @returns {{ ok: true, url: URL, host: string } | { ok: false, code: string, message: string }}
 */
export function checkUrl(input, allow) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { ok: false, code: 'bad_url', message: 'The address is not valid.' };
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'not_https', message: 'The address must use https.' };
  if (url.username || url.password) return { ok: false, code: 'credentials_in_url', message: 'The address must not hold a user name or a password.' };
  if (url.port && url.port !== '443') return { ok: false, code: 'bad_port', message: 'The address must use the default https port.' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || looksLikeIp(host) || !host.includes('.') || host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, code: 'not_public', message: 'The address must use a public host name.' };
  }
  if (!hostAllowed(host, allow)) return { ok: false, code: 'host_not_allowed', message: `The host ${host} is not on the allowlist.` };
  return { ok: true, url, host };
}

function testHostMap(env) {
  if (env?.TITAN_TEST_MODE !== '1' || !env.TITAN_TEST_HOST_MAP) return null;
  try {
    return JSON.parse(env.TITAN_TEST_HOST_MAP);
  } catch {
    return null;
  }
}

/** Rewrite the origin of a checked URL to a local fake. Used only when the test flag is set. */
function rewriteForTest(map, url) {
  const target = map?.[url.hostname.toLowerCase()];
  if (!target) return url;
  const base = new URL(target);
  const next = new URL(url.toString());
  next.protocol = base.protocol;
  next.host = base.host;
  next.pathname = `${base.pathname.replace(/\/$/, '')}${url.pathname}`;
  return next;
}

/** Wrap a response body so it fails after `maxBytes`. */
function limitBody(res, maxBytes) {
  if (!res.body) return res;
  let seen = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new SafeFetchError('response_too_large', `The response is larger than ${maxBytes} bytes.`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(res.body.pipeThrough(limiter), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** DNS over HTTPS, cached by the caller. Returns the addresses of a host, or null when the lookup failed. */
export async function resolveHost(env, host) {
  const addresses = [];
  for (const type of ['A', 'AAAA']) {
    try {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      });
      if (!res.ok) return null;
      const body = await res.json();
      for (const answer of body.Answer ?? []) if (answer.type === (type === 'A' ? 1 : 28) && typeof answer.data === 'string') addresses.push(answer.data);
    } catch {
      return null;
    }
  }
  return addresses;
}

/**
 * @param {Record<string, any>} env
 * @param {string|URL} input
 * @param {RequestInit} [init]
 * @param {{ allow: string[], timeoutMs?: number, maxBytes?: number, checkDns?: boolean }} opts
 * @returns {Promise<Response>}
 */
export async function safeFetch(env, input, init = {}, opts) {
  const checked = checkUrl(input, opts.allow);
  if (!checked.ok) throw new SafeFetchError(checked.code, checked.message);
  const map = testHostMap(env);

  if (opts.checkDns && !map) {
    const addresses = await resolveHost(env, checked.host);
    if (addresses === null) throw new SafeFetchError('dns_failed', `The host ${checked.host} could not be resolved.`);
    if (addresses.length === 0) throw new SafeFetchError('dns_empty', `The host ${checked.host} has no address.`);
    if (addresses.some(isPrivateAddress)) throw new SafeFetchError('not_public', `The host ${checked.host} resolves to a private address.`);
  }

  const target = map ? rewriteForTest(map, checked.url) : checked.url;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
  let res;
  try {
    res = await fetch(target.toString(), { ...init, redirect: 'manual', signal });
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    const timedOut = timeout.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new SafeFetchError(timedOut ? 'timeout' : 'network', timedOut ? `The call to ${checked.host} timed out.` : `The call to ${checked.host} failed.`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new SafeFetchError('redirect_refused', `${checked.host} answered with a redirect. The Worker does not follow redirects.`, { status: res.status });
  }
  return limitBody(res, opts.maxBytes ?? 1_000_000);
}
