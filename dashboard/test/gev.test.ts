// Covers lib/gev.ts: the host URL rules, the CSP, token minting through the
// Worker client, the health check, the full screen opener, and the controller
// that drives the empty, waking, and ready states. The controller runs against
// a fake scheduler, so the automatic retry is tested without waiting.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GevController,
  buildGevSrc,
  checkGevHealth,
  gevFrameSrcPolicy,
  openGevFullScreen,
  parseGevMessage,
  parseGevUrl,
  retryDelayMs,
  toMintResult,
  type GevState,
  type HealthResult,
  type MintResult,
} from "../lib/gev";

const ORIGIN = "https://titan-gev.onrender.com";

// ---------------------------------------------------------------------
// The host URL and the CSP
// ---------------------------------------------------------------------

test("parseGevUrl accepts an https origin and drops everything after it", () => {
  assert.deepEqual(parseGevUrl(ORIGIN), { ok: true, origin: ORIGIN });
  assert.deepEqual(parseGevUrl(`  ${ORIGIN}/some/path?x=1#y  `), { ok: true, origin: ORIGIN });
  assert.deepEqual(parseGevUrl("http://localhost:7860/"), { ok: true, origin: "http://localhost:7860" });
});

test("parseGevUrl reports unset and invalid separately and refuses unsafe URLs", () => {
  for (const raw of [undefined, "", "   "]) assert.deepEqual(parseGevUrl(raw), { ok: false, reason: "unset" });
  // Built in pieces so the fake credentials do not look like an email address to the secret scanner.
  const withCredentials = ["https://", "name", ":", "word", "@", "x.example"].join("");
  for (const raw of ["not a url", "http://example.com", "ftp://x.example", withCredentials, "javascript:alert(1)"]) {
    assert.deepEqual(parseGevUrl(raw), { ok: false, reason: "invalid" }, raw);
  }
});

test("the CSP allows framing the host origin only and sets no other directive", () => {
  assert.equal(gevFrameSrcPolicy(parseGevUrl(ORIGIN)), `frame-src ${ORIGIN}`);
  assert.equal(gevFrameSrcPolicy(parseGevUrl("")), null);
  const policy = gevFrameSrcPolicy(parseGevUrl(ORIGIN)) ?? "";
  assert.equal(policy.includes("*"), false);
  assert.equal(policy.includes("'self'"), false);
  assert.equal(policy.includes(";"), false);
});

test("buildGevSrc puts the token in the query and encodes it", () => {
  assert.equal(buildGevSrc(ORIGIN, "gev1.1.2.abc.sig"), `${ORIGIN}/?gev_token=gev1.1.2.abc.sig`);
  assert.equal(buildGevSrc(ORIGIN, "a b&c"), `${ORIGIN}/?gev_token=a%20b%26c`);
});

test("parseGevMessage trusts only the host origin and known message types", () => {
  assert.equal(parseGevMessage({ origin: ORIGIN, data: { type: "gev-session-blocked" } }, ORIGIN), "session-blocked");
  assert.equal(parseGevMessage({ origin: ORIGIN, data: { type: "gev-unauthorized" } }, ORIGIN), "unauthorized");
  assert.equal(parseGevMessage({ origin: "https://evil.example", data: { type: "gev-unauthorized" } }, ORIGIN), null);
  assert.equal(parseGevMessage({ origin: ORIGIN, data: { type: "other" } }, ORIGIN), null);
  assert.equal(parseGevMessage({ origin: ORIGIN, data: "gev-unauthorized" }, ORIGIN), null);
  assert.equal(parseGevMessage({ origin: ORIGIN, data: null }, ORIGIN), null);
});

test("retryDelayMs backs off and stops growing at 15 seconds", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(retryDelayMs), [3000, 5000, 8000, 12000, 15000, 15000, 15000]);
  assert.equal(retryDelayMs(0), 3000);
});

// ---------------------------------------------------------------------
// Token minting through the Worker client
// ---------------------------------------------------------------------

test("fetchGevToken asks the Worker with the admin token and returns the access link", async (t) => {
  process.env.NEXT_PUBLIC_TITAN_WORKER_URL = "https://worker.example/";
  const { fetchGevToken, WorkerApiError } = await import("../lib/workerApi");
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ token: "gev1.1.2.abcdefgh.sig", expires_at: "2026-10-01T00:05:00.000Z", ttl_seconds: 300 }), { status: 200 });
  });
  const res = await fetchGevToken("admin-secret");
  assert.equal(res.token, "gev1.1.2.abcdefgh.sig");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://worker.example/gev/token");
  assert.equal(calls[0].init.method, "GET");
  assert.equal((calls[0].init.headers as Record<string, string>)["X-Titan-Auth"], "admin-secret");
  assert.equal(calls[0].init.cache, "no-store");

  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
  await assert.rejects(fetchGevToken("wrong"), (error: unknown) => error instanceof WorkerApiError && error.status === 401);
});

