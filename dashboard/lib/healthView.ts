/**
 * The words and rules of the Health Center and the setup checklist (Wave 12, H1 to H4). Pure functions.
 * A state is a word as well as a color. "Not tested" is its own state, and it is never green.
 */
import type { HealthGroup, HealthRow, HealthState, HealthSummary, SetupItem } from "./healthApi";
import type { Tone } from "@/components/kit";

export const HEALTH_STATE_META: Record<HealthState, { label: string; tone: Tone }> = {
  ok: { label: "Working", tone: "ok" },
  warn: { label: "Needs a look", tone: "warn" },
  down: { label: "Not working", tone: "danger" },
  unknown: { label: "Not tested", tone: "neutral" },
};

export const GROUP_ORDER: HealthGroup[] = ["core", "keys", "connectors", "fleet", "external"];

export const GROUP_LABEL: Record<HealthGroup, string> = {
  core: "Core",
  keys: "Provider keys",
  connectors: "Connectors",
  fleet: "VM fleet",
  external: "Other services",
};

export function groupRows(rows: HealthRow[]): Array<{ group: HealthGroup; label: string; rows: HealthRow[] }> {
  return GROUP_ORDER.map((group) => ({ group, label: GROUP_LABEL[group], rows: rows.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}

/** One sentence for the top of the page. It counts what is not working before it says anything good. */
export function overallLine(summary: HealthSummary): { tone: Tone; text: string } {
  if (summary.down > 0) return { tone: "danger", text: `${summary.down} ${summary.down === 1 ? "part is" : "parts are"} not working.` };
  if (summary.warn > 0) return { tone: "warn", text: `${summary.warn} ${summary.warn === 1 ? "part needs" : "parts need"} a look.` };
  if (summary.unknown > 0 && summary.ok === 0) return { tone: "neutral", text: "No part was tested yet." };
  if (summary.unknown > 0) return { tone: "ok", text: `All tested parts work. ${summary.unknown} ${summary.unknown === 1 ? "part was" : "parts were"} not tested.` };
  return { tone: "ok", text: "All parts work." };
}

export function summaryOf(rows: Array<{ state: HealthState }>): HealthSummary {
  const s: HealthSummary = { ok: 0, warn: 0, down: 0, unknown: 0 };
  for (const r of rows) s[r.state] += 1;
  return s;
}

/** The fix link for a row. A path that starts with "/" is a page of this dashboard, so it gets the base path. */
export function fixHref(href: string, basePath: string): string {
  if (/^https?:\/\//.test(href)) return href;
  return `${basePath}${href.startsWith("/") ? href : `/${href}`}`;
}

export const isExternalHref = (href: string) => /^https?:\/\//.test(href);

// ---------------------------------------------------------------------
// The setup ring (H3)
// ---------------------------------------------------------------------

/** The ring is drawn with stroke-dasharray, so the numbers come from here. */
export function ringGeometry(done: number, total: number, radius = 22): { circumference: number; dash: number; gap: number; percent: number } {
  const circumference = 2 * Math.PI * radius;
  const percent = total <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  const dash = (percent / 100) * circumference;
  return { circumference, dash, gap: circumference - dash, percent };
}

/** The next item to fix is the first one that is not done. */
export function nextSetupItem(items: SetupItem[]): SetupItem | null {
  return items.find((i) => !i.done) ?? null;
}

// ---------------------------------------------------------------------
// The version warning (H4)
// ---------------------------------------------------------------------

/**
 * The dashboard and the Worker ship from the same commit when both merge together. They can differ for a short time after a
 * deploy, or for a long time when one deploy fails. Only a real difference of two known commits is a warning.
 */
export function versionMismatch(dashboardCommit: string, workerCommit: string | null | undefined): boolean {
  const known = (c: string | null | undefined): c is string => Boolean(c) && c !== "unknown" && c !== "dev";
  if (!known(dashboardCommit) || !known(workerCommit)) return false;
  const n = Math.min(dashboardCommit.length, workerCommit.length, 7);
  return dashboardCommit.slice(0, n) !== workerCommit.slice(0, n);
}
