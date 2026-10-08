// Track K, the dashboard side (K7): the words and colors of a key, the steps of the add flow, the table markup, and the
// rules that keep a key out of the page. The Worker side is covered by worker/test/keys.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import AddKeyModal from "../components/AddKeyModal";
import KeysTable from "../components/KeysTable";
import { POLL_INTERVAL_MS, POLL_LIMIT_MS, nextPollAction, phaseMessage, proofOutcome, stepsFor, type FlowPhase } from "../lib/addKeyFlow";
import { bannerState } from "../lib/keeperBanner";
import { STATE_META, describeCheck, describeProof, formatProblem, hintWarning, keyColumn, noCardProviders, savedColumn } from "../lib/keyState";
import type { KeyRow } from "../lib/keysApi";
import { PROVIDER_CATALOG, pulseProviderIds } from "../lib/providers";
import { pulseGapStats } from "../lib/pulseView";
import { buildRunnerCsp } from "../lib/csp";

const FAKE_KEY = ["gsk", "x".repeat(8), "FAKE", "y".repeat(24)].join("_");

function row(over: Partial<KeyRow> = {}): KeyRow {
  const base = PROVIDER_CATALOG[0];
  return {
    id: base.id,
    label: base.label,
    verifiable: true,
    unverifiableReason: null,
    usedBy: base.usedBy,
    note: null,
    inputs: {},
    keyHint: base.keyHint.text,
    getKeyUrl: base.getKeyUrl,
    noCard: true,
    freeTierNote: base.freeTierNote,
    canChat: true,
    secretName: base.secrets.key,
    secretPresent: true,
    secretUpdatedAt: new Date().toISOString(),
    savedVia: "dashboard",
    replacedOutside: false,
    savedAt: new Date().toISOString(),
    fingerprint: "abc123abc123",
    last4: "wxyz",
    alsoForChat: false,
    providerCheck: { result: "ok", httpStatus: 200, httpClass: "2xx", latencyMs: 312, at: new Date().toISOString(), detail: null },
    runnerProof: null,
    pulseView: null,
    state: "provider_ok",
    stateReason: "The provider accepted this key. No runner has used it yet.",
    ...over,
  };
}

test("labels tell the truth: every state has a word, and saved but not checked says so", () => {
  assert.equal(STATE_META.saved_unverified.label, "Saved, not verified");
  for (const state of Object.keys(STATE_META) as Array<keyof typeof STATE_META>) assert.ok(STATE_META[state].label.length > 3, state);
  assert.equal(STATE_META.proven.tone, "ok");
  assert.notEqual(STATE_META.saved_unverified.tone, "ok", "never green for a state nobody checked");
  assert.notEqual(STATE_META.provider_ok.tone, "ok");
});

test("the key column shows the last four characters only for a dashboard key, and never invents one for an outside key", () => {
  assert.equal(keyColumn(row()), "••••wxyz");
  assert.equal(keyColumn(row({ savedVia: "outside", last4: null })), "set outside");
  assert.equal(keyColumn(row({ replacedOutside: true, savedVia: "outside", last4: null })), "changed outside");
  assert.equal(keyColumn(row({ secretPresent: false })), "none");
  assert.equal(keyColumn(row({ secretPresent: null })), "unknown");
  assert.match(savedColumn(row({ savedVia: "outside" })), /outside the dashboard/);
});

test("describe the provider check and the runner proof in plain words", () => {
  assert.match(describeCheck(row().providerCheck), /Accepted · HTTP 200 · 312 ms/);
  assert.equal(describeCheck(null), "not checked");
  assert.equal(describeProof(null), "none yet");
  const proof = { result: "ok" as const, source: "pulse" as const, model: "gemini-2.5-flash", latencyMs: 900, at: new Date().toISOString(), detail: null };
  assert.match(describeProof(proof), /Passed \(pulse\) · gemini-2\.5-flash · 900 ms/);
  assert.match(describeProof({ ...proof, result: "failed", source: "runner" }), /Failed \(runner\)/);
});

test("the soft hint warns on a wrong prefix and stays quiet on a right one and on a provider with no hint", () => {
  assert.match(hintWarning("groq", "sk-abc") ?? "", /gsk_/);
  assert.equal(hintWarning("groq", FAKE_KEY), null);
  assert.equal(hintWarning("custom_1", "anything"), null);
  assert.equal(hintWarning("groq", ""), null);
  assert.equal(formatProblem("two words"), "A key is one token with no spaces. Check what you pasted.");
  assert.equal(formatProblem(FAKE_KEY), null);
  assert.match(formatProblem("x".repeat(1025)) ?? "", /too long/);
});

