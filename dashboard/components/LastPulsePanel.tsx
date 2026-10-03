"use client";

import { useEffect, useMemo, useState } from "react";
import type { PolledJsonResult } from "@/lib/usePolledJson";
import { pulseView } from "@/lib/pulseView";
import type { HeartbeatState, PulseHistoryState } from "@/lib/types";
import { formatCountdown, formatDuration, relative } from "@/lib/time";
import { Badge, Meter, Panel, Sparkline, StatusDot } from "@/components/kit";

const STATE_BADGE = {
  ok: { tone: "ok", word: "On time" },
  late: { tone: "warn", word: "Late" },
  error: { tone: "danger", word: "Last pulse failed" },
  never: { tone: "neutral", word: "No pulse yet" },
} as const;

/** The last pulse in full: when, how long, what it did, and what it spent of its time budget. */
export default function LastPulsePanel({ heartbeat, history }: { heartbeat: PolledJsonResult<HeartbeatState>; history: PolledJsonResult<PulseHistoryState> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const v = useMemo(() => pulseView(heartbeat.data, history.data?.pulses, now), [heartbeat.data, history.data, now]);
  // Until a heartbeat arrives, the badge says what is true: still loading, or could not load. It never says "no pulse yet" for a failed read.
  const badge = heartbeat.data ? STATE_BADGE[v.state] : heartbeat.loading ? ({ tone: "neutral", word: "Loading" } as const) : heartbeat.error ? ({ tone: "neutral", word: "Unknown" } as const) : STATE_BADGE.never;
  const untilNext = v.nextDueAt ? Date.parse(v.nextDueAt) - now : null;

  return (
    <Panel
      title="Last pulse"
      eyebrow="Heartbeat"
      tone="ion"
      actions={
        <Badge tone={badge.tone}>
          <StatusDot tone={badge.tone} label={badge.word} pulse={v.state === "ok"} /> {badge.word}
        </Badge>
      }
    >
      {heartbeat.loading && !heartbeat.data ? (
        <p className="e-dim">Loading the heartbeat…</p>
      ) : !heartbeat.data && heartbeat.error ? (
        <p className="e-dim" role="alert">
          Could not load the heartbeat ({heartbeat.error}). This says nothing about whether pulses are running.
        </p>
      ) : !heartbeat.data ? (
        <p className="e-dim">No heartbeat yet. The first pulse has not run.</p>
      ) : (
        <>
          <dl className="e-facts">
            <div className="e-fact">
              <dt>When</dt>
              <dd title={v.lastAt ?? undefined}>{v.lastAt ? relative(v.lastAt) : "never"}</dd>
            </div>
            <div className="e-fact">
              <dt>Took</dt>
              <dd className="e-num">{formatDuration(v.durationMs)}</dd>
            </div>
            <div className="e-fact">
              <dt>Tasks</dt>
              <dd className="e-num">
                {v.claimed} claimed, {v.completed} done, {v.failed} failed
              </dd>
            </div>
            <div className="e-fact">
              <dt>Model calls</dt>
              <dd className="e-num">{v.modelCalls ?? "not recorded"}</dd>
            </div>
            <div className="e-fact">
              <dt>Next due</dt>
              <dd className="e-num">
                {untilNext === null ? "unknown" : untilNext > 0 ? `in ${formatCountdown(untilNext)}` : v.minutesLate > 0 ? `${v.minutesLate} min late` : "now"}
              </dd>
            </div>
            <div className="e-fact">
              <dt>Pulses so far</dt>
              <dd className="e-num">{v.totalPulses}</dd>
            </div>
          </dl>
          {v.budgetUsedPct !== null ? (
            <div className="e-row-block">
              <div className="e-row-head">
                <span className="e-row-figure">Time budget used</span>
                <span className="e-row-figure e-num">{v.budgetUsedPct}%</span>
              </div>
              <Meter value={v.budgetUsedPct} max={100} tone="ion" label="Share of the pulse time budget used" text={`${v.budgetUsedPct} percent`} />
            </div>
          ) : null}
          <div className="e-row-block">
            <div className="e-row-figure">Duration of the last {v.window} pulses</div>
            <Sparkline values={v.recentDurations} label="Pulse duration in milliseconds" tone="ion" width={260} />
            <div className="e-row-sub">
              <span>{v.recentErrors} failed of the last {v.window}</span>
              {v.consecutiveFailures > 0 ? <span>{v.consecutiveFailures} in a row</span> : null}
              {v.pulseId ? <span className="e-num">id {v.pulseId.slice(0, 12)}</span> : null}
            </div>
          </div>
          {v.lastError ? <p className="e-note">Last error: {v.lastError}</p> : null}
          <p className="e-note">GitHub starts a scheduled run when it can, so a pulse can arrive a few minutes after its time. Cadence is every {v.cadenceMinutes} minutes.</p>
        </>
      )}
    </Panel>
  );
}