test("toMintResult separates a rejected admin token, a missing secret, and other failures", async (t) => {
  process.env.NEXT_PUBLIC_TITAN_WORKER_URL = "https://worker.example";
  const { fetchGevToken } = await import("../lib/workerApi");

  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
  assert.deepEqual(toMintResult(await fetchGevToken("x").catch((e) => e)), { kind: "unauthorized" });

  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "gev_not_configured" }), { status: 503 }));
  assert.deepEqual(toMintResult(await fetchGevToken("x").catch((e) => e)), { kind: "not-configured", what: "secret" });

  t.mock.method(globalThis, "fetch", async () => new Response("boom", { status: 500 }));
  const other = toMintResult(await fetchGevToken("x").catch((e) => e));
  assert.equal(other.kind, "error");

  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("network down");
  });
  assert.equal(toMintResult(await fetchGevToken("x").catch((e) => e)).kind, "error");
  assert.deepEqual(toMintResult("plain string"), { kind: "error", message: "The access link request failed." });
});

// ---------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("checkGevHealth reads the gateway answer and treats everything else as down", async () => {
  const fetchImpl = (response: () => Promise<Response>) => (async () => response()) as unknown as typeof fetch;
  assert.equal(await checkGevHealth(ORIGIN, { fetchImpl: fetchImpl(async () => jsonResponse({ ok: true, service: "titan-gev", status: "ready" })) }), "ready");
  assert.equal(await checkGevHealth(ORIGIN, { fetchImpl: fetchImpl(async () => jsonResponse({ ok: false, service: "titan-gev", status: "starting" }, 503)) }), "starting");
  assert.equal(await checkGevHealth(ORIGIN, { fetchImpl: fetchImpl(async () => new Response("<html>Service is waking up</html>", { status: 200 })) }), "down");
  assert.equal(await checkGevHealth(ORIGIN, { fetchImpl: fetchImpl(async () => jsonResponse({ ok: true, service: "someone-else" })) }), "down");
  assert.equal(await checkGevHealth(ORIGIN, { fetchImpl: fetchImpl(async () => { throw new TypeError("Failed to fetch"); }) }), "down");
});

test("checkGevHealth asks for /healthz without credentials and gives up on a hung request", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const capture = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return jsonResponse({ ok: true, service: "titan-gev" });
  }) as unknown as typeof fetch;
  await checkGevHealth(ORIGIN, { fetchImpl: capture });
  assert.equal(seen!.url, `${ORIGIN}/healthz`);
  assert.equal(seen!.init.credentials, "omit");
  assert.equal(seen!.init.cache, "no-store");

  const hung = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  assert.equal(await checkGevHealth(ORIGIN, { fetchImpl: hung, timeoutMs: 20 }), "timeout");
});

// ---------------------------------------------------------------------
// Open full screen
// ---------------------------------------------------------------------

function fakeWindow() {
  const log: string[] = [];
  const win = {
    opener: "dashboard" as unknown,
    location: { replace: (url: string) => log.push(`replace ${url}`) },
    close: () => log.push("close"),
  };
  return { win, log };
}

test("full screen opens the window first, then loads the globe with a fresh access link", async () => {
  const { win, log } = fakeWindow();
  let minted = false;
  const result = await openGevFullScreen({
    origin: ORIGIN,
    openBlank: () => {
      assert.equal(minted, false, "the window must open before the token is minted");
      return win;
    },
    mint: async () => {
      minted = true;
      return { kind: "ok", token: "gev1.tok" };
    },
  });
  assert.equal(result, "opened");
  assert.equal(win.opener, null);
  assert.deepEqual(log, [`replace ${ORIGIN}/?gev_token=gev1.tok`]);
});

test("full screen reports a blocked popup and closes the blank window when minting fails", async () => {
  assert.equal(
    await openGevFullScreen({ origin: ORIGIN, openBlank: () => null, mint: async () => ({ kind: "ok", token: "t" }) }),
    "popup-blocked",
  );
  const { win, log } = fakeWindow();
  assert.equal(
    await openGevFullScreen({ origin: ORIGIN, openBlank: () => win, mint: async () => ({ kind: "unauthorized" }) }),
    "failed",
  );
  assert.deepEqual(log, ["close"]);
});

