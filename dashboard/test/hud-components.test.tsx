// Covers the HUD components: the AI core, the system pill, and the Systems Deck.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import AiCore from "../components/AiCore";
import SystemsDeck from "../components/SystemsDeck";
import { SysPill } from "../components/SysPill";
import { DECK_TABS } from "../lib/core";

test("the AI core names its state in words", () => {
  const html = renderToStaticMarkup(<AiCore state="degraded" />);
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="TITAN core: Degraded"/);
  assert.match(html, /ai-core-degraded/);
});

test("the system pill shows the code and the text, and the detail stays closed", () => {
  const html = renderToStaticMarkup(
    <SysPill tone="warn" code="SYS_WARNING" text="No pulse in 227 min" title="No pulse">
      <p>Detail</p>
    </SysPill>,
  );
  assert.match(html, /SYS_WARNING/);
  assert.match(html, /No pulse in 227 min/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /Detail/);
});

test("a closed Systems Deck lists every tab and renders no panel", () => {
  const html = renderToStaticMarkup(
    <SystemsDeck open={false} active="overview" onToggle={() => {}} onSelect={() => {}} summary="No tasks are waiting.">
      <p>PANEL</p>
    </SystemsDeck>,
  );
  for (const t of DECK_TABS) assert.match(html, new RegExp(t.label.replace("'", "(&#x27;|')")));
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /PANEL/);
  assert.doesNotMatch(html, /aria-controls=/);
  assert.match(html, /href="\/health"/);
});

test("an open Systems Deck renders the active panel and links it to its tab", () => {
  const html = renderToStaticMarkup(
    <SystemsDeck open active="brief" onToggle={() => {}} onSelect={() => {}} summary="x">
      <p>PANEL</p>
    </SystemsDeck>,
  );
  assert.match(html, /PANEL/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /role="tabpanel"[^>]*aria-labelledby="deck-tab-brief"|aria-labelledby="deck-tab-brief"[^>]*role="tabpanel"/);
});
