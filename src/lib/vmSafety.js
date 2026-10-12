/**
 * @file Safety helpers for railway.new VMs (RT6). Pure. The runner script and the Worker both use them.
 *
 * A VM is untrusted. It runs code that Runner did not write, on a host that Runner does not control. So:
 *   - no provider key and no token goes to a VM, in an environment variable, an argument, or a file;
 *   - a VM lives for a short time. Runner stops treating it as live after the cap, even if Railway keeps it;
 *   - a preview URL and a claim URL are cleaned so they carry no query, no user name, and no token.
 */

export const DEFAULT_MAX_LIFETIME_MINUTES = 120;
export const MIN_LIFETIME_MINUTES = 10;
export const MAX_LIFETIME_MINUTES = 1440;

/** Environment variable names that may reach the ssh child process. Nothing else does. */
const SSH_ENV_ALLOW = ['PATH', 'LANG', 'TZ', 'TMPDIR'];

/**
 * The environment of the ssh child. It holds the PATH and a few locale values. It holds no key and no token.
 * @param {Record<string, string|undefined>} env
 * @param {string} home A temporary home directory.
 */
export function sshEnv(env, home) {
  const out = { HOME: home };
  for (const name of SSH_ENV_ALLOW) if (typeof env[name] === 'string') out[name] = env[name];
  return out;
}

/** The lifetime cap in minutes. `TITAN_VM_MAX_LIFETIME_MINUTES` sets it. The value is clamped. */
export function maxLifetimeMinutes(env) {
  const raw = Number.parseInt(String(env?.TITAN_VM_MAX_LIFETIME_MINUTES ?? ''), 10);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_LIFETIME_MINUTES;
  return Math.min(MAX_LIFETIME_MINUTES, Math.max(MIN_LIFETIME_MINUTES, raw));
}

/**
 * Cap a deadline. A missing or bad value becomes the cap. A later value is cut to the cap.
 * @param {string|null|undefined} value An ISO 8601 time.
 * @param {number} nowMs
 * @param {number} maxMinutes
 * @returns {string} An ISO 8601 time.
 */
export function capDeadline(value, nowMs, maxMinutes) {
  const ceiling = nowMs + maxMinutes * 60_000;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return new Date(ceiling).toISOString();
  return new Date(Math.min(parsed, ceiling)).toISOString();
}

/**
 * A preview URL that is safe to store and show. Only https on `*.up.railway.app`. No user name, no port, no query,
 * no fragment, and no path. Returns null for anything else.
 * @param {unknown} url
 * @returns {string|null}
 */
export function sanitizePreviewUrl(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!/^[a-z0-9-]+\.up\.railway\.app$/i.test(u.hostname)) return null;
  if (u.username || u.password || u.port) return null;
  return `https://${u.hostname.toLowerCase()}/`;
}

/**
 * A claim URL that is safe to store. Only `https://railway.com/ssh-signup?code=<code>`. The code is the one secret
 * in it. The Worker stores it and shows it only to a signed in person. A log line never carries it.
 * @param {unknown} url
 * @returns {string|null}
 */
export function sanitizeClaimUrl(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'railway.com' || u.pathname !== '/ssh-signup') return null;
  const code = u.searchParams.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(code) || [...u.searchParams.keys()].length !== 1) return null;
  return `https://railway.com/ssh-signup?code=${code}`;
}

/** Remove the claim code from a text that is about to be logged. */
export function hideClaimCode(text) {
  return String(text ?? '').replace(/(ssh-signup\?code=)[A-Za-z0-9_-]+/g, '$1[hidden]');
}

export default { sshEnv, maxLifetimeMinutes, capDeadline, sanitizePreviewUrl, sanitizeClaimUrl, hideClaimCode };