// ---------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeTimers {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; ms: number; fn: () => void }>();
  setTimer = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, ms, fn });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.tasks.delete(handle as number);
  };
  pendingDelays(): number[] {
    return [...this.tasks.values()].map((task) => task.ms).sort((a, b) => a - b);
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.tasks.delete(due[0]);
      due[1].fn();
      await settle();
    }
    this.now = end;
  }
}

function harness(opts: { target?: string | undefined; health?: () => HealthResult | Promise<HealthResult>; mint?: () => MintResult | Promise<MintResult> }) {
  const timers = new FakeTimers();
  const history: GevState[] = [];
  let unauthorized = 0;
  const calls = { health: 0, mint: 0 };
  const controller = new GevController({
    target: parseGevUrl(opts.target),
    checkHealth: async () => {
      calls.health += 1;
      return (opts.health ?? (() => "ready"))();
    },
    mint: async () => {
      calls.mint += 1;
      return (opts.mint ?? (() => ({ kind: "ok", token: `tok${calls.mint}` })))();
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onState: (state) => history.push(state),
    onUnauthorized: () => {
      unauthorized += 1;
    },
    now: () => timers.now,
  });
  return { controller, timers, history, calls, unauthorized: () => unauthorized, phases: () => history.map((s) => s.phase) };
}

test("with no host URL the controller shows the empty state and makes no network calls", async () => {
  const unset = harness({ target: undefined });
  unset.controller.start();
  await settle();
  assert.equal(unset.controller.getState().phase, "empty");
  assert.equal(unset.controller.getState().emptyReason, "unset");
  assert.deepEqual(unset.calls, { health: 0, mint: 0 });
  assert.deepEqual(unset.timers.pendingDelays(), []);

  const invalid = harness({ target: "http://example.com" });
  invalid.controller.start();
  assert.equal(invalid.controller.getState().emptyReason, "invalid");
});

test("a sleeping host shows the waking state and the controller retries on its own until it answers", async () => {
  let answers: HealthResult[] = ["down", "down", "starting", "ready"];
  const h = harness({ target: ORIGIN, health: () => answers.shift() ?? "ready" });
  h.controller.start();
  await settle();
  assert.equal(h.controller.getState().phase, "waking");
  assert.equal(h.controller.getState().attempts, 1);
  assert.equal(h.calls.mint, 0, "no token is minted while the host sleeps");
  assert.deepEqual(h.timers.pendingDelays(), [3000]);

  await h.timers.advance(3000);
  assert.equal(h.controller.getState().attempts, 2);
  assert.deepEqual(h.timers.pendingDelays(), [5000]);

  await h.timers.advance(5000);
  assert.equal(h.controller.getState().attempts, 3);
  assert.deepEqual(h.timers.pendingDelays(), [8000]);

  await h.timers.advance(8000);
  const state = h.controller.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.src, `${ORIGIN}/?gev_token=tok1`);
  assert.equal(state.reachable, true);
  assert.equal(h.calls.mint, 1);
  assert.deepEqual(h.phases().filter((phase, i, all) => phase !== all[i - 1]), ["checking", "waking", "minting", "ready"]);
});

test("a probe that times out retries at once, a fast failure still backs off", async () => {
  // Render holds the request while a free instance wakes, so each timed out probe
  // already spent the full timeout. The retry must not add the backoff on top.
  let answers: HealthResult[] = ["timeout", "timeout", "down", "timeout", "ready"];
  const h = harness({ target: ORIGIN, health: () => answers.shift() ?? "ready" });
  h.controller.start();
  await settle();
  assert.equal(h.controller.getState().phase, "waking");
  assert.deepEqual(h.timers.pendingDelays(), [500]);

  await h.timers.advance(500);
  assert.equal(h.controller.getState().attempts, 2);
  assert.deepEqual(h.timers.pendingDelays(), [500]);

  await h.timers.advance(500);
  assert.equal(h.controller.getState().attempts, 3);
  assert.deepEqual(h.timers.pendingDelays(), [8000], "a fast failure takes the backoff step for its attempt");

  await h.timers.advance(8000);
  assert.equal(h.controller.getState().attempts, 4);
  assert.deepEqual(h.timers.pendingDelays(), [500]);

  await h.timers.advance(500);
  assert.equal(h.controller.getState().phase, "ready");
  assert.equal(h.calls.mint, 1);
});

test("an awake host goes straight from checking to ready", async () => {
  const h = harness({ target: ORIGIN });
  h.controller.start();
  await settle();
  assert.deepEqual(h.phases().filter((phase, i, all) => phase !== all[i - 1]), ["checking", "minting", "ready"]);
  assert.equal(h.controller.getState().frameKey, 1);
});

