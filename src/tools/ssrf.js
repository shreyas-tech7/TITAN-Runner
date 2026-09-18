/**
 * @file Egress guard for the one tool that can reach the network
 * (`http_fetch`). A model-chosen URL is untrusted input: it can name a
 * cloud metadata endpoint, a loopback service, or a private address that
 * resolves from a public-looking host name. So a URL is allowed only when:
 *
 *   1. it is `https:` (no other scheme, no credentials in the URL);
 *   2. its host is on the operator's allowlist (`TITAN_EGRESS_ALLOWLIST`,
 *      exact hosts or `.suffix` entries; empty means nothing is allowed);
 *   3. every address the host resolves to is public — no loopback, RFC 1918,
 *      link-local, CGNAT, multicast, or IPv6 equivalents (rebinding is
 *      defended by resolving here and connecting to the checked address);
 *   4. redirects are not followed (the tool asks for `redirect: 'manual'`
 *      and treats a 3xx as a refusal, so a public host cannot bounce the
 *      request somewhere private).
 *
 * `lookup` is injectable so the tests never touch DNS.
 */
import { isIP } from 'node:net';
import dns from 'node:dns/promises';

/** @param {string} ip @returns {boolean} true when the address is not publicly routable. */
export function isPrivateAddress(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24 (docs)
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('ff')) return true; // multicast
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower.startsWith('64:ff9b:')) return true; // NAT64 — could map to anything
    if (lower.startsWith('2001:db8')) return true; // documentation
    return false;
  }
  return true; // not an IP at all: refuse
}

/**
 * @param {string} raw Comma/space separated list of hosts; `.example.com` allows every subdomain.
 * @returns {string[]}
 */
export function parseAllowlist(raw) {
  return String(raw ?? '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host, allowlist) {
  return allowlist.some((entry) => (entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry));
}

/**
 * @param {string} url
 * @param {{ allowlist: string[], lookup?: (host: string) => Promise<Array<{address: string}>> }} opts
 * @returns {Promise<{ ok: true, url: URL, addresses: string[] } | { ok: false, reason: string }>}
 */
export async function checkEgress(url, opts) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: `only https: is allowed (got ${parsed.protocol})` };
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'empty host' };
  if (isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'a literal IP address is not allowed' };
  if (!hostAllowed(host, opts.allowlist ?? [])) return { ok: false, reason: `host ${host} is not on the egress allowlist` };

  let records;
  try {
    const lookup = opts.lookup ?? ((h) => dns.lookup(h, { all: true }));
    records = await lookup(host);
  } catch (err) {
    return { ok: false, reason: `could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const addresses = (records ?? []).map((r) => (typeof r === 'string' ? r : r.address)).filter(Boolean);
  if (addresses.length === 0) return { ok: false, reason: `${host} resolved to no addresses` };
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad) return { ok: false, reason: `${host} resolves to a non-public address` };
  return { ok: true, url: parsed, addresses };
}

export default { isPrivateAddress, parseAllowlist, checkEgress };
