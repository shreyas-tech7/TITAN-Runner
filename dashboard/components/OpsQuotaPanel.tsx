"use client";

import { Badge, Meter, Panel } from "@/components/kit";
import { Freshness, MirrorBody, type MirrorInput } from "@/components/OpsShared";
import { CONFIDENCE_LABEL, STALE_AFTER_MS, opsQuotaRows, quotaTone, safeSource, utcStamp, type QuotaMirror } from "@/lib/opsView";

const nf = new Intl.NumberFormat("en-US");

/**
 * The free quota of each provider and model, from `state/ops/quota.json`. TITAN and the Runner report their calls to
 * the same ledger, so this is the use of both. A limit that no official page states is shown as unknown, with the
 * count of calls so far. It is never a guess.
 */
export default function OpsQuotaPanel({ quota, now }: { quota: MirrorInput<QuotaMirror>; now?: number }) {
  return (
    <Panel
      title="Quota meter"
      eyebrow="Free tiers"
      tone="plasma"
      actions={<Freshness at={quota.data?.generated_at} maxAgeMs={STALE_AFTER_MS.quota} now={now} />}
    >
      <MirrorBody input={quota} what="the quota meter" emptyText="No calls are counted yet. The first call that TITAN or the Runner reports starts the meter." isEmpty={(d) => opsQuotaRows(d).length === 0}>
        {(data) => (
          <ul className="e-rows" aria-label="Calls used today for each model">
            {opsQuotaRows(data).map((r) => {
              const source = safeSource(r.source);
              return (
                <li key={`${r.provider}/${r.model}`} className="e-row" data-exhausted={r.exhausted ? "true" : "false"} data-confidence={r.confidence}>
                  <div className="e-row-head">
                    <span className="e-row-name">
                      {r.provider.replace(/_/g, " ")} <span className="e-dim">{r.model}</span>
                    </span>
                    <span className="e-row-figure e-num">
                      {r.limitDay !== null ? `${nf.format(r.usedDay)} of ${nf.format(r.limitDay)} today` : `${nf.format(r.usedDay)} today, limit unknown`}
                      {r.exhausted ? (<> <Badge tone="danger">Exhausted</Badge></>) : null}
                    </span>
                  </div>
                  {r.dayPct !== null && r.limitDay !== null ? (
                    <Meter value={r.usedDay} max={r.limitDay} tone={quotaTone(r)} label={`${r.provider} ${r.model} calls used today`} text={`${r.usedDay} of ${r.limitDay} calls, ${r.dayPct} percent`} />
                  ) : null}
                  <div className="e-row-sub">
                    <span>{CONFIDENCE_LABEL[r.confidence]}</span>
                    {r.limitMonth !== null ? <span className="e-num">{nf.format(r.usedMonth)} of {nf.format(r.limitMonth)} this month</span> : null}
                    {r.resetsAt ? <span title={r.resetsAt}>resets {utcStamp(r.resetsAt)}</span> : null}
                    {source ? (
                      <a href={source} target="_blank" rel="noopener noreferrer">
                        limit source
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </MirrorBody>
      <p className="e-note">The router skips a model at 95% of a known limit, and after a 429 until the reset. Unknown means that the provider does not state a free limit.</p>
    </Panel>
  );
}
