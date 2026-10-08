/**
 * What the pulse banner says (Wave 12, R1). The old banner warned whenever the last pulse was older than 45 minutes. GitHub
 * runs the cron late, so that banner was on most of the time. Now the Worker keeps the pulse alive, and the banner warns only
 * when the keeper fails too.
 */
import type { PulseKeeperState } from "./keysApi";

export const STALE_AFTER_MINUTES = 45;
const KEEPER_QUIET_MINUTES = 30;

export type BannerKind = "none" | "info" | "alert";

export interface BannerState {
  kind: BannerKind;
  text: string;
}

/**
 * @param ageMinutes Minutes since the last pulse.
 * @param keeper The keeper state from the Worker, or null when the Worker is not set or did not answer.
 * @param nowMs The current time.
 */
export function bannerState(ageMinutes: number | null, keeper: PulseKeeperState | null, nowMs: number): BannerState {
  if (ageMinutes === null || ageMinutes < STALE_AFTER_MINUTES) return { kind: "none", text: "" };
  const base = `No pulse in ${ageMinutes} minutes.`;
  if (!keeper) return { kind: "alert", text: `${base} Expected every 15. This could be a stuck run, an exhausted provider, or GitHub running the cron late. The Worker did not answer, so the pulse keeper state is unknown.` };
  if (!keeper.keeperHealthy) return { kind: "alert", text: `${base} The pulse keeper also failed: ${keeper.keeperError ?? "unknown error"}. Open Actions to start a pulse by hand.` };
  const dispatchAge = keeper.lastDispatchAt ? Math.round((nowMs - Date.parse(keeper.lastDispatchAt)) / 60_000) : null;
  if (dispatchAge === null || dispatchAge > KEEPER_QUIET_MINUTES) {
    return { kind: "alert", text: `${base} The pulse keeper has not started a pulse ${dispatchAge === null ? "yet" : `in ${dispatchAge} minutes`}. Check that the Worker cron runs.` };
  }
  return { kind: "info", text: `${base} The pulse keeper started a pulse ${dispatchAge} minutes ago. GitHub is slow to start it.` };
}
