"use client";

/**
 * OmniRoute Status panel (task brief, phase 1). There is no live telemetry
 * endpoint to poll — the gateway only runs inside an ephemeral
 * spawn-subagent.yml job (see that workflow's pinned, opt-in step), never
 * as a long-lived process this static dashboard could reach directly.
 * Everything shown here is instead derived from the same `subagents` rows
 * ClusterPanels already fetches: `provider` already reads 'omniroute'
 * whenever registry.js actually routed a call through it (see
 * src/providers/registry.js), and the new `tokens_used` column is real,
 * reported data — never a fabricated "% savings" figure.
 */
import type { SubagentRow } from "@/lib/workerApi";

export default function OmniRouteStatusPanel({ subagents }: { subagents: SubagentRow[] }) {
  const completed = subagents.filter((r) => r.status === "done" || r.status === "failed");
  const viaOmniRoute = completed.filter((r) => r.provider === "omniroute");
  const viaDirect = completed.filter((r) => r.provider && r.provider !== "omniroute");

  const tiers = new Map<string, number>();
  for (const r of completed) {
    if (!r.provider) continue;
    tiers.set(r.provider, (tiers.get(r.provider) ?? 0) + 1);
  }
  const tierRows = [...tiers.entries()].sort((a, b) => b[1] - a[1]);

  const tokensViaOmniRoute = viaOmniRoute.reduce((sum, r) => sum + (r.tokens_used ?? 0), 0);
  const tokensViaDirect = viaDirect.reduce((sum, r) => sum + (r.tokens_used ?? 0), 0);

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">OmniRoute gateway</span>
        <span className="text-quiet" style={{ fontSize: 11 }}>
          optional — off unless OMNIROUTE_BASE_URL is set, see .env.example
        </span>
      </div>

      {completed.length === 0 ? (
        <div className="empty">No completed sub-agent runs yet — nothing to report.</div>
      ) : (
        <>
          <div className="row">
            <span className={`dot ${viaOmniRoute.length > 0 ? "dot-live" : "dot-idle"}`} aria-hidden />
            <span className="row-title" style={{ flex: "0 0 220px" }}>
              Requests routed via OmniRoute
            </span>
            <span className="row-quiet mono">
              {viaOmniRoute.length} / {completed.length}
            </span>
          </div>
          <div className="row">
            <span className="dot dot-idle" aria-hidden />
            <span className="row-title" style={{ flex: "0 0 220px" }}>
              Requests via direct fallback
            </span>
            <span className="row-quiet mono">{viaDirect.length}</span>
          </div>
          <div className="row">
            <span className="dot dot-idle" aria-hidden />
            <span className="row-title" style={{ flex: "0 0 220px" }}>
              Tokens used — OmniRoute / direct
            </span>
            <span className="row-quiet mono">
              {tokensViaOmniRoute.toLocaleString()} / {tokensViaDirect.toLocaleString()}
            </span>
          </div>
          {tierRows.length > 0 && (
            <div className="field-hint" style={{ marginTop: 8 }}>
              Active fallback tiers (most-used first):{" "}
              {tierRows.map(([provider, count], i) => (
                <span key={provider}>
                  {i > 0 && ", "}
                  <span className="mono">{provider}</span> ({count})
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
