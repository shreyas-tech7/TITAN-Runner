"use client";

/**
 * /ops/geospatial — the full God's Eye View investigation log. The globe
 * itself is now also embedded directly on the main dashboard
 * (GodsEyeSection) as the redesign brief asks; this page remains as the
 * deep-dive view for the full event list and per-event detail, reusing the
 * same `useGeospatialEvents` polling hook and the same globe component so
 * the two views never drift apart.
 */
import { useMemo } from "react";
import Link from "next/link";
import AdminGate from "@/components/AdminGate";
import GeospatialGlobe from "@/components/GeospatialGlobe";
import { useGeospatialEvents } from "@/lib/useGeospatialEvents";
import { buildProviderNetwork } from "@/lib/geoNetwork";
import { usePolledJson } from "@/lib/usePolledJson";
import type { ProvidersState, AgentsState } from "@/lib/types";
import { relative } from "@/lib/time";

function GeospatialContent({ token }: { token: string }) {
  const { events, error, configured } = useGeospatialEvents(token);
  const providers = usePolledJson<ProvidersState>("state/providers.json", 60_000);
  const agents = usePolledJson<AgentsState>("state/agents.json", 60_000);
  const networkNodes = useMemo(
    () => buildProviderNetwork(providers.data?.providers, agents.data ?? undefined),
    [providers.data, agents.data],
  );

  const list = events ?? [];
  const located = list.filter((e) => typeof e.lat === "number" && typeof e.lon === "number");
  const unlocated = list.filter((e) => !(typeof e.lat === "number" && typeof e.lon === "number"));

  return (
    <>
      <section className="section">
        <div className="section-head">
          <span className="label">Live tracking {configured ? `(${located.length} located)` : ""}</span>
        </div>
        <div className="panel globe-panel" style={{ marginBottom: 0 }}>
          <div className="globe-stage">
            <GeospatialGlobe events={list} networkNodes={networkNodes} />
          </div>
        </div>
        {!configured && (
          <div className="field-hint" style={{ marginTop: 8 }}>
            The provider mesh above is always live. OSINT investigation pins need the titan-runner-brain Worker
            deployed (<span className="mono">NEXT_PUBLIC_TITAN_WORKER_URL</span>) — see docs/RUNTIME.md.
          </div>
        )}
        {configured && located.length === 0 && (
          <div className="field-hint" style={{ marginTop: 8 }}>
            No located OSINT events yet — the provider mesh above is still live. Run an investigation from the
            dashboard&apos;s OSINT panel that resolves a coordinate to see it pinned here.
          </div>
        )}
        {configured && error && located.length === 0 && (
          <div className="field-hint text-failure" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}
      </section>

      {configured && (
      <section className="section">
        <div className="section-head">
          <span className="label">Events ({list.length})</span>
        </div>
        {events === null ? (
          <div className="empty">Loading…</div>
        ) : list.length === 0 ? (
          <div className="empty">Nothing recorded yet.</div>
        ) : (
          <div>
            {list.map((e) => (
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
      )}
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
