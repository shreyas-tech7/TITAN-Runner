export function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Elapsed-time display for something still running (a live task, a
 * sub-agent) — coarser and longer-range than `formatDuration`, which is
 * tuned for sub-minute pulse timings. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Next pulse countdown (task instructions, section 3): the cron fires every
 * `cadenceMinutes`, so the honest estimate is "cadence minutes after the
 * last recorded pulse" — with the explicit caveat that GitHub's schedule is
 * best-effort and can run late (surfaced in the UI alongside this, never
 * silently). Returns milliseconds until the estimated next pulse; negative
 * once it's overdue (the UI shows "due now" / "running late" rather than a
 * negative countdown).
 */
export function msUntilNextPulse(lastPulseAt: string | null, cadenceMinutes: number): number | null {
  if (!lastPulseAt) return null;
  const last = Date.parse(lastPulseAt);
  if (!Number.isFinite(last)) return null;
  const next = last + cadenceMinutes * 60_000;
  return next - Date.now();
}
