/**
 * The logic behind the assistant-first home screen: the greeting, the state of the AI core, the label of each
 * co-processor, and the tabs of the Systems Deck. Pure functions, so the tests need no browser.
 */
import type { ProviderHealthRecord, TaskRecord } from "./types";

/** The command center runs on Central time, as the clock does. */
export const CORE_TIME_ZONE = "America/Chicago";

export type CoreState = "online" | "degraded" | "offline" | "thinking";

export const CORE_STATE_LABEL: Record<CoreState, string> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
  thinking: "Thinking",
};

export function greetingFor(hour: number): string {
  if (!Number.isFinite(hour)) return "Hello";
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The hour (0 to 23) in the command center's time zone. */
export function coreHour(now: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: CORE_TIME_ZONE, hour: "numeric", hour12: false })
    .formatToParts(now)
    .find((p) => p.type === "hour");
  const h = Number(part?.value);
  return h === 24 ? 0 : h;
}

/** Tasks that wait for a runner. A running task is not queued. */
export function queuedCount(tasks: TaskRecord[]): number {
  return tasks.filter((t) => t.status === "pending" || t.status === "waiting").length;
}

export function runningCount(tasks: TaskRecord[]): number {
  return tasks.filter((t) => t.status === "running").length;
}

export function taskSummary(tasks: TaskRecord[]): string {
  const queued = queuedCount(tasks);
  const running = runningCount(tasks);
  if (queued === 0 && running === 0) return "No tasks are waiting.";
  const parts: string[] = [];
  if (queued > 0) parts.push(`${queued} ${queued === 1 ? "task" : "tasks"} queued`);
  if (running > 0) parts.push(`${running} running`);
  return `${parts.join(", ")}.`;
}

const ONLINE_STATUSES = new Set(["ok"]);
const DEGRADED_STATUSES = new Set(["rate_limited", "exhausted", "model_invalid"]);

export function providerCounts(providers: Record<string, ProviderHealthRecord> | undefined): { online: number; degraded: number; failed: number } {
  let online = 0;
  let degraded = 0;
  let failed = 0;
  for (const r of Object.values(providers ?? {})) {
    if (ONLINE_STATUSES.has(r.status)) online += 1;
    else if (DEGRADED_STATUSES.has(r.status)) degraded += 1;
    else if (r.status === "error" || r.status === "misconfigured") failed += 1;
  }
  return { online, degraded, failed };
}

/**
 * The state of the AI core. A reply in flight is "thinking". A late pulse or a limited provider is "degraded".
 * No working provider and a late pulse together is "offline". No data yet counts as online, so the core does
 * not flash red before the first poll returns.
 */
export function coreState(input: { streaming: boolean; pulseAgeMinutes: number | null; providers: Record<string, ProviderHealthRecord> | undefined }): CoreState {
  if (input.streaming) return "thinking";
  const stale = input.pulseAgeMinutes !== null && input.pulseAgeMinutes >= 45;
  const counts = providerCounts(input.providers);
  const known = counts.online + counts.degraded + counts.failed;
  if (stale && known > 0 && counts.online === 0) return "offline";
  if (stale || counts.degraded > 0 || (known > 0 && counts.online === 0)) return "degraded";
  return "online";
}

/** What each provider is best used for. A provider that is not here gets the generic label. */
const COPROCESSOR_ROLES: Record<string, { role: string; short: string }> = {
  groq: { role: "Latency Engine", short: "Fastest replies" },
  gemini: { role: "Reasoning Engine", short: "Long context and deep reasoning" },
  openrouter: { role: "Routing Mesh", short: "Many models behind one key" },
  together: { role: "Open Model Engine", short: "Open-weight models" },
  huggingface: { role: "Model Hub Engine", short: "Hosted open models" },
  opencode: { role: "Code Engine", short: "Coding agent" },
  omniroute: { role: "Gateway Engine", short: "Gateway for many providers" },
  freebuff: { role: "Reserve Engine", short: "Free reserve capacity" },
};

export function coprocessorRole(providerId: string): { role: string; short: string } {
  const known = COPROCESSOR_ROLES[providerId];
  if (known) return known;
  if (providerId.startsWith("hermes_")) return { role: "Agent Engine", short: "Hermes agent" };
  if (providerId.startsWith("custom_")) return { role: "Custom Engine", short: "Custom provider" };
  return { role: "General Engine", short: "General-purpose dispatch target" };
}

/** The names of the working chat engines, for the status line of the HUD bar. */
export function engineSummary(providers: Record<string, ProviderHealthRecord> | undefined, max = 2): string {
  const names = Object.values(providers ?? {})
    .filter((r) => ONLINE_STATUSES.has(r.status))
    .map((r) => r.id.charAt(0).toUpperCase() + r.id.slice(1));
  if (names.length === 0) return "No engine checked yet";
  const shown = names.slice(0, max).join("/");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

export type DeckTab = "overview" | "brief" | "coprocessors" | "gods-eye" | "schedules";

export const DECK_TABS: { id: DeckTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "brief", label: "Daily Brief" },
  { id: "coprocessors", label: "Co-Processors" },
  { id: "gods-eye", label: "God's Eye" },
  { id: "schedules", label: "Schedules" },
];

export function parseDeckTab(v: string | null | undefined): DeckTab | null {
  return DECK_TABS.some((t) => t.id === v) ? (v as DeckTab) : null;
}
