"use client";

import { browserStores, clearSecret, readSecret, whereStored, writeSecret } from "./secretStore";
import type { Where } from "./secretStore";

/**
 * The titan-runner-brain Worker's admin token (build brief, section 4/5) —
 * a separate credential from `lib/token.ts`'s GitHub PAT, with a different
 * purpose: this one gates the *entire* dashboard (build brief: "private by
 * default, not just protecting the write actions"), while the PAT only
 * lets the dashboard file/cancel/retry issues on the visitor's behalf.
 *
 * Same storage contract as `lib/token.ts`: this tab only unless the person chooses to remember it, namespaced
 * key, never logged, never committed, never sent anywhere but the Worker's
 * own origin as the `X-Titan-Auth` header.
 */

const STORAGE_KEY = "titan-runner:admin-token:v1";

export function getAdminToken(): string | null {
  return readSecret(STORAGE_KEY, browserStores());
}

/** Saves for this tab only, or for this device when `remember` is true. See lib/secretStore.ts for why the default is the tab. */
export function setAdminToken(token: string, remember = false): void {
  writeSecret(STORAGE_KEY, token, remember, browserStores());
}

export function adminTokenLocation(): Where {
  return whereStored(STORAGE_KEY, browserStores());
}

export function clearAdminToken(): void {
  clearSecret(STORAGE_KEY, browserStores());
}
