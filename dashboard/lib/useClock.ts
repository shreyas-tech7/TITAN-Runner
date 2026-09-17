"use client";

import { useEffect, useState } from "react";

/**
 * Ticks once a second. Starts `null` and fills in on mount rather than
 * `Date.now()` at module scope, so SSR/prerender output and the first
 * client render always agree — a static export's HTML has no "now" of its
 * own, and disagreeing would either hydration-mismatch or flash a wrong
 * value.
 */
export function useClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return now;
}

export default useClock;