test("a rejected admin token locks the dashboard through onUnauthorized", async () => {
  const h = harness({ target: ORIGIN, mint: () => ({ kind: "unauthorized" }) });
  h.controller.start();
  await settle();
  assert.equal(h.controller.getState().phase, "error");
  assert.equal(h.unauthorized(), 1);
});

test("a missing gate secret or Worker URL shows the setup state and does not retry", async () => {
  const secret = harness({ target: ORIGIN, mint: () => ({ kind: "not-configured", what: "secret" }) });
  secret.controller.start();
  await settle();
  assert.equal(secret.controller.getState().phase, "unconfigured");
  assert.equal(secret.controller.getState().missing, "secret");
  assert.deepEqual(secret.timers.pendingDelays(), []);

  const worker = harness({ target: ORIGIN, mint: () => ({ kind: "not-configured", what: "worker" }) });
  worker.controller.start();
  await settle();
  assert.equal(worker.controller.getState().missing, "worker");
});

test("a failed mint shows the error and retries after 15 seconds", async () => {
  let attempt = 0;
  const h = harness({
    target: ORIGIN,
    mint: () => (++attempt === 1 ? { kind: "error", message: "Worker responded 500" } : { kind: "ok", token: "second" }),
  });
  h.controller.start();
  await settle();
  assert.equal(h.controller.getState().phase, "error");
  assert.equal(h.controller.getState().message, "Worker responded 500");
  assert.deepEqual(h.timers.pendingDelays(), [15_000]);
  await h.timers.advance(15_000);
  assert.equal(h.controller.getState().phase, "ready");
  assert.match(h.controller.getState().src ?? "", /gev_token=second$/);
});

test("while ready the monitor needs two missed checks to report the host unreachable", async () => {
  let answer: HealthResult = "ready";
  const h = harness({ target: ORIGIN, health: () => answer });
  h.controller.start();
  await settle();
  assert.equal(h.controller.getState().reachable, true);

  answer = "down";
  await h.timers.advance(30_000);
  assert.equal(h.controller.getState().reachable, true, "one miss is noise");
  await h.timers.advance(30_000);
  assert.equal(h.controller.getState().reachable, false);
  assert.equal(h.controller.getState().phase, "ready", "the frame stays up");

  answer = "ready";
  await h.timers.advance(30_000);
  assert.equal(h.controller.getState().reachable, true);
});

test("a blocked cookie message raises the banner flag and reload clears it", async () => {
  const h = harness({ target: ORIGIN });
  h.controller.start();
  await settle();
  h.controller.reportMessage("session-blocked");
  assert.equal(h.controller.getState().sessionBlocked, true);
  h.controller.reload();
  await settle();
  assert.equal(h.controller.getState().sessionBlocked, false);
  assert.equal(h.controller.getState().frameKey, 2, "reload mints a new link and remounts the frame");
});

test("a 401 inside the frame reloads twice, then stops and explains", async () => {
  const h = harness({ target: ORIGIN });
  h.controller.start();
  await settle();
  h.controller.reportMessage("unauthorized");
  await settle();
  assert.equal(h.controller.getState().frameKey, 2);
  h.controller.reportMessage("unauthorized");
  await settle();
  assert.equal(h.controller.getState().frameKey, 3);
  h.controller.reportMessage("unauthorized");
  await settle();
  assert.equal(h.controller.getState().phase, "error");
  assert.match(h.controller.getState().message ?? "", /GEV_VERIFY_KEY/);
  assert.equal(h.calls.mint, 3, "the third report did not mint again");
});

test("the session refreshes before the host ends it", async () => {
  const h = harness({ target: ORIGIN });
  h.controller.start();
  await settle();
  assert.equal(h.controller.getState().frameKey, 1);
  await h.timers.advance(5.5 * 60 * 60 * 1000);
  assert.equal(h.controller.getState().frameKey, 2);
  assert.equal(h.calls.mint, 2);
});

test("stop() makes late answers harmless and clears every timer", async () => {
  let release: (value: HealthResult) => void = () => {};
  const h = harness({ target: ORIGIN, health: () => new Promise<HealthResult>((resolve) => { release = resolve; }) });
  h.controller.start();
  await settle();
  const before = h.history.length;
  h.controller.stop();
  release("ready");
  await settle();
  assert.equal(h.history.length, before, "no state after stop");
  assert.equal(h.calls.mint, 0);

  const ready = harness({ target: ORIGIN });
  ready.controller.start();
  await settle();
  assert.ok(ready.timers.pendingDelays().length > 0);
  ready.controller.stop();
  assert.deepEqual(ready.timers.pendingDelays(), []);
});
