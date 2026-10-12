// RD1: the words, tones, and numbers of the ops panels, and the markup of each panel. The panels read public mirrors, so
// every test builds a mirror by hand and checks what a person would read.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import OpsHealthPanel from "../components/OpsHealthPanel";
import OpsQuotaPanel from "../components/OpsQuotaPanel";
import EvalScoresPanel from "../components/EvalScoresPanel";
import HostStatusPanel from "../components/HostStatusPanel";
import LessonsPanel from "../components/LessonsPanel";
import { SecurityView } from "../components/SecurityPanel";
import TopTabs from "../components/TopTabs";
import { getDemoStateFile } from "../lib/demoFixtures";
import {
  STALE_AFTER_MS, evalCards, gitleaksStatus, healthRows, healthSummary, hostLabel, hostRows, isStale, opsQuotaRows, parseLessons, quotaTone, reasonWords,
  safeSource, scoreTone, signinHeadline, uptimeTone, utcStamp,
  type EvalMirror, type HealthMirror, type HostsMirror, type Lesson, type QuotaMirror, type SigninLog,
} from "../lib/opsView";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ready = <T,>(data: T) => ({ data, loading: false, error: null });

const health: HealthMirror = {
  contract: "1", generated_at: ago(60),
  providers: {
    groq: { llama: { status: "healthy", latency_ms: 300, checked_at: ago(60), error_class: null } },
    gemini: { flash: { status: "degraded", latency_ms: 9000, checked_at: ago(60), error_class: "slow" } },
    openrouter: { free: { status: "down", latency_ms: null, checked_at: ago(60), error_class: "rate_limited" } },
    together: { m: { status: "not_configured", latency_ms: null, checked_at: ago(60), error_class: "no_key" } },
    mistral: { m: { status: "not_configured", latency_ms: null, checked_at: ago(60), error_class: "no_key" } },
  },
};

test("RD1 health: rows put a problem first and a provider with no key last", () => {
  assert.deepEqual(healthRows(health).map((r) => r.status), ["down", "degraded", "healthy", "not_configured", "not_configured"]);
  assert.deepEqual(healthSummary(healthRows(health)), { healthy: 1, degraded: 1, down: 1, not_configured: 2 });
  assert.deepEqual(healthRows(null), []);
  assert.deepEqual(healthRows({ contract: "1", generated_at: ago(1), providers: {} }), []);
});

test("RD1 health: the panel says each status in words, names the error, and lists the unset providers in one line", () => {
  const html = renderToStaticMarkup(<OpsHealthPanel health={ready(health)} now={NOW} />);
  assert.match(html, /1 healthy, 1 degraded, 1 down, 2 not set up\./);
  for (const word of ["Down", "Degraded", "Healthy"]) assert.ok(html.includes(`>${word}<`), word);
  assert.match(html, /rate limited/);
  assert.match(html, /slow answer/);
  assert.match(html, /No key set for mistral, together/);
  assert.equal((html.match(/data-health="not_configured"/g) ?? []).length, 0, "an unset provider is not a row");
  assert.ok(!html.includes("rate_limited"), "the raw error code does not reach the page");
  assert.ok(!html.includes("stale"), "a 60 minute old mirror is not stale");
});

test("RD1 health: an empty mirror, a loading file, and a failed load each say so", () => {
  assert.match(renderToStaticMarkup(<OpsHealthPanel health={ready({ contract: "1", generated_at: ago(1), providers: {} })} now={NOW} />), /No canary has run yet/);
  assert.match(renderToStaticMarkup(<OpsHealthPanel health={{ data: null, loading: true, error: null }} />), /Loading the canary results/);
  const failed = renderToStaticMarkup(<OpsHealthPanel health={{ data: null, loading: false, error: "local copy responded 404" }} />);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Could not load the canary results \(local copy responded 404\)/);
});

