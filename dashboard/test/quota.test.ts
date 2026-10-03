// Covers lib/quota.ts and lib/pulseView.ts: what the quota and last-pulse panels show.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, quotaRows, type QuotaState } from "../lib/quota";
import { pulseView } from "../lib/pulseView";
import type { HeartbeatState, PulseHistoryEntry } from "../lib/types";

const NOON = Date.parse("2026-10-03T12:00:30.000Z");
const state = (over: Partial<QuotaState["providers"]> = {}): QuotaState => ({
  version: 1,
  reserveFraction: 0.15,
  providers: {
    gemini: { minute: { start: "2026-10-03T12:00:00.000Z", count: 3 }, day: { start: "2026-10-03T00:00:00.000Z", count: 300 }, tokens: 4200, last429At: null },
    ...over,
  },
});

test("every provider with a ceiling gets a row, counted or not", () => {
  const rows = quotaRows(state(), NOON);
  assert.deepEqual(rows.map((r) => r.id).sort(), Object.keys(DEFAULT_LIMITS).sort());
  const gemini = rows.find((r) => r.id === "gemini")!;
  assert.equal(gemini.dayUsed, 300);
  assert.equal(gemini.dayLimit, 1200);
  assert.equal(gemini.dayPct, 25);
  assert.equal(gemini.reserve, 180);
  assert.equal(gemini.minuteUsed, 3);
  assert.equal(gemini.tokens, 4200);
  assert.equal(gemini.noRecord, false);
  const groq = rows.find((r) => r.id === "groq")!;
  assert.equal(groq.noRecord, true);
  assert.equal(groq.dayUsed, 0);
});

test("a count from an earlier UTC day is not shown as today's use", () => {
  const rows = quotaRows(state({ groq: { minute: { start: "2026-10-02T23:59:00.000Z", count: 9 }, day: { start: "2026-10-02T00:00:00.000Z", count: 11_000 }, tokens: 9, last429At: null } }), NOON);
  const groq = rows.find((r) => r.id === "groq")!;
  assert.equal(groq.dayUsed, 0);
  assert.equal(groq.minuteUsed, 0);
  assert.equal(groq.staleDay, true);
  assert.equal(groq.countedDay, "2026-10-02");
  assert.equal(groq.tokens, 0);
});

test("the percent never passes 100 and bad numbers count as zero", () => {
  const rows = quotaRows(state({ openrouter: { minute: { start: "x", count: Number.NaN }, day: { start: "2026-10-03T00:00:00.000Z", count: 900 }, tokens: -5, last429At: "2026-10-03T11:00:00.000Z" } }), NOON);
  const or = rows.find((r) => r.id === "openrouter")!;
  assert.equal(or.dayPct, 100);
  assert.equal(or.minuteUsed, 0);
  assert.equal(or.tokens, 0);
  assert.equal(or.last429At, "2026-10-03T11:00:00.000Z");
});

test("a provider the ledger knows but has no default for still gets a row with the fallback ceiling", () => {
  const rows = quotaRows(state({ newcomer: { minute: { start: "2026-10-03T12:00:00.000Z", count: 1 }, day: { start: "2026-10-03T00:00:00.000Z", count: 10 }, tokens: 0, last429At: null } }), NOON);
  const n = rows.find((r) => r.id === "newcomer")!;
  assert.equal(n.dayLimit, 500);
});

test("a missing ledger or an out of range reserve falls back to the default", () => {
  assert.equal(quotaRows(null, NOON).find((r) => r.id === "groq")!.reserve, 1800);
  assert.equal(quotaRows({ reserveFraction: 7 }, NOON).find((r) => r.id === "groq")!.reserve, 1800);
});

const SHARP = Date.parse("2026-10-03T12:00:00.000Z");
const hb = (over: Partial<HeartbeatState> = {}): HeartbeatState => ({
  version: 2,
  lastPulseAt: "2026-10-03T11:55:00.000Z",
  lastPulseStatus: "ok",
  lastPulseDurationMs: 4200,
  lastPulseTasksClaimed: 2,
  lastPulseTasksCompleted: 1,
  lastPulseTasksFailed: 1,
  lastPulseError: null,
  consecutivePulseFailures: 0,
  totalPulses: 99,
  cadenceMinutes: 15,
  ...over,
});
const hist = (n: number, status: "ok" | "error" = "ok"): PulseHistoryEntry[] =>
  Array.from({ length: n }, (_, i) => ({ at: new Date(SHARP - (n - i) * 900_000).toISOString(), durationMs: 1000 + i, status: i === 0 ? status : "ok", tasksClaimed: 0, tasksCompleted: 0, tasksFailed: 0 }));

test("an on-time pulse shows its next due time and its facts", () => {
  const v = pulseView(hb({ pulseId: "abc", modelCalls: 3, budget: { budgetMs: 100_000, elapsedMs: 25_000, remainingMs: 75_000, draining: false } }), hist(5), SHARP);
  assert.equal(v.state, "ok");
  assert.equal(v.ageMinutes, 5);
  assert.equal(v.nextDueAt, "2026-10-03T12:10:00.000Z");
  assert.equal(v.minutesLate, 0);
  assert.equal(v.budgetUsedPct, 25);
  assert.equal(v.modelCalls, 3);
  assert.equal(v.recentDurations.length, 5);
});

test("a pulse more than one cadence overdue is late, and a failed one says so", () => {
  const late = pulseView(hb({ lastPulseAt: "2026-10-03T11:00:00.000Z" }), [], SHARP);
  assert.equal(late.state, "late");
  assert.equal(late.minutesLate, 45);
  assert.equal(pulseView(hb({ lastPulseStatus: "error", lastPulseError: "boom" }), [], SHARP).state, "error");
});

test("no heartbeat means never, with no invented numbers", () => {
  const v = pulseView(null, undefined, SHARP);
  assert.equal(v.state, "never");
  assert.equal(v.lastAt, null);
  assert.equal(v.nextDueAt, null);
  assert.equal(v.budgetUsedPct, null);
  assert.equal(v.modelCalls, null);
  assert.equal(v.window, 0);
  assert.equal(pulseView(hb({ lastPulseAt: "garbage" }), [], SHARP).state, "never");
});

test("the sparkline window keeps the latest pulses and counts the failed ones", () => {
  const v = pulseView(hb(), hist(60, "error"), SHARP, 40);
  assert.equal(v.window, 40);
  assert.equal(v.recentDurations.length, 40);
  assert.equal(v.recentErrors, 0, "the failed pulse is older than the window");
  assert.equal(pulseView(hb(), hist(10, "error"), SHARP, 40).recentErrors, 1);
});