test("the guide for a first key lists only free providers that need no card", () => {
  const rows = PROVIDER_CATALOG.map((p) => row({ id: p.id, label: p.label, noCard: p.noCard, getKeyUrl: p.getKeyUrl }));
  const ids = noCardProviders(rows).map((r) => r.id);
  assert.deepEqual(ids, ["groq", "openrouter", "gemini"]);
  assert.ok(!ids.includes("together") && !ids.includes("huggingface"), "Together and Hugging Face need a purchase");
});

test("the add flow: the steps for each phase", () => {
  const status = (phase: FlowPhase) => Object.fromEntries(stepsFor(phase).map((s) => [s.id, s.status]));
  assert.deepEqual(status({ name: "sending" }), { format: "done", provider: "active", seal: "pending", github: "pending", runner: "pending" });
  assert.deepEqual(status({ name: "rejected", reason: "x" }), { format: "done", provider: "failed", seal: "skipped", github: "skipped", runner: "skipped" });
  assert.deepEqual(status({ name: "saved", verified: true }), { format: "done", provider: "done", seal: "done", github: "done", runner: "active" });
  assert.equal(status({ name: "saved", verified: false }).provider, "skipped");
  assert.deepEqual(status({ name: "proven" }), { format: "done", provider: "done", seal: "done", github: "done", runner: "done" });
  assert.equal(status({ name: "proof_failed", reason: "x" }).runner, "failed");
  assert.equal(status({ name: "failed", message: "x", permission: null }).github, "failed");
  assert.match(phaseMessage({ name: "confirm", reason: "It answered 429." }), /did not answer.*Save anyway\?/);
  assert.match(phaseMessage({ name: "rejected", reason: "It answered 401." }), /rejected this key/);
  assert.match(phaseMessage({ name: "proof_timeout" }), /longer than 3 minutes/);
});

test("the add flow: poll every 5 seconds for up to 3 minutes, and only a fresh proof counts", () => {
  assert.equal(POLL_INTERVAL_MS, 5000);
  assert.equal(POLL_LIMIT_MS, 180_000);
  assert.equal(nextPollAction(60_000), "poll");
  assert.equal(nextPollAction(180_000), "timeout");
  const now = Date.now();
  const proof = (at: number, result: "ok" | "failed") => row({ runnerProof: { result, source: "runner", model: "m", latencyMs: 1, at: new Date(at).toISOString(), detail: "rejected the request (401)" } });
  assert.equal(proofOutcome(proof(now + 1000, "ok"), now).outcome, "proven");
  assert.equal(proofOutcome(proof(now + 1000, "failed"), now).outcome, "failed");
  assert.equal(proofOutcome(proof(now - 3_600_000, "ok"), now).outcome, "pending", "an old proof is not this flow's proof");
  assert.equal(proofOutcome(row({ state: "invalid" }), now).outcome, "failed");
  assert.equal(proofOutcome(undefined, now).outcome, "pending");
});

test("the table shows each provider with its state word, and holds no key value", () => {
  const html = renderToStaticMarkup(
    <KeysTable
      rows={[row({ state: "saved_unverified", stateReason: "Saved, not verified." }), row({ id: "gemini", label: "Google Gemini", state: "proven", savedVia: "outside", last4: null })]}
      onAdd={() => {}}
      onTest={() => {}}
      onRemove={() => {}}
    />,
  );
  assert.match(html, /<caption class="sr-only">Provider keys and their state<\/caption>/);
  assert.match(html, /Saved, not verified/);
  assert.match(html, /Proven/);
  assert.match(html, /••••wxyz/);
  assert.match(html, /set outside/);
  assert.match(html, /data-label="Runner proof"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
  assert.equal((html.match(/Get a free key/g) ?? []).length, 2);
  assert.ok(!html.includes(FAKE_KEY));
});

test("the add key window: a password field with no value, a Show button, the soft hint, and a link that opens safely", () => {
  const html = renderToStaticMarkup(<AddKeyModal token="t" rows={[]} initialProvider="groq" vaultReady={false} onClose={() => {}} onChanged={() => {}} onUnauthorized={() => {}} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /<input id="add-key-value" type="password"/);
  assert.match(html, /autoComplete="off"/);
  assert.ok(!/id="add-key-value"[^>]*value="[^"]/.test(html), "the key field starts empty");
  assert.match(html, />Show</);
  assert.match(html, /Save and verify/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /The vault is not ready/);
  assert.match(html, /disabled=""/, "the chat box is off when the vault is not ready");
  assert.ok(!html.includes("Remember on this device"), "the remember option never applies to a provider key");
});