test("RD1 stale: a mirror older than its write rhythm is called stale, a missing time is stale, a fresh one is not", () => {
  assert.equal(isStale(ago(60), STALE_AFTER_MS.health, NOW), false);
  assert.equal(isStale(ago(37 * 60), STALE_AFTER_MS.health, NOW), true);
  assert.equal(isStale(ago(10 * 60), STALE_AFTER_MS.hosts, NOW), true);
  assert.equal(isStale(null, 1000, NOW), true);
  assert.equal(isStale("not a date", 1000, NOW), true);
  const stale = renderToStaticMarkup(<OpsHealthPanel health={ready({ ...health, generated_at: ago(40 * 60) })} now={NOW} />);
  assert.match(stale, /stale, updated/);
});

const quota: QuotaMirror = {
  contract: "1", generated_at: ago(20),
  providers: {
    groq: { llama: { limit_day: 1000, used_day: 742, limit_month: null, used_month: 9120, remaining_pct: 25.8, resets_at: "2026-10-13T00:00:00.000Z", exhausted: false, limit_source: "https://console.groq.com/docs/rate-limits", limit_confidence: "observed" } },
    gemini: { flash: { limit_day: null, used_day: 61, limit_month: null, used_month: 802, remaining_pct: null, resets_at: "2026-10-13T00:00:00.000Z", exhausted: false, limit_source: null, limit_confidence: "unknown" } },
    openrouter: { free: { limit_day: 50, used_day: 50, limit_month: 1500, used_month: 410, remaining_pct: 0, resets_at: "2026-10-13T00:00:00.000Z", exhausted: true, limit_source: "javascript:alert(1)", limit_confidence: "official" } },
  },
};

test("RD1 quota: an exhausted model comes first, then the fullest meter, and an unknown limit has no percent", () => {
  const rows = opsQuotaRows(quota);
  assert.deepEqual(rows.map((r) => r.provider), ["openrouter", "groq", "gemini"]);
  assert.equal(rows[1].dayPct, 74);
  assert.equal(rows[2].dayPct, null);
  assert.equal(rows[2].confidence, "unknown");
  assert.equal(rows[0].monthPct, 27);
});

test("RD1 quota: tones follow 70 and 85 percent, an exhausted model is red, and an unknown limit is neutral", () => {
  assert.equal(quotaTone({ dayPct: 10, exhausted: false }), "ok");
  assert.equal(quotaTone({ dayPct: 70, exhausted: false }), "warn");
  assert.equal(quotaTone({ dayPct: 85, exhausted: false }), "danger");
  assert.equal(quotaTone({ dayPct: 10, exhausted: true }), "danger");
  assert.equal(quotaTone({ dayPct: null, exhausted: false }), "neutral");
});

test("RD1 quota: the panel never invents a limit, shows a meter only for a known limit, and links only https sources", () => {
  const html = renderToStaticMarkup(<OpsQuotaPanel quota={ready(quota)} now={NOW} />);
  assert.match(html, /742 of 1,000 today/);
  assert.match(html, /61 today, limit unknown/);
  assert.match(html, /limit seen in a provider header/);
  assert.match(html, /official limit/);
  assert.match(html, />Exhausted</);
  assert.equal((html.match(/role="meter"/g) ?? []).length, 2, "the unknown limit has no meter");
  assert.match(html, /href="https:\/\/console\.groq\.com\/docs\/rate-limits"/);
  assert.ok(!html.includes("javascript:"), "an unsafe source is dropped");
  assert.match(html, /resets Oct 13, 00:00 UTC/);
  assert.equal(safeSource("http://insecure.example.com"), null);
  assert.equal(safeSource("https://ok.example.com/docs"), "https://ok.example.com/docs");
  assert.equal(safeSource(null), null);
});

