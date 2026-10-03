/**
 * The Content Security Policy for the dashboard page, delivered as a meta tag because GitHub Pages cannot
 * send response headers (Wave 11).
 *
 * What it does and does not do. A static export carries inline scripts and styles, so `script-src` and
 * `style-src` keep `'unsafe-inline'`. What the policy still stops is loading a script from any other
 * site, and, more important for a page that holds tokens, sending anything anywhere except the few hosts
 * the dashboard really talks to (`connect-src`). A script that got into the page could read a token but
 * could not post it to a stranger's server. `frame-ancestors` and `report-uri` cannot be set from a meta
 * tag, so framing is not covered here.
 */

export interface CspInput {
  /** `NEXT_PUBLIC_TITAN_WORKER_URL`, or empty when no Worker is set. */
  worker: string;
  /** The God's Eye View origin from `parseGevUrl`, or null. */
  gevOrigin: string | null;
}

function origin(raw: string): string | null {
  if (!raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password) return null;
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function buildRunnerCsp({ worker, gevOrigin }: CspInput): string {
  // The God's Eye View tab asks the host for /healthz from the browser, so its origin belongs in connect-src as well as frame-src.
  const connect = ["'self'", "https://raw.githubusercontent.com", "https://api.github.com", "https://api.open-meteo.com", origin(worker), gevOrigin].filter((x): x is string => Boolean(x));
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    `frame-src ${gevOrigin ?? "'none'"}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}