test("a custom provider asks for a label, a base URL, and a model", () => {
  const html = renderToStaticMarkup(<AddKeyModal token="t" rows={[]} initialProvider="custom_1" vaultReady onClose={() => {}} onChanged={() => {}} onUnauthorized={() => {}} />);
  assert.match(html, /id="add-key-label"/);
  assert.match(html, /id="add-key-baseUrl"/);
  assert.match(html, /id="add-key-model"/);
  assert.match(html, /must use https and a public host/);
});

test("no source file keeps a provider key in the URL, localStorage, sessionStorage, or a log", () => {
  const files = ["components/AddKeyModal.tsx", "components/RemoveKeyModal.tsx", "components/KeysPage.tsx", "components/KeysTable.tsx", "lib/keysApi.ts", "lib/addKeyFlow.ts", "lib/keyState.ts"];
  for (const f of files) {
    const text = readFileSync(join(__dirname, "..", f), "utf8");
    assert.ok(!/localStorage|sessionStorage/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f} must not store anything in the browser`);
    assert.ok(!/console\.(log|info|warn|error)\(/.test(text), `${f} must not log`);
    assert.ok(!/location\.(search|hash)|searchParams\.set\(["']value/.test(text), `${f} must not put a value in the URL`);
  }
});

test("the pulse banner warns only when the keeper fails too", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const keeper = (over = {}) => ({ lastHeartbeatAt: null, heartbeatAgeMinutes: null, lastDispatchAt: new Date(now - 5 * 60_000).toISOString(), keeperError: null, keeperHealthy: true, ...over });
  assert.equal(bannerState(20, keeper(), now).kind, "none");
  assert.equal(bannerState(null, keeper(), now).kind, "none");
  assert.equal(bannerState(120, keeper(), now).kind, "info", "the keeper started a pulse five minutes ago");
  assert.match(bannerState(120, keeper(), now).text, /keeper started a pulse 5 minutes ago/);
  assert.equal(bannerState(120, keeper({ keeperHealthy: false, keeperError: "dispatch failed" }), now).kind, "alert");
  assert.equal(bannerState(120, keeper({ lastDispatchAt: new Date(now - 90 * 60_000).toISOString() }), now).kind, "alert");
  assert.equal(bannerState(120, keeper({ lastDispatchAt: null }), now).kind, "alert");
  assert.equal(bannerState(120, null, now).kind, "alert", "without the Worker the old warning stays");
});

test("pulse gaps: the median and the 90th percentile of the last 24 hours", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const at = (m: number) => ({ at: new Date(now - m * 60_000).toISOString(), durationMs: 1, status: "ok" }) as never;
  const stats = pulseGapStats([at(300), at(285), at(270), at(240), at(120), at(0)], now);
  assert.equal(stats.count, 5);
  assert.equal(stats.medianMinutes, 30);
  assert.equal(stats.p90Minutes, 120);
  assert.equal(stats.maxMinutes, 120);
  assert.deepEqual(pulseGapStats([at(10)], now), { count: 0, medianMinutes: null, p90Minutes: null, maxMinutes: null });
  assert.equal(pulseGapStats([at(3000), at(2900)], now).count, 0, "older than 24 hours is ignored");
});

test("the provider ids on the home page come from the catalog, and a custom slot shows only after it has a record", () => {
  assert.ok(pulseProviderIds({}).includes("groq"));
  assert.ok(!pulseProviderIds({}).includes("custom_1"));
  assert.ok(pulseProviderIds({ custom_1: {} }).includes("custom_1"));
});

test("W12-D10: the page policy gains no new host, and no file calls a host that is not already allowed", () => {
  const csp = buildRunnerCsp({ worker: "https://titan-runner-brain.titan-runner.workers.dev", gevOrigin: "https://titan-gev.onrender.com" });
  const connect = csp.split("; ").find((d) => d.startsWith("connect-src"))!.split(" ").slice(1);
  assert.deepEqual(connect.sort(), ["'self'", "https://api.github.com", "https://api.open-meteo.com", "https://raw.githubusercontent.com", "https://titan-gev.onrender.com", "https://titan-runner-brain.titan-runner.workers.dev"].sort());
  const allowed = ["api.github.com", "raw.githubusercontent.com", "api.open-meteo.com", "github.com", "shreyas-tech7.github.io", "geocoding-api.open-meteo.com"];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (n === "node_modules" || n === ".next" || n === "out" ? [] : statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const root = join(__dirname, "..");
  for (const file of [...walk(join(root, "lib")), ...walk(join(root, "components")), ...walk(join(root, "app"))].filter((f) => /\.(ts|tsx)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/fetch\(\s*[`"']https:\/\/([a-z0-9.-]+)/g)) {
      assert.ok(allowed.includes(m[1]), `${file} calls ${m[1]}, which is not on the connect-src list`);
    }
  }
});
