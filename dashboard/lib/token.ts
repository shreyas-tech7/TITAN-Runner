"use client";

/**
 * The fine-grained PAT the user pastes once (task instructions, section 1).
 * Stored in `localStorage` under a namespaced key, never sent anywhere but
 * `api.github.com`, never logged, never committed, never written into any
 * `state/*.json` this dashboard reads (it lives entirely client-side — this
 * is a static export with no backend to send it to even by accident).
 *
 * Scope the token needs, exactly: this repository only
 * (shreyas-tech7/TITAN-Runner), "Issues" permission set to Read and write,
 * nothing else. See `components/SettingsPanel.tsx` for the in-app copy
 * explaining why that scope is safe to paste into a browser tab.
 */

const STORAGE_KEY = "titan-runner:github-pat:v1";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing / storage disabled — treat exactly like "no token set".
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, token.trim());
  } catch {
    // Best-effort — a page reload will just show the token field empty again.
  }
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}

/** e.g. "github_pat_11AB••••••••••••3xZ9" — enough to recognize which token this is, never enough to reuse. */
export function maskToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 10)}${"•".repeat(10)}${token.slice(-4)}`;
}
