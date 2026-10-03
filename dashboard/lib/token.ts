"use client";

import { browserStores, clearSecret, readSecret, whereStored, writeSecret } from "./secretStore";
import type { Where } from "./secretStore";

/**
 * The fine-grained PAT the user pastes once (task instructions, section 1).
 * Stored in this tab's `sessionStorage` by default, or in `localStorage` only when the person opts in
 * to remembering it, under a namespaced key, never sent anywhere but
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
  return readSecret(STORAGE_KEY, browserStores());
}

/** Saves for this tab only, or for this device when `remember` is true. See lib/secretStore.ts for why the default is the tab. */
export function setToken(token: string, remember = false): void {
  writeSecret(STORAGE_KEY, token, remember, browserStores());
}

export function tokenLocation(): Where {
  return whereStored(STORAGE_KEY, browserStores());
}

export function clearToken(): void {
  clearSecret(STORAGE_KEY, browserStores());
}

/** e.g. "github_pat_11AB••••••••••••3xZ9" — enough to recognize which token this is, never enough to reuse. */
export function maskToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 10)}${"•".repeat(10)}${token.slice(-4)}`;
}