const evals: EvalMirror = {
  contract: "1", generated_at: ago(3 * 24 * 60), eval_version: "v1",
  models: {
    "model-b": { "code-generation": { score: 0.5, tasks_run: 2, run_at: ago(3 * 24 * 60), eval_version: "v1" }, research: { score: 0.5, tasks_run: 2, run_at: ago(3 * 24 * 60), eval_version: "v1" } },
    "model-a": {
      "code-generation": { score: 1, tasks_run: 2, run_at: ago(3 * 24 * 60), eval_version: "v1" },
      debugging: { score: 0, tasks_run: 1, run_at: ago(3 * 24 * 60), eval_version: "v1" },
      research: { score: 0.2, tasks_run: 0, run_at: ago(3 * 24 * 60), eval_version: "v1" },
    },
    "model-empty": { research: { score: 0.9, tasks_run: 0, run_at: ago(3 * 24 * 60), eval_version: "v1" } },
  },
};

test("RD1 eval: the cards are sorted by the average, which counts each task, and a category with no task is left out", () => {
  const cards = evalCards(evals);
  assert.deepEqual(cards.map((c) => c.model), ["model-a", "model-b"], "a model with no task run has no card");
  assert.equal(cards[0].tasksRun, 3);
  assert.equal(cards[0].averagePct, 67, "(1*2 + 0*1) / 3");
  assert.deepEqual(cards[0].categories.map((c) => c.label), ["Code generation", "Debugging"], "the 0 task category is not a zero score");
  assert.equal(cards[1].averagePct, 50);
  assert.equal(scoreTone(0.8), "ok");
  assert.equal(scoreTone(0.79), "warn");
  assert.equal(scoreTone(0.5), "warn");
  assert.equal(scoreTone(0.49), "danger");
});

test("RD1 eval: the panel shows a bar for each category, opens the best model, and names the eval version and date", () => {
  const html = renderToStaticMarkup(<EvalScoresPanel evalScores={ready(evals)} now={NOW} />);
  assert.match(html, /67% average/);
  assert.match(html, /Code generation/);
  assert.equal((html.match(/<details[^>]* open=""/g) ?? []).length, 1, "only the first card is open");
  assert.match(html, /Eval v1, run Oct 9, \d\d:\d\d UTC/);
  assert.match(renderToStaticMarkup(<EvalScoresPanel evalScores={ready({ contract: "1", generated_at: ago(1), models: {} })} now={NOW} />), /No eval has run yet/);
});

const hosts: HostsMirror = {
  contract: "1", generated_at: ago(30),
  hosts: {
    hermes_2: { status: "down", last_check: ago(30), uptime_24h: 62.5, uptime_7d: 91.4, uptime_30d: 96.2 },
    render_1: { status: "asleep", last_check: ago(30), uptime_24h: 100, uptime_7d: 100, uptime_30d: null },
    github_actions: { status: "up", last_check: ago(5), uptime_24h: 100, uptime_7d: 99.6, uptime_30d: 99.1, last_pulse_at: ago(8) },
    zeta_host: { status: "up", last_check: ago(5), uptime_24h: null, uptime_7d: null, uptime_30d: null },
  },
};

test("RD1 hosts: the order is fixed, the names are readable, and asleep is not down", () => {
  const rows = hostRows(hosts);
  assert.deepEqual(rows.map((r) => r.name), ["github_actions", "render_1", "hermes_2", "zeta_host"]);
  assert.deepEqual(rows.map((r) => r.label), ["GitHub Actions pulse", "Render 1", "Hermes 2", "zeta host"]);
  assert.equal(rows[1].statusLabel, "Asleep");
  assert.equal(rows[1].tone, "ion");
  assert.equal(rows[2].tone, "danger");
  assert.equal(hostLabel("titan_gev"), "God's Eye View host");
  assert.equal(uptimeTone(99), "ok");
  assert.equal(uptimeTone(98.9), "warn");
  assert.equal(uptimeTone(94.9), "danger");
});

