"use client";

/**
 * The titan-runner-brain Worker's admin token (build brief, section 4/5) —
 * a separate credential from `lib/token.ts`'s GitHub PAT, with a different
 * purpose: this one gates the *entire* dashboard (build brief: "private by
 * default, not just protecting the write actions"), while the PAT only
 * lets the dashboard file/cancel/retry issues on the visitor's behalf.
 *
 * Same storage contract as `lib/token.ts`: localStorage only, namespaced
 * key, never logged, never committed, never sent anywhere but the Worker's
 * own origin as the `X-Titan-Auth` header.
 */

const STORAGE_KEY = "titan-runner:admin-token:v1";

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing / storage disabled — treat exactly like "no token set".
    return null;
  }
}

export function setAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, token.trim());
  } catch {
    // Best-effort — a page reload will just show the lock screen again.
  }
}

export function clearAdminToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}
