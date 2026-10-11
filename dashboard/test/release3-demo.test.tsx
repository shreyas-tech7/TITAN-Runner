import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getDemoStateFile, handleDemoWorkerCall } from "../lib/demoFixtures";
import HowItWorksView from "../components/HowItWorksView";

test("V1: demoFixtures returns realistic read-only state files, streams demo SSE on POST /chat, and refuses writes with 403", async () => {
  const hb = getDemoStateFile("state/heartbeat.json") as { lastStatus: string };
  assert.equal(hb.lastStatus, "ok");

  const statusRes = handleDemoWorkerCall("/status", { method: "GET" });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.ok(statusJson.subagents.length >= 2);

  const briefRes = handleDemoWorkerCall("/brief", { method: "GET" });
  assert.equal(briefRes.status, 200);
  const briefJson = await briefRes.json();
  assert.match(briefJson.brief.text, /TITAN daily brief/);

  const chatRes = handleDemoWorkerCall("/chat", { method: "POST" });
  assert.equal(chatRes.status, 200);
  const sseText = await chatRes.text();
  assert.match(sseText, /event: meta/);
  assert.match(sseText, /event: delta/);

  const writeRes = handleDemoWorkerCall("/admin/keys", { method: "POST" });
  assert.equal(writeRes.status, 403);
  const writeJson = await writeRes.json();
  assert.equal(writeJson.error, "demo_read_only");
});

test("V4: HowItWorksView renders architecture, 4-state key proof, connector broker, and MCP sections", () => {
  const html = renderToStaticMarkup(<HowItWorksView />);
  assert.match(html, /Three-Plane Architecture/);
  assert.match(html, /Keys That Work/);
  assert.match(html, /Connector Broker/);
  assert.match(html, /Dual-Era MCP Server/);
});
