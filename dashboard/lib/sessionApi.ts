"use client";

/**
 * Sign in to the Worker with the admin token and get a session (RT5). The session token expires: after a time with no
 * use (the idle limit) and after a fixed time in all (the absolute limit). The browser keeps the session token, so the
 * long-lived admin token is typed once and is not kept. When a request answers 401 the session is over and the person
 * signs in again.
 *
 * An older Worker has no `/auth/login`. Then the Worker answers 404 and the admin token is used as it is, as before.
 */
import { isWorkerConfigured, workerUrl } from "./workerApi";

export type LoginResult =
  | { kind: "session"; token: string; expiresAt: string | null; idleSeconds: number | null; absoluteSeconds: number | null }
  | { kind: "token" };

export class LoginError extends Error {
  status: number | null;
  retryAfterSeconds: number | null;
  constructor(message: string, status: number | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "LoginError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** "Try again in 14 minutes." Rounds up, so the person does not try one second too early. */
export function waitWords(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "Try again later.";
  if (seconds < 90) return `Try again in ${Math.ceil(seconds)} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `Try again in ${minutes} minutes.` : `Try again in ${Math.ceil(minutes / 60)} hours.`;
}

export async function login(adminToken: string, fetchImpl: typeof fetch = fetch): Promise<LoginResult> {
  if (!isWorkerConfigured()) return { kind: "token" };
  let res: Response;
  try {
    res = await fetchImpl(`${workerUrl()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: adminToken }),
      cache: "no-store",
    });
  } catch {
    throw new LoginError("Could not reach the Worker. Check your connection and try again.");
  }
  if (res.status === 404 || res.status === 405) return { kind: "token" };
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: number };
    const retry = Number(res.headers.get("Retry-After") ?? body.retryAfterSeconds ?? NaN);
    throw new LoginError(`Too many wrong tokens. ${waitWords(Number.isFinite(retry) ? retry : null)}`, 429, Number.isFinite(retry) ? retry : null);
  }
  if (res.status === 401) throw new LoginError("That token was rejected by the Worker.", 401);
  if (res.status === 503) throw new LoginError("The Worker has no admin token yet. Set TITAN_ADMIN_TOKEN on the Worker first.", 503);
  if (!res.ok) throw new LoginError(`The Worker answered ${res.status}. Try again.`, res.status);
  const body = (await res.json().catch(() => null)) as { session?: string; expires_at?: string; idle_timeout_seconds?: number; absolute_timeout_seconds?: number } | null;
  if (!body || typeof body.session !== "string" || body.session.length < 8) throw new LoginError("The Worker answered in a shape that this page does not know.", res.status);
  return { kind: "session", token: body.session, expiresAt: body.expires_at ?? null, idleSeconds: body.idle_timeout_seconds ?? null, absoluteSeconds: body.absolute_timeout_seconds ?? null };
}

/** End the session on the Worker. It never throws: the page forgets the session either way. */
export async function logout(sessionToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!isWorkerConfigured() || sessionToken === "demo-token") return;
  try {
    await fetchImpl(`${workerUrl()}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json", "X-Titan-Auth": sessionToken }, body: "{}", cache: "no-store" });
  } catch {
    // The session ends by itself at its idle limit.
  }
}

export type UnlockResult = { ok: true; token: string; kind: "session" | "token" } | { ok: false; error: string };

/**
 * Turn what a person typed into the token that the page keeps. A Worker with sessions gives a session token. An older
 * Worker has no sessions, so the typed token is checked with one read and then used as it is. Only a wrong token or a
 * lockout stops the person. A Worker that answers an odd error on the older path does not lock the person out.
 */
export async function unlock(
  adminToken: string,
  deps: { fetchImpl?: typeof fetch; verifyToken?: (token: string) => Promise<unknown> } = {},
): Promise<UnlockResult> {
  const typed = adminToken.trim();
  if (!typed) return { ok: false, error: "Type the admin token first." };
  if (!isWorkerConfigured()) return { ok: true, token: typed, kind: "token" };
  try {
    const result = await login(typed, deps.fetchImpl);
    if (result.kind === "session") return { ok: true, token: result.token, kind: "session" };
  } catch (err) {
    return { ok: false, error: err instanceof LoginError ? err.message : "The sign-in failed. Try again." };
  }
  // The older Worker.
  try {
    await (deps.verifyToken ?? (async (t: string) => { const { fetchStatus } = await import("./workerApi"); return fetchStatus(t); }))(typed);
  } catch (err) {
    if ((err as { status?: number })?.status === 401) return { ok: false, error: "That token was rejected by the Worker." };
  }
  return { ok: true, token: typed, kind: "token" };
}
