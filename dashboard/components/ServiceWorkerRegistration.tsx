"use client";

import { useEffect } from "react";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** Registers public/sw.js (see that file for what it does and — more
 * importantly — what it deliberately does not cache). Silently no-ops
 * where service workers aren't supported; this is a PWA-installability
 * nicety, never something the dashboard depends on to function. */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` }).catch(() => {
      // Best-effort only — an unregistered SW just means no installability,
      // not a broken dashboard.
    });
  }, []);
  return null;
}
