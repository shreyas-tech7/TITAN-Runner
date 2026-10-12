/**
 * The words, tones, and numbers of the ops panels (RD1): provider health, the quota meter, the eval scores, the host
 * status, and the lessons. Each function takes the parsed public mirror (`state/ops/*.json`, `state/lessons.jsonl`) and
 * returns rows that a panel prints. There is no React here, so the tests can check every rule without a browser.
 *
 * The mirrors follow contract v1 (docs/CONTRACT.md). A value that is unknown stays unknown: a limit that the docs do not
 * state is `null`, and the meter says "limit unknown". It never shows a guessed number.
 */
import type { Tone } from "@/components/kit";

// ---------------------------------------------------------------------
// The shapes of the mirrors (contract v1)
// ---------------------------------------------------------------------

export interface HealthMirror {
  contract: string;
  generated_at: string;
  providers: Record<string, Record<string, { status: string; latency_ms: number | null; checked_at: string; error_class: string | null }>>;
}

export interface QuotaEntry {
  limit_day: number | null;
  used_day: number;
  limit_month: number | null;
  used_month: number;
  remaining_pct: number | null;
  resets_at: string | null;
  exhausted: boolean;
  limit_source: string | null;
  limit_confidence: string;
}
export interface QuotaMirror {
  contract: string;
  generated_at: string;
  providers: Record<string, Record<string, QuotaEntry>>;
}

export interface EvalMirror {
  contract: string;
  generated_at: string;
  eval_version?: string;
  models: Record<string, Record<string, { score: number; tasks_run: number; run_at: string; eval_version: string }>>;
}

export interface HostEntry {
  status: string;
  last_check: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
  last_pulse_at?: string | null;
}
export interface HostsMirror {
  contract: string;
  generated_at: string;
  hosts: Record<string, HostEntry>;
}

export interface Lesson {
  id: string;
  signature: string;
  first_seen: string;
  last_seen: string;
  count: number;
  task_type?: string | null;
  what_failed: string;
  likely_cause: string;
  suggested_fix: string;
  source: string;
}

// ---------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------

const HOUR = 3_600_000;
/** A mirror older than this is called stale. Each limit is the write rhythm of its workflow plus slack. */
export const STALE_AFTER_MS = { health: 36 * HOUR, quota: 9 * HOUR, eval: 10 * 24 * HOUR, hosts: 9 * HOUR } as const;

