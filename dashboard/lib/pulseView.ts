/** What the "last pulse" panel shows, worked out from `state/heartbeat.json` and `state/pulse-history.json`. */

import type { HeartbeatState, PulseHistoryEntry } from "./types";

export interface PulseView {
  /** `ok`, `late` (past due by more than a cadence), `error`, or `never`. */
  state: "ok" | "late" | "error" | "never";
  lastAt: string | null;
  /** Minutes since the last pulse, or null. */
  ageMinutes: number | null;
  /** When the next pulse is due: the last pulse plus the cadence. GitHub's cron is best-effort, so it can be late. */
  nextDueAt: string | null;
  minutesLate: number;
  durationMs: number | null;
  claimed: number;
  completed: number;
  failed: number;
  modelCalls: number | null;
  /** Share of the pulse's time budget it used, 0 to 100, or null when no budget is recorded. */
  budgetUsedPct: number | null;
  budgetMs: number | null;
  consecutiveFailures: number;
  totalPulses: number;
  cadenceMinutes: number;
  lastError: string | null;
  pulseId: string | null;
  /** Durations of the most recent pulses, oldest first, for a sparkline. */
  recentDurations: number[];
  /** How many of the last `window` pulses ended in error. */
  recentErrors: number;
  window: number;
}

export function pulseView(hb: HeartbeatState | null | undefined, history: PulseHistoryEntry[] | undefined, nowMs: number, window = 40): PulseView {
  const recent = (history ?? []).slice(-window);
  const cadence = hb?.cadenceMinutes && hb.cadenceMinutes > 0 ? hb.cadenceMinutes : 15;
  const last = hb?.lastPulseAt ? Date.parse(hb.lastPulseAt) : NaN;
  const hasLast = Number.isFinite(last);
  const age = hasLast ? Math.max(0, Math.round((nowMs - last) / 60_000)) : null;
  const dueAt = hasLast ? last + cadence * 60_000 : NaN;
  const late = hasLast ? Math.max(0, Math.round((nowMs - dueAt) / 60_000)) : 0;
  const budget = hb?.budget;
  let state: PulseView["state"] = "never";
  if (hasLast) state = hb?.lastPulseStatus === "error" ? "error" : late > cadence ? "late" : "ok";
  return {
    state,
    lastAt: hasLast ? new Date(last).toISOString() : null,
    ageMinutes: age,
    nextDueAt: hasLast ? new Date(dueAt).toISOString() : null,
    minutesLate: late,
    durationMs: hb?.lastPulseDurationMs ?? null,
    claimed: hb?.lastPulseTasksClaimed ?? 0,
    completed: hb?.lastPulseTasksCompleted ?? 0,
    failed: hb?.lastPulseTasksFailed ?? 0,
    modelCalls: typeof hb?.modelCalls === "number" ? hb.modelCalls : null,
    budgetUsedPct: budget && budget.budgetMs > 0 ? Math.min(100, Math.round((budget.elapsedMs / budget.budgetMs) * 1000) / 10) : null,
    budgetMs: budget?.budgetMs ?? null,
    consecutiveFailures: hb?.consecutivePulseFailures ?? 0,
    totalPulses: hb?.totalPulses ?? 0,
    cadenceMinutes: cadence,
    lastError: hb?.lastPulseError ?? null,
    pulseId: hb?.pulseId ?? null,
    recentDurations: recent.map((p) => p.durationMs),
    recentErrors: recent.filter((p) => p.status === "error").length,
    window: recent.length,
  };
}

/** The real gaps between pulses over the last day (Wave 12, R1). The cron asks for 15 minutes. GitHub often runs it later. */
export interface PulseGapStats {
  count: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  maxMinutes: number | null;
}

export function pulseGapStats(history: PulseHistoryEntry[] | undefined, nowMs: number, windowHours = 24): PulseGapStats {
  const from = nowMs - windowHours * 3_600_000;
  const times = (history ?? [])
    .map((p) => Date.parse(p.at))
    .filter((t) => Number.isFinite(t) && t >= from && t <= nowMs)
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) gaps.push((times[i] - times[i - 1]) / 60_000);
  if (gaps.length === 0) return { count: 0, medianMinutes: null, p90Minutes: null, maxMinutes: null };
  gaps.sort((a, b) => a - b);
  const rank = (q: number) => gaps[Math.min(gaps.length - 1, Math.max(0, Math.ceil(q * gaps.length) - 1))];
  const round = (n: number) => Math.round(n * 10) / 10;
  return { count: gaps.length, medianMinutes: round(rank(0.5)), p90Minutes: round(rank(0.9)), maxMinutes: round(gaps[gaps.length - 1]) };
}
