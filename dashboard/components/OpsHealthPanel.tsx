"use client";

import { Badge, Panel } from "@/components/kit";
import { Freshness, MirrorBody, type MirrorInput } from "@/components/OpsShared";
import { STALE_AFTER_MS, errorWords, healthRows, healthSummary, type HealthMirror } from "@/lib/opsView";
import { relative } from "@/lib/time";

/**
 * What the nightly canary found, from `state/ops/health.json`. One fixed question goes to every provider, so a
 * provider that is down shows here before a real task meets it. A provider with no key is listed in one line.
 */
export default function OpsHealthPanel({ health, now }: { health: MirrorInput<HealthMirror>; now?: number }) {
  return (
    <Panel
      title="Provider health"
      eyebrow="Nightly canary"
      tone="ion"
      actions={<Freshness at={health.data?.generated_at} maxAgeMs={STALE_AFTER_MS.health} now={now} />}
    >
      <MirrorBody input={health} what="the canary results" emptyText="No canary has run yet. The first nightly run, around 03:00 in Chicago, fills this panel." isEmpty={(d) => healthRows(d).length === 0}>
        {(data) => {
          const rows = healthRows(data);
          const counts = healthSummary(rows);
          const active = rows.filter((r) => r.status !== "not_configured");
          const unset = rows.filter((r) => r.status === "not_configured");
          return (
            <>
              <p className="e-dim" data-testid="health-summary">
                {counts.healthy} healthy, {counts.degraded} degraded, {counts.down} down, {counts.not_configured} not set up.
              </p>
              <ul className="e-rows" aria-label="Health of each provider">
                {active.map((r) => (
                  <li key={`${r.provider}/${r.model}`} className="e-row" data-health={r.status}>
                    <div className="e-row-head">
                      <span className="e-row-name">
                        {r.provider.replace(/_/g, " ")} <span className="e-dim">{r.model}</span>
                      </span>
                      <Badge tone={r.tone}>{r.label}</Badge>
                    </div>
                    <div className="e-row-sub">
                      {r.latencyMs !== null ? <span className="e-num">{r.latencyMs} ms</span> : null}
                      <span>checked {relative(r.checkedAt, now)}</span>
                      {errorWords(r.errorClass) ? <span>{errorWords(r.errorClass)}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
              {unset.length > 0 ? (
                <p className="e-note" data-testid="health-unset">
                  No key set for {unset.map((r) => r.provider.replace(/_/g, " ")).join(", ")}. The canary skips them, and so does the router.
                </p>
              ) : null}
            </>
          );
        }}
      </MirrorBody>
    </Panel>
  );
}
