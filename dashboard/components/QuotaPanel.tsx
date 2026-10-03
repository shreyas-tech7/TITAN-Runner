"use client";

import { useEffect, useMemo, useState } from "react";
import type { PolledJsonResult } from "@/lib/usePolledJson";
import { quotaRows, type QuotaState } from "@/lib/quota";
import { relative } from "@/lib/time";
import { Badge, Meter, Panel } from "@/components/kit";

const nf = new Intl.NumberFormat("en-US");

/**
 * What each free provider has used today, from `state/quota.json`. The ceilings are the Runner's own
 * conservative defaults, so the bar says how close the Runner is to the point where it stops spending a
 * provider's calls. It is not a read of the provider's own meter.
 */
export default function QuotaPanel({ quota }: { quota: PolledJsonResult<QuotaState> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const rows = useMemo(() => quotaRows(quota.data, now), [quota.data, now]);
  const reservePct = Math.round(((quota.data?.reserveFraction ?? 0.15) as number) * 100);
  const updated = quota.data?.updatedAt ?? null;

  return (
    <Panel
      title="Free quota today"
      eyebrow="Providers"
      tone="plasma"
      actions={updated ? <Badge tone="neutral" title={updated}>updated {relative(updated)}</Badge> : null}
    >
      {quota.loading && !quota.data ? (
        <p className="e-dim">Loading the quota ledger…</p>
      ) : !quota.data && quota.error ? (
        <p className="e-dim" role="alert">
          Could not load the quota ledger ({quota.error}).
        </p>
      ) : !quota.data ? (
        <p className="e-dim">No quota ledger yet. The first pulse that calls a provider writes one.</p>
      ) : (
        <ul className="e-rows" aria-label="Calls used today per provider">
          {rows.map((r) => {
            const tone = r.dayPct >= 85 ? "danger" : r.dayPct >= 60 ? "warn" : "ok";
            return (
              <li key={r.id} className="e-row">
                <div className="e-row-head">
                  <span className="e-row-name">{r.id}</span>
                  <span className="e-row-figure e-num">
                    {nf.format(r.dayUsed)} of {nf.format(r.dayLimit)} calls ({r.dayPct}%)
                  </span>
                </div>
                <Meter value={r.dayUsed} max={r.dayLimit} marker={r.dayLimit - r.reserve} tone={tone} label={`${r.id} calls used today`} text={`${r.dayUsed} of ${r.dayLimit} calls, ${r.dayPct} percent`} />
                <div className="e-row-sub">
                  <span>{nf.format(r.reserve)} held in reserve</span>
                  {r.tokens > 0 ? <span>{nf.format(r.tokens)} tokens</span> : null}
                  {r.last429At ? <span>last 429 {relative(r.last429At)}</span> : null}
                  {r.noRecord ? <span>no calls counted yet</span> : null}
                  {r.staleDay ? <span>none today (last counted {r.countedDay})</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="e-note">
        Ceilings are the Runner&apos;s conservative defaults, not a guarantee from the provider. The tick on each bar marks where the {reservePct}% reserve starts. Days follow UTC.
      </p>
    </Panel>
  );
}
