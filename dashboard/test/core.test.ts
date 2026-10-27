// Covers lib/core.ts: the greeting, the core state, the co-processor roles, and the deck tabs.
import test from "node:test";
import assert from "node:assert/strict";
import { coprocessorRole, coreHour, coreState, engineSummary, greetingFor, parseDeckTab, providerCounts, queuedCount, taskSummary } from "../lib/core";
import type { ProviderHealthRecord, TaskRecord } from "../lib/types";

const rec = (id: string, status: ProviderHealthRecord["status"]) => ({ id, status }) as ProviderHealthRecord;
const task = (status: string) => ({ status }) as TaskRecord;

test("the greeting follows the hour", () => {
  assert.equal(greetingFor(8), "Good morning");
  assert.equal(greetingFor(12), "Good afternoon");
  assert.equal(greetingFor(17), "Good afternoon");
  assert.equal(greetingFor(18), "Good evening");
  assert.equal(greetingFor(2), "Good evening");
  assert.equal(greetingFor(Number.NaN), "Hello");
});

test("the hour uses Central time", () => {
  assert.equal(coreHour(new Date("2026-10-27T22:00:00Z")), 17);
  assert.equal(coreHour(new Date("2026-01-15T06:30:00Z")), 0);
});

test("the task summary counts queued and running tasks", () => {
  assert.equal(taskSummary([]), "No tasks are waiting.");
  assert.equal(taskSummary([task("pending"), task("waiting"), task("running"), task("complete")]), "2 tasks queued, 1 running.");
  assert.equal(taskSummary([task("pending")]), "1 task queued.");
  assert.equal(queuedCount([task("pending"), task("failed")]), 1);
});

test("the core is online until a signal says otherwise", () => {
  assert.equal(coreState({ streaming: false, pulseAgeMinutes: null, providers: undefined }), "online");
  assert.equal(coreState({ streaming: false, pulseAgeMinutes: 10, providers: { groq: rec("groq", "ok") } }), "online");
});

test("a reply in flight makes the core think", () => {
  assert.equal(coreState({ streaming: true, pulseAgeMinutes: 500, providers: undefined }), "thinking");
});

test("a late pulse or a limited provider degrades the core", () => {
  assert.equal(coreState({ streaming: false, pulseAgeMinutes: 227, providers: { groq: rec("groq", "ok") } }), "degraded");
  assert.equal(coreState({ streaming: false, pulseAgeMinutes: 5, providers: { groq: rec("groq", "ok"), gemini: rec("gemini", "rate_limited") } }), "degraded");
});

test("a late pulse and no working provider take the core offline", () => {
  assert.equal(coreState({ streaming: false, pulseAgeMinutes: 227, providers: { groq: rec("groq", "error") } }), "offline");
});

test("the provider counts and the engine summary use the health records", () => {
  const providers = { groq: rec("groq", "ok"), gemini: rec("gemini", "ok"), together: rec("together", "ok"), x: rec("x", "error"), y: rec("y", "rate_limited") };
  assert.deepEqual(providerCounts(providers), { online: 3, degraded: 1, failed: 1 });
  assert.equal(engineSummary(providers), "Groq/Gemini +1");
  assert.equal(engineSummary({}), "No engine checked yet");
});

test("each co-processor has a role", () => {
  assert.equal(coprocessorRole("gemini").role, "Reasoning Engine");
  assert.equal(coprocessorRole("groq").role, "Latency Engine");
  assert.equal(coprocessorRole("hermes_2").role, "Agent Engine");
  assert.equal(coprocessorRole("custom_1").role, "Custom Engine");
  assert.equal(coprocessorRole("unknown").role, "General Engine");
});

test("the deck tab parser accepts only known tabs", () => {
  assert.equal(parseDeckTab("brief"), "brief");
  assert.equal(parseDeckTab("nope"), null);
  assert.equal(parseDeckTab(null), null);
});