test("RD1 hosts: the panel draws three uptime bars, says no checks yet for a missing window, and shows the last pulse", () => {
  const html = renderToStaticMarkup(<HostStatusPanel hosts={ready(hosts)} now={NOW} />);
  assert.match(html, /62\.5%/);
  assert.match(html, /91\.4%/);
  assert.match(html, /last pulse 8m ago/);
  assert.match(html, /Asleep by design/);
  assert.equal((html.match(/no checks yet/g) ?? []).length, 4, "render_1 has one empty window and zeta_host has three");
  assert.match(html, /aria-label="GitHub Actions pulse uptime over 24 hours"/);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<a [^>]*>/g, "")), "the panel prints no address");
  assert.match(renderToStaticMarkup(<HostStatusPanel hosts={ready({ contract: "1", generated_at: ago(1), hosts: {} })} now={NOW} />), /No host check has run yet/);
});

test("RD1 lessons: the lines are parsed, a bad line is skipped, the most repeated comes first, and the list is capped", () => {
  const line = (over: Record<string, unknown>) => JSON.stringify({ id: "x", signature: "s", first_seen: ago(100), last_seen: ago(10), count: 1, what_failed: "w", likely_cause: "c", suggested_fix: "f", source: "template", ...over });
  const text = [line({ id: "a", count: 1, last_seen: ago(5) }), "not json", "", line({ id: "b", count: 3, last_seen: ago(50) }), JSON.stringify({ id: "c" }), line({ id: "d", count: 3, last_seen: ago(20) })].join("\n");
  assert.deepEqual(parseLessons(text).map((l) => l.id), ["d", "b", "a"], "count first, then the newest");
  assert.equal(parseLessons(Array.from({ length: 30 }, (_, i) => line({ id: `l${i}` })).join("\n")).length, 12);
  assert.deepEqual(parseLessons(""), []);
});

test("RD1 lessons: the panel prints the failure, the cause, and the fix, and says so when there is none", () => {
  const lessons: Lesson[] = [{ id: "l1", signature: "s", first_seen: ago(100), last_seen: ago(10), count: 4, task_type: "code", what_failed: "A task met a 429.", likely_cause: "Two tasks shared one provider.", suggested_fix: "Spread the steps.", source: "template" }];
  const html = renderToStaticMarkup(<LessonsPanel lessons={ready(lessons)} now={NOW} />);
  assert.match(html, /4 times/);
  assert.match(html, /A task met a 429\./);
  assert.match(html, /Likely cause: Two tasks shared one provider\./);
  assert.match(html, /Suggested fix: Spread the steps\./);
  assert.match(renderToStaticMarkup(<LessonsPanel lessons={ready([])} />), /No lessons yet/);
  assert.match(renderToStaticMarkup(<LessonsPanel lessons={{ data: null, loading: false, error: "404" }} />), /No lessons yet/);
});

const log: SigninLog = {
  generatedAt: ago(1),
  summary: { success: 3, failure: 2, blocked: 0, distinctIps: 2 },
  entries: [
    { id: 2, at: ago(5), ip: "203.0.113.10", userAgent: "Browser", route: "login", result: "success", reason: "ok" },
    { id: 1, at: ago(20), ip: "198.51.100.77", userAgent: null, route: "login", result: "failure", reason: "wrong_token" },
  ],
};

test("RD1 security: the headline names the failures first, and a blocked client is red", () => {
  assert.deepEqual(signinHeadline({ success: 2, failure: 0, blocked: 0, distinctIps: 1 }).tone, "ok");
  assert.match(signinHeadline({ success: 2, failure: 0, blocked: 0, distinctIps: 1 }).text, /No wrong token in the last 24 hours\. 2 sign-ins, from 1 address\./);
  assert.equal(signinHeadline({ success: 3, failure: 2, blocked: 0, distinctIps: 2 }).tone, "warn");
  assert.match(signinHeadline({ success: 3, failure: 1, blocked: 0, distinctIps: 2 }).text, /1 wrong token attempt in the last 24 hours/);
  assert.equal(signinHeadline({ success: 0, failure: 5, blocked: 4, distinctIps: 1 }).tone, "danger");
  assert.equal(reasonWords("wrong_token"), "wrong token");
  assert.equal(reasonWords("something_new"), "something new");
});

