// Covers lib/csp.ts and lib/theme.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRunnerCsp } from "../lib/csp";
import { THEMES, normalizeTheme } from "../lib/theme";

const dir = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

test("the policy names the hosts the dashboard talks to and nothing broader", () => {
  const csp = buildRunnerCsp({ worker: "https://brain.example.workers.dev/path?x=1", gevOrigin: "https://gev.example.com" });
  assert.equal(dir(csp, "connect-src"), "connect-src 'self' https://raw.githubusercontent.com https://api.github.com https://api.open-meteo.com https://brain.example.workers.dev");
  assert.equal(dir(csp, "frame-src"), "frame-src https://gev.example.com");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /\*/);
  assert.doesNotMatch(csp, /script-src[^;]*(?:https?:|unsafe-eval)/);
});

test("with no Worker and no God's Eye host the policy shrinks, and frames are blocked", () => {
  const csp = buildRunnerCsp({ worker: "", gevOrigin: null });
  assert.equal(dir(csp, "connect-src"), "connect-src 'self' https://raw.githubusercontent.com https://api.github.com https://api.open-meteo.com");
  assert.equal(dir(csp, "frame-src"), "frame-src 'none'");
});

test("a Worker address that is not https, or carries a password, is dropped, but loopback http is kept for local work", () => {
  assert.doesNotMatch(buildRunnerCsp({ worker: "http://evil.example", gevOrigin: null }), /evil\.example/);
  assert.doesNotMatch(buildRunnerCsp({ worker: ["https://", "user:", "pw", "@evil.example"].join(""), gevOrigin: null }), /evil\.example/);
  assert.doesNotMatch(buildRunnerCsp({ worker: "not a url", gevOrigin: null }), /not a url/);
  assert.match(buildRunnerCsp({ worker: "http://localhost:8787", gevOrigin: null }), /http:\/\/localhost:8787/);
});

test("a policy cannot be broken out of by a hostile Worker address", () => {
  const csp = buildRunnerCsp({ worker: "https://ok.example; script-src *", gevOrigin: null });
  assert.equal(csp.split("; ").filter((d) => d.startsWith("script-src ")).length, 1);
});

test("an unknown theme falls back to eclipse", () => {
  for (const t of THEMES) assert.equal(normalizeTheme(t), t);
  assert.equal(normalizeTheme("neon"), "eclipse");
  assert.equal(normalizeTheme(null), "eclipse");
  assert.equal(normalizeTheme(7), "eclipse");
});