/** True when the time is missing, not a date, or older than `maxAgeMs`. */
export function isStale(iso: string | null | undefined, maxAgeMs: number, now = Date.now()): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || now - t > maxAgeMs;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 12, 00:00 UTC". The quota windows follow UTC, so the page names UTC and does not convert. */
export function utcStamp(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

// ---------------------------------------------------------------------
// Provider health
// ---------------------------------------------------------------------

export const HEALTH_META: Record<string, { label: string; tone: Tone; rank: number }> = {
  down: { label: "Down", tone: "danger", rank: 0 },
  degraded: { label: "Degraded", tone: "warn", rank: 1 },
  healthy: { label: "Healthy", tone: "ok", rank: 2 },
  not_configured: { label: "Not set up", tone: "neutral", rank: 3 },
};

export interface HealthRow {
  provider: string;
  model: string;
  status: string;
  label: string;
  tone: Tone;
  latencyMs: number | null;
  checkedAt: string;
  errorClass: string | null;
}

/** One row for each provider and model, the ones with a problem first. */
export function healthRows(data: HealthMirror | null | undefined): HealthRow[] {
  const rows: HealthRow[] = [];
  for (const [provider, models] of Object.entries(data?.providers ?? {})) {
    for (const [model, h] of Object.entries(models ?? {})) {
      const meta = HEALTH_META[h.status] ?? { label: h.status, tone: "neutral" as Tone, rank: 4 };
      rows.push({ provider, model, status: h.status, label: meta.label, tone: meta.tone, latencyMs: h.latency_ms ?? null, checkedAt: h.checked_at, errorClass: h.error_class ?? null });
    }
  }
  const rank = (s: string) => (HEALTH_META[s]?.rank ?? 4);
  return rows.sort((a, b) => rank(a.status) - rank(b.status) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

export function healthSummary(rows: HealthRow[]): Record<"healthy" | "degraded" | "down" | "not_configured", number> {
  const out = { healthy: 0, degraded: 0, down: 0, not_configured: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] += 1;
  return out;
}

const ERROR_WORDS: Record<string, string> = {
  rate_limited: "rate limited",
  auth: "the key was refused",
  quota: "out of quota",
  model_invalid: "the model name is not valid",
  timeout: "timed out",
  wrong_answer: "gave a wrong answer",
  bad_format: "broke the answer format",
  slow: "slow answer",
  flaky: "failed once, then worked",
  provider_down: "the provider is down",
  error: "an error",
  no_key: "no key is set",
  no_public_api: "no public API to check",
};
export const errorWords = (c: string | null): string | null => (c ? ERROR_WORDS[c] ?? c.replace(/_/g, " ") : null);

// ---------------------------------------------------------------------
// Quota meter
// ---------------------------------------------------------------------

export interface OpsQuotaRow {
  provider: string;
  model: string;
  confidence: "official" | "observed" | "unknown";
  limitDay: number | null;
  usedDay: number;
  /** Share of the day limit that is used, 0 to 100. Null when the limit is not known. */
  dayPct: number | null;
  limitMonth: number | null;
  usedMonth: number;
  monthPct: number | null;
  remainingPct: number | null;
  resetsAt: string | null;
  exhausted: boolean;
  source: string | null;
}

const pct = (used: number, limit: number | null) => (limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null);

export function opsQuotaRows(data: QuotaMirror | null | undefined): OpsQuotaRow[] {
  const rows: OpsQuotaRow[] = [];
  for (const [provider, models] of Object.entries(data?.providers ?? {})) {
    for (const [model, q] of Object.entries(models ?? {})) {
      const known = q.limit_confidence === "official" || q.limit_confidence === "observed";
      rows.push({
        provider, model,
        confidence: known ? (q.limit_confidence as "official" | "observed") : "unknown",
        limitDay: q.limit_day ?? null, usedDay: q.used_day ?? 0, dayPct: pct(q.used_day ?? 0, q.limit_day ?? null),
        limitMonth: q.limit_month ?? null, usedMonth: q.used_month ?? 0, monthPct: pct(q.used_month ?? 0, q.limit_month ?? null),
        remainingPct: q.remaining_pct ?? null, resetsAt: q.resets_at ?? null, exhausted: Boolean(q.exhausted), source: q.limit_source ?? null,
      });
    }
  }
  return rows.sort((a, b) => Number(b.exhausted) - Number(a.exhausted) || (b.dayPct ?? -1) - (a.dayPct ?? -1) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

export const CONFIDENCE_LABEL = { official: "official limit", observed: "limit seen in a provider header", unknown: "limit unknown" } as const;

/** The tone of a day meter. A bar is green until 70 percent. The router stops at 95 percent. */
export function quotaTone(row: Pick<OpsQuotaRow, "dayPct" | "exhausted">): Tone {
  if (row.exhausted) return "danger";
  if (row.dayPct === null) return "neutral";
  return row.dayPct >= 85 ? "danger" : row.dayPct >= 70 ? "warn" : "ok";
}

/** Only an https link goes into the page. A mirror is public data, but a link still must be safe to follow. */
export const safeSource = (url: string | null): string | null => (url && /^https:\/\/[^\s]+$/i.test(url) ? url : null);

// ---------------------------------------------------------------------
// Eval scores
// ---------------------------------------------------------------------

export interface EvalCategoryRow { category: string; label: string; score: number; pct: number; tasksRun: number; tone: Tone }
export interface EvalCard {
  model: string;
  average: number;
  averagePct: number;
  tone: Tone;
  tasksRun: number;
  runAt: string | null;
  version: string | null;
  categories: EvalCategoryRow[];
}

export const scoreTone = (score: number): Tone => (score >= 0.8 ? "ok" : score >= 0.5 ? "warn" : "danger");
export const categoryLabel = (c: string): string => c.replace(/-/g, " ").replace(/^./, (m) => m.toUpperCase());

/** One card for each model, the best average first. A category that ran no task is left out, never shown as zero. */
export function evalCards(data: EvalMirror | null | undefined): EvalCard[] {
  const cards: EvalCard[] = [];
  for (const [model, cats] of Object.entries(data?.models ?? {})) {
    const categories: EvalCategoryRow[] = Object.entries(cats ?? {})
      .filter(([, v]) => v && v.tasks_run > 0 && Number.isFinite(v.score))
      .map(([category, v]) => ({ category, label: categoryLabel(category), score: v.score, pct: Math.round(v.score * 100), tasksRun: v.tasks_run, tone: scoreTone(v.score) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (categories.length === 0) continue;
    const tasksRun = categories.reduce((n, c) => n + c.tasksRun, 0);
    // Weighted by the number of tasks, so a category with 2 tasks counts twice a category with 1.
    const average = categories.reduce((n, c) => n + c.score * c.tasksRun, 0) / tasksRun;
    const first = Object.values(cats).find((v) => v?.run_at);
    cards.push({ model, average, averagePct: Math.round(average * 100), tone: scoreTone(average), tasksRun, runAt: first?.run_at ?? null, version: first?.eval_version ?? null, categories });
  }
  return cards.sort((a, b) => b.average - a.average || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------------
// Host status
// ---------------------------------------------------------------------

export const HOST_META: Record<string, { label: string; tone: Tone; note: string }> = {
  up: { label: "Up", tone: "ok", note: "The host answers." },
  asleep: { label: "Asleep", tone: "ion", note: "Asleep by design. It wakes on a request. This is not an outage." },
  down: { label: "Down", tone: "danger", note: "The host does not answer, or answers with an error." },
};

const HOST_ORDER = ["github_actions", "github_status", "hf_space", "render_1", "render_2", "render_3", "titan_gev", "hermes_1", "hermes_2", "hermes_3"];

/** A readable name for a host name. The names are the only thing that the probe stores about a host. */
export function hostLabel(name: string): string {
  const numbered = name.match(/^(render|hermes)_(\d+)$/);
  if (numbered) return `${numbered[1] === "render" ? "Render" : "Hermes"} ${numbered[2]}`;
  return ({ github_actions: "GitHub Actions pulse", github_status: "GitHub status", hf_space: "Hugging Face Space", titan_gev: "God's Eye View host" } as Record<string, string>)[name] ?? name.replace(/_/g, " ");
}

export const uptimeTone = (p: number): Tone => (p >= 99 ? "ok" : p >= 95 ? "warn" : "danger");

export interface UptimeBar { window: string; pct: number | null; tone: Tone }
export interface HostRow {
  name: string;
  label: string;
  status: string;
  statusLabel: string;
  tone: Tone;
  note: string;
  lastCheck: string | null;
  lastPulseAt: string | null;
  bars: UptimeBar[];
}

export function hostRows(data: HostsMirror | null | undefined): HostRow[] {
  const rows = Object.entries(data?.hosts ?? {}).map(([name, h]): HostRow => {
    const meta = HOST_META[h.status] ?? { label: h.status, tone: "neutral" as Tone, note: "" };
    const bar = (window: string, p: number | null | undefined): UptimeBar => ({ window, pct: p ?? null, tone: p == null ? "neutral" : uptimeTone(p) });
    return {
      name, label: hostLabel(name), status: h.status, statusLabel: meta.label, tone: meta.tone, note: meta.note, lastCheck: h.last_check ?? null, lastPulseAt: h.last_pulse_at ?? null,
      bars: [bar("24 hours", h.uptime_24h), bar("7 days", h.uptime_7d), bar("30 days", h.uptime_30d)],
    };
  });
  const order = (n: string) => { const i = HOST_ORDER.indexOf(n); return i === -1 ? HOST_ORDER.length : i; };
  return rows.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------
// Lessons (state/lessons.jsonl)
// ---------------------------------------------------------------------

/** Parse the JSON lines of the lessons file. A line that is not a lesson is skipped, so one bad line cannot blank the panel. */
export function parseLessons(text: string, limit = 12): Lesson[] {
  const out: Lesson[] = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<Lesson>;
      if (typeof v.id === "string" && typeof v.signature === "string" && typeof v.what_failed === "string" && typeof v.count === "number") {
        out.push({
          id: v.id, signature: v.signature, first_seen: String(v.first_seen ?? ""), last_seen: String(v.last_seen ?? ""), count: v.count, task_type: v.task_type ?? null,
          what_failed: v.what_failed, likely_cause: String(v.likely_cause ?? ""), suggested_fix: String(v.suggested_fix ?? ""), source: String(v.source ?? ""),
        });
      }
    } catch {
      // not JSON: skip the line
    }
  }
  return out.sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen)).slice(0, limit);
}

// ---------------------------------------------------------------------
// Security panel (behind the sign-in)
// ---------------------------------------------------------------------

export interface SigninEntry { id: number; at: string; ip: string; userAgent: string | null; route: string; result: string; reason: string }
export interface SigninLog {
  generatedAt: string;
  summary: { success: number; failure: number; blocked: number; distinctIps: number };
  entries: SigninEntry[];
}

export const SIGNIN_META: Record<string, { label: string; tone: Tone }> = {
  success: { label: "Signed in", tone: "ok" },
  failure: { label: "Wrong token", tone: "warn" },
  blocked: { label: "Blocked", tone: "danger" },
};

const REASON_WORDS: Record<string, string> = {
  ok: "correct token",
  wrong_token: "wrong token",
  missing_token: "no token sent",
  bad_body: "unreadable request",
  locked: "locked out after wrong tokens",
  rate_limited: "too many requests",
  session_expired: "session ended",
};
export const reasonWords = (r: string): string => REASON_WORDS[r] ?? r.replace(/_/g, " ");

/** The one line that sums up the last 24 hours. Failures and blocks are named first, because they are what to look for. */
export function signinHeadline(s: SigninLog["summary"]): { tone: Tone; text: string } {
  const bad = s.failure + s.blocked;
  const ips = `${s.distinctIps} address${s.distinctIps === 1 ? "" : "es"}`;
  if (s.blocked > 0) return { tone: "danger", text: `${s.blocked} blocked and ${s.failure} wrong token attempts in the last 24 hours, from ${ips} in all.` };
  if (bad > 0) return { tone: "warn", text: `${s.failure} wrong token attempt${s.failure === 1 ? "" : "s"} in the last 24 hours. ${s.success} sign-in${s.success === 1 ? "" : "s"} worked, from ${ips} in all.` };
  return { tone: "ok", text: `No wrong token in the last 24 hours. ${s.success} sign-in${s.success === 1 ? "" : "s"}, from ${ips}.` };
}

export interface GitleaksRun { status: string | null; conclusion: string | null; updatedAt: string | null; url: string | null }

/** What the last run of the gitleaks workflow says, in words. A missing run is not green. */
export function gitleaksStatus(run: GitleaksRun | null): { tone: Tone; label: string; detail: string } {
  if (!run) return { tone: "neutral", label: "No run yet", detail: "The gitleaks workflow has not run, or its status could not be read." };
  if (run.status && run.status !== "completed") return { tone: "ion", label: "Running", detail: "A scan is running now." };
  if (run.conclusion === "success") return { tone: "ok", label: "Clean", detail: "The last scan of the full history found no secret." };
  if (run.conclusion === "failure") return { tone: "danger", label: "Found something", detail: "The last scan found a secret-shaped string. Open the run, rotate the key, and do not rewrite history." };
  return { tone: "warn", label: run.conclusion ?? "Unknown", detail: "The last scan did not finish as expected. Open the run." };
}