test("RD1 security: the gitleaks status is never green without a clean run", () => {
  assert.equal(gitleaksStatus(null).tone, "neutral");
  assert.equal(gitleaksStatus({ status: "completed", conclusion: "success", updatedAt: ago(5), url: null }).label, "Clean");
  assert.equal(gitleaksStatus({ status: "completed", conclusion: "success", updatedAt: ago(5), url: null }).tone, "ok");
  assert.equal(gitleaksStatus({ status: "completed", conclusion: "failure", updatedAt: ago(5), url: null }).tone, "danger");
  assert.equal(gitleaksStatus({ status: "in_progress", conclusion: null, updatedAt: ago(1), url: null }).label, "Running");
  assert.equal(gitleaksStatus({ status: "completed", conclusion: "cancelled", updatedAt: ago(1), url: null }).tone, "warn");
  assert.match(gitleaksStatus({ status: "completed", conclusion: "failure", updatedAt: null, url: null }).detail, /do not rewrite history/);
});

test("RD1 security: the view shows the scan, the headline, and the table with the address, and it is honest when the log failed", () => {
  const html = renderToStaticMarkup(<SecurityView log={log} run={{ status: "completed", conclusion: "success", updatedAt: ago(30), url: "https://github.com/o/r/actions/runs/1" }} error={null} loading={false} now={NOW} />);
  assert.match(html, /Secret scan: Clean/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/actions\/runs\/1"/);
  assert.match(html, /2 wrong token attempts in the last 24 hours\. 3 sign-ins worked, from 2 addresses in all\./);
  assert.match(html, /30m ago/);
  assert.match(html, /203\.0\.113\.10/);
  assert.match(html, /Signed in/);
  assert.match(html, /Wrong token/);
  assert.match(html, /<caption class="sr-only">The latest sign-in attempts<\/caption>/);
  const failed = renderToStaticMarkup(<SecurityView log={null} run={null} error="Unauthorized" loading={false} />);
  assert.match(failed, /Could not load the sign-in log \(Unauthorized\)/);
  assert.match(failed, /Secret scan: No run yet/);
  assert.match(renderToStaticMarkup(<SecurityView log={{ ...log, entries: [] }} run={null} error={null} loading={false} />), /No sign-in is logged yet/);
});

test("RD1 tabs: the Ops tab is in the list and marks the current page", () => {
  const html = renderToStaticMarkup(<TopTabs active="ops" />);
  assert.match(html, /<a class="top-tab" aria-current="page" href="\/ops">Ops<\/a>|<a [^>]*href="\/ops"[^>]*aria-current="page"[^>]*>Ops<\/a>|<a [^>]*aria-current="page"[^>]*href="\/ops"[^>]*>Ops<\/a>/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test("RD1 demo: every panel renders from its demo mirror, and the demo holds no real address", () => {
  const demo = (name: string) => getDemoStateFile(`state/${name}`);
  assert.ok(healthRows(demo("ops/health.json") as HealthMirror).length >= 3);
  assert.ok(opsQuotaRows(demo("ops/quota.json") as QuotaMirror).some((r) => r.exhausted));
  assert.ok(evalCards(demo("ops/eval.json") as EvalMirror).length >= 2);
  assert.ok(hostRows(demo("ops/hosts.json") as HostsMirror).some((r) => r.status === "asleep"));
  assert.ok((demo("lessons.jsonl") as Lesson[]).length >= 2);
  const text = JSON.stringify(["ops/health.json", "ops/quota.json", "ops/eval.json", "ops/hosts.json", "lessons.jsonl"].map(demo));
  for (const m of text.matchAll(/https?:\/\/[^"\s]+/g)) assert.match(m[0], /^https:\/\/(console\.groq\.com|openrouter\.ai)\//, m[0]);
  assert.ok(utcStamp("2026-10-12T00:00:00Z").endsWith("00:00 UTC"));
  assert.equal(utcStamp(null), "unknown");
});
