"use client";

import { useEffect, useState } from "react";

export default function LastFetchedIndicator({ lastFetchedAt, onRefresh }: { lastFetchedAt: number | null; onRefresh: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  const label = lastFetchedAt === null ? "not yet fetched" : `fetched ${Math.max(0, Math.round((Date.now() - lastFetchedAt) / 1000))}s ago`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="text-quiet mono" style={{ fontSize: 11 }}>
        {label}
      </span>
      <button className="btn btn-quiet" onClick={onRefresh} aria-label="Refresh now" title="Refresh now">
        ↻
      </button>
    </div>
  );
}
