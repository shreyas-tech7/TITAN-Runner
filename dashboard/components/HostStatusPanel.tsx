"use client";

import { Badge, Meter, Panel } from "@/components/kit";
import { Freshness, MirrorBody, type MirrorInput } from "@/components/OpsShared";
import { STALE_AFTER_MS, hostRows, type HostsMirror } from "@/lib/opsView";
import { relative } from "@/lib/time";

/**
 * The hosts that TITAN depends on, from `state/ops/hosts.json`: the pulse workflow, the GitHub status, the Hugging Face
 * Space, the Render services, and the Hermes agents on Railway. Asleep is its own state, because a free host sleeps by
 * design. A bar shows the share of checks in a window when the host was not down.
 */
export default function HostStatusPanel({ hosts, now }: { hosts: MirrorInput<HostsMirror>; now?: number }) {
  return (
    <Panel
      title="Host status"
      eyebrow="Uptime"
      tone="ion"
      actions={<Freshness at={hosts.data?.generated_at} maxAgeMs={STALE_AFTER_MS.hosts} now={now} />}
    >
      <MirrorBody input={hosts} what="the host status" emptyText="No host check has run yet. The probe runs every 3 hours and skips a host with no URL set." isEmpty={(d) => hostRows(d).length === 0}>
        {(data) => (
          <ul className="e-rows" aria-label="Status of each host">
            {hostRows(data).map((h) => (
              <li key={h.name} className="e-row" data-host={h.name} data-status={h.status}>
                <div className="e-row-head">
                  <span className="e-row-name">{h.label}</span>
                  <Badge tone={h.tone} title={h.note}>{h.statusLabel}</Badge>
                </div>
                <div className="ops-uptime">
                  {h.bars.map((b) => (
                    <div key={b.window} className="ops-uptime-bar">
                      <span className="e-dim">{b.window}</span>
                      {b.pct === null ? (
                        <span className="e-dim ops-uptime-none">no checks yet</span>
                      ) : (
                        <>
                          <Meter value={b.pct} max={100} tone={b.tone} label={`${h.label} uptime over ${b.window}`} text={`${b.pct} percent`} />
                          <span className="e-num">{b.pct}%</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <div className="e-row-sub">
                  <span>checked {relative(h.lastCheck, now)}</span>
                  {h.lastPulseAt ? <span>last pulse {relative(h.lastPulseAt, now)}</span> : null}
                  {h.status === "asleep" ? <span>{h.note}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </MirrorBody>
      <p className="e-note">A Render service is checked at most every 5.5 hours, so the probe does not keep it awake. Only host names are stored, never addresses.</p>
    </Panel>
  );
}
