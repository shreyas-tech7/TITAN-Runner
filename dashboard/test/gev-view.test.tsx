// Covers what the God's Eye View tab renders in each state: the empty state when
// no Space URL is set, the waking state with its automatic retry note, the ready
// state with the iframe, the error and setup states, and the attribution footer
// that every state must keep. Server rendering is enough, because the view has
// no hooks. The controller tests in gev.test.ts cover the behavior over time.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import GevTabView from "../components/GevTabView";
import TopTabs from "../components/TopTabs";
import { INITIAL_GEV_STATE, buildGevSrc, type GevState } from "../lib/gev";

const ORIGIN = "https://cozmik7-titan-gev.hf.space";

function render(overrides: Partial<GevState>, origin: string | null = ORIGIN): string {
  return renderToStaticMarkup(
    <GevTabView state={{ ...INITIAL_GEV_STATE, ...overrides }} origin={origin} onReload={() => {}} onOpenFullScreen={() => {}} />,
  );
}

test("empty state: names the env var, explains the fix, and disables the buttons", () => {
  const html = render({ phase: "empty", emptyReason: "unset" }, null);
  assert.match(html, /data-gev-state="empty"/);
  assert.match(html, /God(&#x27;|')s Eye View is not connected/);
  assert.match(html, /NEXT_PUBLIC_GEV_URL/);
  assert.match(html, /GEV_URL/);
  assert.match(html, /docs\/GODS-EYE-VIEW\.md/);
  assert.match(html, /Not configured/);
  assert.match(html, /no Space URL set/);
  assert.equal(html.includes("<iframe"), false);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2, "Reload session and Open full screen are disabled");
});

test("empty state: an invalid URL gets its own message", () => {
  const html = render({ phase: "empty", emptyReason: "invalid" }, null);
  assert.match(html, /is not a valid https URL/);
});

test("waking state: says it can take a minute and that it retries by itself", () => {
  const first = render({ phase: "waking", attempts: 1, reachable: false });
  assert.match(first, /data-gev-state="waking"/);
  assert.match(first, /Waking up, this can take a minute/);
  assert.match(first, /Retrying automatically/);
  assert.match(first, /Waking up/);
  assert.equal(first.includes("<iframe"), false);
  assert.equal(first.includes("(check"), false, "no counter on the first check");

  const later = render({ phase: "waking", attempts: 4, reachable: false });
  assert.match(later, /\(check 4\)/);
  assert.match(later, /dot-pulsing/);
});

test("checking and signing in are brief states with no frame", () => {
  assert.match(render({ phase: "checking" }), /Checking the Space/);
  const signing = render({ phase: "minting", reachable: true });
  assert.match(signing, /Signing in/);
  assert.equal(signing.includes("<iframe"), false);
});

test("ready state: a full height iframe at the Space URL with the access link, and a Reachable status", () => {
  const src = buildGevSrc(ORIGIN, "gev1.1.2.abcdefgh.sig");
  const html = render({ phase: "ready", src, reachable: true, frameKey: 1 });
  assert.match(html, /<iframe[^>]*class="gev-frame"/);
  assert.ok(html.includes(`src="${ORIGIN}/?gev_token=gev1.1.2.abcdefgh.sig"`));
  assert.match(html, /title="God(&#x27;|')s Eye View"/);
  assert.match(html, /allow="fullscreen; clipboard-write"/);
  assert.match(html, /sandbox="[^"]*allow-scripts[^"]*allow-same-origin/);
  assert.equal(/sandbox="[^"]*allow-top-navigation/.test(html), false, "the frame cannot navigate the dashboard");
  assert.match(html, /Reachable/);
  assert.match(html, /dot-live/);
  assert.match(html, new RegExp(ORIGIN.replace("https://", "").replace(/\./g, "\\.")));
  assert.equal(html.includes('role="alert"'), false);
});

test("ready state: shows Unreachable when the monitor loses the Space, and keeps the frame", () => {
  const html = render({ phase: "ready", src: buildGevSrc(ORIGIN, "t"), reachable: false });
  assert.match(html, /Unreachable, retrying/);
  assert.match(html, /<iframe/);
});

test("ready state: a blocked cookie shows the banner that points to Open full screen", () => {
  const html = render({ phase: "ready", src: buildGevSrc(ORIGIN, "t"), reachable: true, sessionBlocked: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /blocked the session cookie/);
  assert.match(html, /Open full screen/);
});

test("setup state: says which half is missing", () => {
  const secret = render({ phase: "unconfigured", missing: "secret" });
  assert.match(secret, /GEV_SHARED_SECRET/);
  assert.match(secret, /Gate not configured/);
  const worker = render({ phase: "unconfigured", missing: "worker" });
  assert.match(worker, /NEXT_PUBLIC_TITAN_WORKER_URL/);
});

test("error state: shows the message, says it retries, and offers Try again now", () => {
  const html = render({ phase: "error", message: "Worker responded 500" });
  assert.match(html, /Worker responded 500/);
  assert.match(html, /Retrying automatically/);
  assert.match(html, /Try again now/);
});

test("every state keeps the attribution footer with the upstream link and license", () => {
  const states: Partial<GevState>[] = [
    { phase: "empty", emptyReason: "unset" },
    { phase: "checking" },
    { phase: "waking", attempts: 2 },
    { phase: "minting" },
    { phase: "ready", src: buildGevSrc(ORIGIN, "t"), reachable: true },
    { phase: "unconfigured", missing: "secret" },
    { phase: "error", message: "x" },
  ];
  for (const state of states) {
    const html = render(state, state.phase === "empty" ? null : ORIGIN);
    assert.match(html, /data-gev-attribution/, String(state.phase));
    assert.match(html, /Bilawal Sidhu/, String(state.phase));
    assert.match(html, /MIT license/, String(state.phase));
    assert.ok(html.includes("https://github.com/bilawalsidhu/gods-eye-view"), String(state.phase));
    assert.ok(html.includes("https://github.com/shreyas-tech7/TITAN-GEV"), String(state.phase));
  }
});

test("the status bar is a polite live region so a state change is announced", () => {
  assert.match(render({ phase: "waking", attempts: 1 }), /role="status"[^>]*aria-live="polite"/);
});

test("the top level tabs link both views and mark the current one", () => {
  const onTab = renderToStaticMarkup(<TopTabs active="gods-eye" />);
  assert.match(onTab, /aria-label="Sections"/);
  assert.match(onTab, /God(&#x27;|')s Eye View/);
  assert.match(onTab, /Dashboard/);
  assert.equal((onTab.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(onTab, /href="\/ops\/gods-eye"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/ops\/gods-eye"/);

  const onDash = renderToStaticMarkup(<TopTabs active="dashboard" />);
  assert.match(onDash, /href="\/"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/"/);
});
