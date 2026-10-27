"use client";

import { CORE_TIME_ZONE } from "@/lib/core";
import useClock from "@/lib/useClock";

const timeFormatter = new Intl.DateTimeFormat("en-US", { timeZone: CORE_TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });

/** A short clock for the HUD bar, in the command center's time zone. It is blank until it mounts. */
export default function HudClock() {
  const now = useClock();
  return (
    <span className="hud-clock mono" aria-label="Command center time">
      {now ? timeFormatter.format(now) : "--:--"} · DALLAS, TX
    </span>
  );
}
