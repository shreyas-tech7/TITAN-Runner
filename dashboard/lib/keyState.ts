/**
 * How the Keys page words and colors a key (Wave 12, K7). A label tells the truth: "Saved, not verified" is what it says
 * when nobody has proved the key. A color is never the only signal, because every state is also a word.
 */
import type { KeyRow, KeyState, ProviderCheck, RunnerProof } from "./keysApi";
import { PROVIDER_CATALOG } from "./providers";
import { relative } from "./time";

export type Tone = "ion" | "plasma" | "corona" | "ok" | "warn" | "danger" | "neutral";

export const STATE_META: Record<KeyState, { label: string; tone: Tone }> = {
  missing: { label: "Missing", tone: "neutral" },
  saved_unverified: { label: "Saved, not verified", tone: "warn" },
  provider_ok: { label: "Provider accepted", tone: "ion" },
  proven: { label: "Proven", tone: "ok" },
  invalid: { label: "Invalid", tone: "danger" },
  rate_limited: { label: "Rate limited", tone: "warn" },
  unverifiable: { label: "Cannot be checked", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

/** The text for the key column. A key set outside the dashboard has no fingerprint and no last four characters. */
export function keyColumn(row: Pick<KeyRow, "secretPresent" | "savedVia" | "last4" | "replacedOutside">): string {
  if (row.secretPresent === false) return "none";
  if (row.secretPresent === null) return "unknown";
  if (row.savedVia === "dashboard" && row.last4) return `••••${row.last4}`;
  return row.replacedOutside ? "changed outside" : "set outside";
}

export function savedColumn(row: Pick<KeyRow, "secretPresent" | "savedAt" | "secretUpdatedAt" | "savedVia">): string {
  if (!row.secretPresent) return "";
  const at = row.secretUpdatedAt ?? row.savedAt;
  const via = row.savedVia === "dashboard" ? "on the dashboard" : "outside the dashboard";
  return at ? `${relative(at)}, ${via}` : via;
}

function ms(n: number | null): string {
  return n === null || n === undefined ? "" : `${Math.round(n)} ms`;
}

const CHECK_LABEL: Record<string, string> = {
  ok: "Accepted",
  rejected: "Rejected",
  rate_limited: "Rate limited",
  timeout: "No answer",
  unreachable: "Unreachable",
  unverifiable: "No check route",
  bad_url: "Bad address",
  error: "Error",
};

export function describeCheck(c: ProviderCheck | null): string {
  if (!c) return "not checked";
  const parts = [CHECK_LABEL[c.result] ?? c.result, c.httpStatus ? `HTTP ${c.httpStatus}` : "", ms(c.latencyMs), relative(c.at)];
  return parts.filter(Boolean).join(" · ");
}

export function describeProof(p: RunnerProof | null): string {
  if (!p) return "none yet";
  const who = p.source === "pulse" ? "pulse" : "runner";
  const parts = [p.result === "ok" ? `Passed (${who})` : `Failed (${who})`, p.model ?? "", ms(p.latencyMs), relative(p.at)];
  return parts.filter(Boolean).join(" · ");
}

export function modelsColumn(row: Pick<KeyRow, "pulseView" | "runnerProof">): string {
  const view = row.pulseView;
  if (view && view.modelCount > 0) return `${view.modelCount} found${view.model ? `, in use: ${view.model}` : ""}`;
  return row.runnerProof?.model ?? "";
}

/** A soft hint for a key that does not look like the usual format. It never blocks a save. */
export function hintWarning(providerId: string, value: string): string | null {
  const entry = PROVIDER_CATALOG.find((p) => p.id === providerId);
  const v = value.trim();
  if (!entry || !v) return null;
  const prefixes = entry.keyHint.prefixes ?? [];
  const pattern = (entry as unknown as { keyHint: { pattern?: string } }).keyHint.pattern;
  if (prefixes.length === 0 && !pattern) return null;
  if (prefixes.some((p) => v.startsWith(p))) return null;
  if (pattern && new RegExp(pattern).test(v)) return null;
  return entry.keyHint.text || "This key does not look like the usual format.";
}

/** The format rule of the Worker: one printable token, 1024 characters at most. */
export function formatProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return "Paste the key first.";
  if (v.length > 1024) return "The key is too long. The limit is 1024 characters.";
  if (!/^[\x21-\x7e]+$/.test(v)) return "A key is one token with no spaces. Check what you pasted.";
  return null;
}

/** Providers that give a free key without a card. They come from the catalog, in failover order. */
export function noCardProviders(rows: Pick<KeyRow, "id" | "label" | "noCard" | "getKeyUrl">[]): Pick<KeyRow, "id" | "label" | "getKeyUrl">[] {
  return rows.filter((r) => r.noCard && r.getKeyUrl && !r.id.startsWith("hermes_") && !r.id.startsWith("custom_") && r.id !== "omniroute" && r.id !== "freebuff");
}

export function configuredCount(rows: Pick<KeyRow, "secretPresent">[]): number {
  return rows.filter((r) => r.secretPresent).length;
}

export function provenCount(rows: Pick<KeyRow, "state">[]): number {
  return rows.filter((r) => r.state === "proven").length;
}
