// RT5 on the dashboard side: sign in with the admin token, keep only the session, and say what went wrong in words.
process.env.NEXT_PUBLIC_TITAN_WORKER_URL = "https://worker.example.com";

import test from "node:test";
import assert from "node:assert/strict";
import type { LoginError as LoginErrorType } from "../lib/sessionApi";

// The Worker address is read when the module loads, so the module loads after the variable above is set.
const load = () => import("../lib/sessionApi");

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => async () => new Response(JSON.stringify(body), { status, headers });

test("waitWords rounds up and names the unit", async () => {
  const { LoginError, login, logout, unlock, waitWords } = await load();
  assert.equal(waitWords(null), "Try again later.");
  assert.equal(waitWords(0), "Try again later.");
  assert.equal(waitWords(45), "Try again in 45 seconds.");
  assert.equal(waitWords(61), "Try again in 61 seconds.");
  assert.equal(waitWords(120), "Try again in 2 minutes.");
  assert.equal(waitWords(14 * 60 + 1), "Try again in 15 minutes.");
  assert.equal(waitWords(3 * 3600), "Try again in 3 hours.");
});

test("login: a good token gives a session, and the request is a POST with the token in the body only", async () => {
  const { LoginError, login, logout, unlock, waitWords } = await load();
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ session: "sess_0123456789abcdef", expires_at: "2026-10-12T20:00:00Z", idle_timeout_seconds: 1800, absolute_timeout_seconds: 28800 }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await login("admin-fixture-token", fetchImpl);
  assert.deepEqual(out, { kind: "session", token: "sess_0123456789abcdef", expiresAt: "2026-10-12T20:00:00Z", idleSeconds: 1800, absoluteSeconds: 28800 });
  assert.equal(seen!.url, "https://worker.example.com/auth/login");
  assert.equal(seen!.init.method, "POST");
  assert.equal(JSON.stringify(seen!.init.headers).includes("admin-fixture-token"), false, "the token is not in a header");
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { token: "admin-fixture-token" });
});

test("login: a wrong token, a lockout, a missing admin token, and a network error each say what happened", async () => {
  const { LoginError, login, logout, unlock, waitWords } = await load();
  await assert.rejects(login("x", reply(401, { error: "unauthorized" }) as unknown as typeof fetch), (e: Error) => e instanceof LoginError && e.status === 401 && /rejected/.test(e.message));
  await assert.rejects(login("x", reply(429, { error: "locked_out", retryAfterSeconds: 900 }, { "Retry-After": "900" }) as unknown as typeof fetch), (e: LoginErrorType) => e.status === 429 && e.retryAfterSeconds === 900 && /Too many wrong tokens\. Try again in 15 minutes\./.test(e.message));
  await assert.rejects(login("x", reply(503, { error: "admin_token_not_set" }) as unknown as typeof fetch), /no admin token yet/);
  await assert.rejects(login("x", reply(500, {}) as unknown as typeof fetch), /answered 500/);
  await assert.rejects(login("x", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch), /Could not reach the Worker/);
  await assert.rejects(login("x", reply(200, { nothing: true }) as unknown as typeof fetch), /shape that this page does not know/);
  await assert.rejects(login("x", reply(200, { session: "short" }) as unknown as typeof fetch), LoginError);
});

test("login: an older Worker without /auth/login answers 404, and the token is used as it is", async () => {
  const { LoginError, login, logout, unlock, waitWords } = await load();
  assert.deepEqual(await login("x", reply(404, {}) as unknown as typeof fetch), { kind: "token" });
  assert.deepEqual(await login("x", reply(405, {}) as unknown as typeof fetch), { kind: "token" });
});

test("unlock: a session replaces the typed token, an empty entry is refused, and a wrong token stops the person", async () => {
  const { LoginError, login, logout, unlock, waitWords } = await load();
  const session = reply(200, { session: "sess_0123456789abcdef" }) as unknown as typeof fetch;
  assert.deepEqual(await unlock("  typed-token  ", { fetchImpl: session }), { ok: true, token: "sess_0123456789abcdef", kind: "session" });
  assert.deepEqual(await unlock("   "), { ok: false, error: "Type the admin token first." });
  assert.deepEqual(await unlock("bad", { fetchImpl: reply(401, {}) as unknown as typeof fetch }), { ok: false, error: "That token was rejected by the Worker." });
  const locked = await unlock("bad", { fetchImpl: reply(429, {}, { "Retry-After": "60" }) as unknown as typeof fetch });
  assert.equal(locked.ok, false);
  assert.match((locked as { error: string }).error, /Too many wrong tokens/);
});

test("unlock: on an older Worker the token is checked with one read, a 401 stops, and another error does not lock the person out", async () => {
  const { LoginError, login, logout, unlock, waitWords } = await load();
  const old = reply(404, {}) as unknown as typeof fetch;
  assert.deepEqual(await unlock("tok", { fetchImpl: old, verifyToken: async () => ({}) }), { ok: true, token: "tok", kind: "token" });
  assert.deepEqual(await unlock("tok", { fetchImpl: old, verifyToken: async () => { throw Object.assign(new Error("no"), { status: 401 }); } }), { ok: false, error: "That token was rejected by the Worker." });
  assert.deepEqual(await unlock("tok", { fetchImpl: old, verifyToken: async () => { throw Object.assign(new Error("cold start"), { status: 503 }); } }), { ok: true, token: "tok", kind: "token" });
});

test("logout: it posts the session as the auth header, and it never throws", async () => {
  const { LoginError, login, logout, unlock, waitWords } = await load();
  let seen: { url: string; init: RequestInit } | null = null;
  await logout("sess_0123456789abcdef", (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("{}"); }) as unknown as typeof fetch);
  assert.equal(seen!.url, "https://worker.example.com/auth/logout");
  assert.equal((seen!.init.headers as Record<string, string>)["X-Titan-Auth"], "sess_0123456789abcdef");
  await logout("sess_0123456789abcdef", (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
  let called = false;
  await logout("demo-token", (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch);
  assert.equal(called, false, "the demo session is not sent anywhere");
});
