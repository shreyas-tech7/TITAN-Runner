"use client";

/**
 * The command center's own clock, not the visitor's local one — TITAN's
 * pulse, tasks, and pilot all run on Central time, so that's what's
 * authoritative here regardless of where the dashboard is viewed from.
 * `timeZoneName: "short"` yields CST or CDT correctly across the DST
 * boundary rather than hardcoding one label year-round.
 */
import useClock from "@/lib/useClock";

const TIME_ZONE = "America/Chicago";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

const zoneFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  timeZoneName: "short",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function zoneAbbreviation(d: Date): string {
  const part = zoneFormatter.formatToParts(d).find((p) => p.type === "timeZoneName");
  return part?.value ?? "CT";
}

export default function CommandClock() {
  const now = useClock();

  const parts = now ? timeFormatter.formatToParts(now) : null;
  const hh = parts?.find((p) => p.type === "hour")?.value ?? "--";
  const mm = parts?.find((p) => p.type === "minute")?.value ?? "--";
  const ss = parts?.find((p) => p.type === "second")?.value ?? "--";
  const meridiem = parts?.find((p) => p.type === "dayPeriod")?.value ?? "";

  return (
    <div className="panel panel-enter clock-panel" aria-live="off">
      <div>
        <div className="panel-title">
          <span className="dot dot-accent" aria-hidden />
          Local time — Command Center
        </div>
        <div className="clock-face mono">
          {hh}:{mm}
          <span className="text-muted" style={{ fontSize: 22, fontWeight: 500 }}>
            :{ss}
          </span>
          <span className="clock-meridiem">{meridiem}</span>
        </div>
        <div className="clock-date">{now ? dateFormatter.format(now) : "Loading…"}</div>
        <div className="clock-tz mono">{now ? zoneAbbreviation(now) : ""} · America/Chicago</div>
      </div>
    </div>
  );
}
