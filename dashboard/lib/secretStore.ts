/**
 * Where a pasted credential lives in the browser (Wave 11).
 *
 * A static site on GitHub Pages shares one origin, `<owner>.github.io`, with every other project page
 * that owner publishes, and `localStorage` is shared across a whole origin. A token kept there is readable
 * by any script on any of those pages and survives forever. So the default is `sessionStorage`: this tab
 * only, gone when it closes. Choosing "Remember on this device" opts into `localStorage`, and the screen
 * says what that means. A credential is only ever in one of the two places at a time.
 *
 * The functions take the two stores as arguments so they can be tested without a browser.
 */

export interface Stores {
  session: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  local: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export type Where = "session" | "local" | null;

/** The real browser stores, or null on the server and when storage is blocked. */
export function browserStores(): Stores | null {
  if (typeof window === "undefined") return null;
  try {
    return { session: window.sessionStorage, local: window.localStorage };
  } catch {
    return null;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The stored value, from this tab first and then from the device. */
export function readSecret(key: string, stores: Stores | null): string | null {
  if (!stores) return null;
  return safe(() => stores.session.getItem(key), null) ?? safe(() => stores.local.getItem(key), null);
}

export function whereStored(key: string, stores: Stores | null): Where {
  if (!stores) return null;
  if (safe(() => stores.session.getItem(key), null) !== null) return "session";
  if (safe(() => stores.local.getItem(key), null) !== null) return "local";
  return null;
}

/** Saves to the tab, or to the device when `remember` is true, and removes it from the other place. */
export function writeSecret(key: string, value: string, remember: boolean, stores: Stores | null): void {
  if (!stores) return;
  const clean = value.trim();
  const [keep, drop] = remember ? [stores.local, stores.session] : [stores.session, stores.local];
  safe(() => keep.setItem(key, clean), undefined);
  safe(() => drop.removeItem(key), undefined);
}

export function clearSecret(key: string, stores: Stores | null): void {
  if (!stores) return;
  safe(() => stores.session.removeItem(key), undefined);
  safe(() => stores.local.removeItem(key), undefined);
}
