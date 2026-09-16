"use client";

/**
 * /ops/geospatial — the God's Eye View-style page (task brief, phase 3).
 * Reuses AdminGate exactly as the main dashboard does: this data is exactly
 * as sensitive as everything else behind the admin token, and every event
 * it can ever show was already gated at the point it was written (see
 * worker/src/index.js's POST /internal/geospatial-event and OsintPanel's
 * doc comment) — this page adds no additional trust boundary, it just
 * visualizes what already passed through the real one.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AdminGate from "@/components/AdminGate";
import GeospatialGlobe from "@/components/GeospatialGlobe";
import { fetchGeospatialEvents, WorkerApiError, isWorkerConfigured, type GeospatialEventRow } from "@/lib/workerApi";
import { relative } from "@/lib/time";

function GeospatialContent({ token }: { token: string }) {
  const [events, setEvents] = useState<GeospatialEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchGeospatialEvents(token);
      setEvents(result.events);
      setError(null);
    } catch (err) {
      setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    }
  }, [token]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (!isWorkerConfigured()) {
    return <div className="empty">The titan-runner-brain Worker isn&apos;t configured yet — see docs/RUNTIME.md.</div>;
  }
  if (error) return <div className="empty">{error}</div>;
  if (events === null) return <div className="empty">Loading…</div>;

  const located = events.filter((e) => typeof e.lat === "number" && typeof e.lon === "number");
  const unlocated = events.filter((e) => !(typeof e.lat === "number" && typeof e.lon === "number"));

  return (
    <>
      <section className="section">
        <div className="section-head">
          <span className="label">Live tracking ({located.length} located)</span>
        </div>
        {located.length === 0 ? (
          <div className="empty">
            No located events yet — run an investigation from the dashboard&apos;s OSINT panel that resolves a
            coordinate.
          </div>
        ) : (
          <GeospatialGlobe events={events} />
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">Events ({events.length})</span>
        </div>
        {events.length === 0 ? (
          <div className="empty">Nothing recorded yet.</div>
        ) : (
          <div>
            {events.map((e) => (
              <div className="row" key={e.id} style={{ flexWrap: "wrap" }}>
                <span className={`dot ${e.confidence === "high" ? "dot-live" : e.confidence === "low" ? "dot-fail" : "dot-warn"}`} aria-hidden />
                <span className="row-title" style={{ flex: 1 }}>
                  {e.label}
                </span>
                {e.lat != null && e.lon != null && (
                  <span className="row-quiet mono">
                    {e.lat.toFixed(3)}, {e.lon.toFixed(3)}
                  </span>
                )}
                {e.ip && <span className="chip mono">{e.ip}</span>}
                {e.confidence && <span className="badge text-quiet">{e.confidence}</span>}
                <span className="row-quiet mono">{relative(e.recorded_at)}</span>
              </div>
            ))}
          </div>
        )}
        {unlocated.length > 0 && (
          <p className="field-hint" style={{ marginTop: 8 }}>
            {unlocated.length} event(s) have no resolved coordinates and are not shown on the globe above.
          </p>
        )}
      </section>
    </>
  );
}

export default function GeospatialPage() {
  return (
    <AdminGate>
      {(token) => (
        <div className="shell">
          <div className="topbar">
            <div>
              <h1 className="brand">God&apos;s Eye View</h1>
              <div className="brand-sub">Owner-gated OSINT geospatial tracking — see the OSINT panel on the main dashboard</div>
            </div>
            <div className="topbar-actions">
              <Link className="btn btn-quiet" href="./">
                ← Dashboard
              </Link>
            </div>
          </div>
          <GeospatialContent token={token} />
        </div>
      )}
    </AdminGate>
  );
}
