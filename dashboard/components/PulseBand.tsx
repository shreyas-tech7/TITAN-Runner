"use client";

import { useEffect, useState } from "react";
import type { HeartbeatState, PulseHistoryEntry } from "@/lib/types";
import { relative, formatDuration, formatCountdown, msUntilNextPulse } from "@/lib/time";

const MAX_TIMELINE_BARS = 40;

function Timeline({ pulses }: { pulses: PulseHistoryEntry[] }) {
  if (pulses.length === 0) {
    return <div className="empty">No pulse history yet.</div>;
  }
  const shown = pulses.slice(-MAX_TIMELINE_BARS);
  const maxDuration = Math.max(...shown.map((p) => p.durationMs), 1);
  return (
    <div className="timeline" role="img" aria-label={`Duration and outcome of the last ${shown.length} pulses`}>
      {shown.map((p, i) => {
        const heightPct = Math.max(12, (p.durationMs / maxDuration) * 100);
        const cls = p.status === "error" ? "timeline-bar timeline-bar-fail" : p.tasksClaimed > 0 ? "timeline-bar timeline-bar-live" : "timeline-bar";
        return (
          <div
            key={`${p.at}-${i}`}
            className={cls}
            style={{ height: `${heightPct}%` }}
            title={`${relative(p.at)} — ${formatDuration(p.durationMs)} — ${p.status}${p.tasksClaimed ? `, ${p.tasksClaimed} task(s) claimed` : ""}`}
          />
        );
      })}
    </div>
  );
}

export default function PulseBand({
  heartbeat,
  pulses,
  loading,
}: {
  heartbeat: HeartbeatState | null;
  pulses: PulseHistoryEntry[];
  loading: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (loading && !heartbeat) {
    return (
      <div className="pulse-band">
        <div className="empty">Loading pulse status…</div>
      </div>
    );
  }
  if (!heartbeat) {
    return (
      <div className="pulse-band">
        <div className="empty">No heartbeat yet — the first pulse hasn&apos;t run. Nothing is fabricated here: this is genuinely empty.</div>
      </div>
    );
  }

  const isOk = heartbeat.lastPulseStatus === "ok";
  const nextMs = msUntilNextPulse(heartbeat.lastPulseAt, heartbeat.cadenceMinutes);
  void now; // re-render trigger for the ticking countdown below

  return (
    <div className="pulse-band">
      <div className="pulse-band-top">
        <div className="pulse-state">
          <span className={`dot ${isOk ? "dot-live dot-pulsing" : "dot-fail"}`} aria-hidden />
          <span className={isOk ? "text-signal" : "text-failure"}>{isOk ? "Pulse healthy" : "Last pulse failed"}</span>
          <span className="text-quiet mono" style={{ fontSize: 12, fontWeight: 400 }}>
            · {relative(heartbeat.lastPulseAt)}
          </span>
        </div>
        {nextMs !== null && (
          <div style={{ textAlign: "right" }}>
            <div className="countdown-value mono">{formatCountdown(nextMs)}</div>
            <div className="countdown-caption">
              {nextMs <= 0 ? "next pulse is due — " : "until next pulse — "}
              GitHub cron is best-effort and can run late
            </div>
          </div>
        )}
      </div>

      <div className="pulse-grid">
        <div className="metric">
          <div className="label">Last duration</div>
          <div className="value mono">{formatDuration(heartbeat.lastPulseDurationMs)}</div>
        </div>
        <div className="metric">
          <div className="label">Cadence</div>
          <div className="value mono">{heartbeat.cadenceMinutes}m</div>
        </div>
        <div className="metric">
          <div className="label">Total pulses</div>
          <div className="value mono">{heartbeat.totalPulses}</div>
        </div>
        <div className="metric">
          <div className="label">Consecutive failures</div>
          <div className={`value mono ${heartbeat.consecutivePulseFailures > 0 ? "text-failure" : ""}`}>
            {heartbeat.consecutivePulseFailures}
          </div>
        </div>
        <div className="metric">
          <div className="label">This pulse</div>
          <div className="value mono">
            {heartbeat.lastPulseTasksCompleted}/{heartbeat.lastPulseTasksClaimed} done
          </div>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <div className="label" style={{ marginBottom: 8 }}>
          Last {Math.min(pulses.length, MAX_TIMELINE_BARS)} pulses
        </div>
        <Timeline pulses={pulses} />
      </div>

      {heartbeat.lastPulseError && (
        <div className="text-failure mono" style={{ fontSize: 12, marginTop: 12 }}>
          {heartbeat.lastPulseError}
        </div>
      )}
    </div>
  );
}
