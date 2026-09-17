"use client";

/**
 * God's Eye View, embedded directly on the main dashboard rather than
 * living only behind a separate `/ops/geospatial` route — the redesign
 * brief's "should integrate naturally rather than feeling like a separate
 * page." The admin token is already unlocked at this point (AdminGate
 * wraps the whole dashboard), so this reuses it rather than asking again.
 *
 * The globe itself never depends on OSINT data existing: `networkNodes`
 * (TITAN's provider mesh) is derived from `state/providers.json`, which is
 * always present, so there is always something live and interactive to
 * look at. OSINT investigation pins layer on top of that when the Worker
 * is configured and has resolved coordinates. See GeospatialGlobe.tsx's
 * doc comment for the actual bug this rewrite fixes.
 */
import { useMemo } from "react";
import Link from "next/link";
import GeospatialGlobe from "@/components/GeospatialGlobe";
import { useGeospatialEvents } from "@/lib/useGeospatialEvents";
import { buildProviderNetwork } from "@/lib/geoNetwork";
import { relative } from "@/lib/time";
import type { AgentsState, ProviderHealthRecord } from "@/lib/types";

export default function GodsEyeSection({
  token,
  providers,
  agents,
}: {
  token: string;
  providers: Record<string, ProviderHealthRecord> | undefined;
  agents: AgentsState | undefined;
}) {
  const { events, error, configured } = useGeospatialEvents(token);
  const networkNodes = useMemo(() => buildProviderNetwork(providers, agents), [providers, agents]);

  const onlineNodes = networkNodes.filter((n) => n.status === "online").length;
  const located = (events ?? []).filter((e) => typeof e.lat === "number" && typeof e.lon === "number");
  const recentEvents = (events ?? []).slice(0, 6);

  return (
    <div className="panel panel-accent panel-enter globe-panel" style={{ marginBottom: "var(--space-5)" }}>
      <div className="panel-head">
        <div className="panel-title">
          <span className="dot dot-accent dot-pulsing" aria-hidden />
          God&apos;s Eye View
        </div>
        <Link className="btn btn-quiet" href="/ops/geospatial" style={{ fontSize: 11 }}>
          Full investigation log →
        </Link>
      </div>

      <div className="hero-grid">
        <div className="globe-stage">
          <GeospatialGlobe events={events ?? []} networkNodes={networkNodes} />
        </div>

        <div className="globe-legend">
          <div>
            <div className="globe-stat-row">
              <span className="label">Provider mesh online</span>
              <span className="value mono text-signal">
                {onlineNodes}/{networkNodes.length}
              </span>
            </div>
            <div className="globe-stat-row">
              <span className="label">OSINT pins located</span>
              <span className="value mono">{configured ? located.length : "—"}</span>
            </div>
            <div className="globe-stat-row">
              <span className="label">Total events logged</span>
              <span className="value mono">{configured ? (events?.length ?? "—") : "—"}</span>
            </div>
          </div>

          <div>
            <div className="globe-legend-item">
              <span className="dot dot-accent" aria-hidden /> Command Center (Dallas, TX)
            </div>
            <div className="globe-legend-item">
              <span className="dot dot-live" aria-hidden /> Provider online — active arc
            </div>
            <div className="globe-legend-item">
              <span className="dot dot-idle" aria-hidden /> Provider idle / not configured
            </div>
            <div className="globe-legend-item">
              <span className="dot dot-warn" aria-hidden /> Investigation pin (confidence)
            </div>
          </div>

          {configured && recentEvents.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Recent activity
              </div>
              <div className="globe-event-list">
                {recentEvents.map((e) => (
                  <div key={e.id} className="row" style={{ padding: "6px 0", fontSize: 12 }}>
                    <span
                      className={`dot ${e.confidence === "high" ? "dot-live" : e.confidence === "low" ? "dot-fail" : "dot-warn"}`}
                      aria-hidden
                    />
                    <span className="row-title">{e.label}</span>
                    <span className="row-quiet mono" style={{ fontSize: 10 }}>
                      {relative(e.recorded_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!configured && (
            <div className="field-hint">
              Provider mesh is always live. OSINT investigation pins need the titan-runner-brain Worker deployed
              (<span className="mono">NEXT_PUBLIC_TITAN_WORKER_URL</span>) — see docs/RUNTIME.md.
            </div>
          )}
          {configured && error && <div className="field-hint text-failure">{error}</div>}
        </div>
      </div>

      <div className="globe-hint">
        Drag to rotate, scroll to zoom. Nodes are TITAN&apos;s provider mesh (schematic positions, real live status) —
        hover any node or pin for detail.
      </div>
    </div>
  );
}
