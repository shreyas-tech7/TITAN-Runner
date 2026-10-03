"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Says so when the browser has no network. The panels cannot load then, and an empty panel must not read as "nothing happened". */
export default function OfflineNotice() {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  if (online) return null;
  return (
    <div className="banner" role="status">
      <span>
        <strong className="text-warning">You are offline.</strong> <span className="text-muted">The panels below cannot load current state. Reconnect to see it.</span>
      </span>
    </div>
  );
}
