// Wave 12, Release 2, the dashboard side of Tracks C, M, and H: the card states, the filters, the connect form, the schema
// form, the MCP card, the health words, and the rules that keep a secret out of the page. The Worker side is covered by
// worker/test/connectors-*.test.mjs, worker/test/health.test.mjs, and worker/test/telegram-router-mcp.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import ConnectModal from "../components/ConnectModal";
import { ClaudeCard } from "../components/McpPanel";
import { Ring } from "../components/SetupChecklist";
import SchemaForm from "../components/SchemaForm";
import type { ConnectionView, ConnectorView, JsonSchema } from "../lib/connectorsApi";
import {
  CARD_STATE_META, DATA_CLASS_META, RISK_META, buildInput, cardView, categoriesOf, claudeCodeCommand, confirmText, connectFields, connectProblems, connectedCount, describeExpiry, describeRule, fieldsFromSchema,
  filterConnectors, redirectUriFor, testSends, testableConnections, tryableActions,
} from "../lib/connectorsView";
import { HEALTH_STATE_META, fixHref, groupRows, nextSetupItem, overallLine, ringGeometry, summaryOf, versionMismatch } from "../lib/healthView";
import type { HealthRow } from "../lib/healthApi";

function conn(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: "c_1", connectorId: "discord_webhook", label: "Discord webhook", status: "connected", lastTestAt: "2026-10-08T10:00:00.000Z", lastTestOk: true, lastTestMs: 120, lastError: null,
    createdAt: "2026-10-08T09:00:00.000Z", config: {}, secretNames: ["url"], meta: {}, ownerPaired: false, policies: {}, ...over,
  };
}

function connector(over: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "discord_webhook", name: "Discord webhook", icon: "DC", version: "1.0.0", category: "notify", description: "Post a message to a Discord channel through a webhook.",
    docsUrl: "https://discord.com/developers/docs/resources/webhook", getKeyUrl: "https://support.discord.com/hc/en-us/articles/228383668", apiVersion: "Webhook API v10",
    auth: { kind: "secret_url", setupNote: "The URL is the secret.", fields: [{ name: "url", label: "Webhook URL", secret: true, optional: false, help: "It starts with https://discord.com/api/webhooks/.", placeholder: "", default: "" }] },
    egress: ["discord.com"], testMode: "request", triggers: [], connections: [],
    actions: [
      { id: "send", title: "Send a message", description: "", risk: "write", dataClass: "internal", input: { type: "object", properties: { text: { type: "string", maxLength: 1900 } }, required: ["text"] }, rateLimit: { perMinute: 10 } },
      { id: "info", title: "Read the webhook", description: "", risk: "read", dataClass: "public", input: { type: "object", properties: {} }, rateLimit: null },
    ],
    ...over,
  };
}

const rss = () => connector({ id: "rss", name: "RSS feed", category: "data", description: "Read a feed.", auth: { kind: "none", setupNote: "", fields: [] } });
const gmail = () =>
  connector({
    id: "gmail", name: "Gmail", category: "productivity", description: "Read mail.",
    auth: { kind: "oauth2_pkce", setupNote: "", oauth: { scopes: ["gmail.readonly"] }, fields: [
      { name: "client_id", label: "Client ID", secret: false, optional: false, help: "", placeholder: "", default: "" },
      { name: "client_secret", label: "Client secret", secret: true, optional: false, help: "", placeholder: "", default: "" },
    ] },
  });

test("a card tells the truth: saved but not verified is not Connected, and a vault that is not ready is Setup needed", () => {
  assert.equal(cardView(connector(), true).state, "none");
  assert.equal(cardView(connector(), false).state, "setup", "a tool with a secret needs the vault");
  assert.equal(cardView(rss(), false).state, "none", "a tool with no key needs no vault");
  assert.equal(cardView(connector({ connections: [conn()] }), true).state, "connected");
  assert.equal(cardView(connector({ connections: [conn({ status: "unverified", lastTestOk: null })] }), true).state, "attention");
  assert.equal(cardView(connector({ connections: [conn({ status: "error", lastError: "Discord answered 401." })] }), true).detail, "Discord answered 401.");
  assert.equal(cardView(connector({ connections: [conn({ status: "needs_reconnect" })] }), true).state, "attention");
  assert.equal(cardView(connector({ connections: [conn({ status: "needs_authorization" })] }), true).state, "setup");
  assert.equal(cardView(connector({ connections: [conn(), conn({ id: "c_2", status: "error" })] }), true).state, "attention", "the worst connection wins");
  assert.equal(cardView(connector({ connections: [conn({ lastTestOk: false })] }), true).state, "attention");
  for (const meta of Object.values(CARD_STATE_META)) assert.ok(meta.label.length > 3);
  assert.notEqual(CARD_STATE_META.attention.tone, "ok");
  assert.notEqual(CARD_STATE_META.none.tone, "ok");
});

test("the filter searches the name and the description, narrows by category, and puts cards that need a look first", () => {
  const list = [connector({ connections: [conn()] }), rss(), gmail(), connector({ id: "ntfy", name: "ntfy", description: "Push to your phone.", connections: [conn({ id: "c_9", status: "error" })] })];
  assert.deepEqual(filterConnectors(list, { query: "", category: "all" }, true).map((c) => c.id), ["ntfy", "discord_webhook", "gmail", "rss"]);
  assert.deepEqual(filterConnectors(list, { query: "feed", category: "all" }, true).map((c) => c.id), ["rss"]);
  assert.deepEqual(filterConnectors(list, { query: "PHONE", category: "all" }, true).map((c) => c.id), ["ntfy"]);
  assert.deepEqual(filterConnectors(list, { query: "", category: "data" }, true).map((c) => c.id), ["rss"]);
  assert.deepEqual(filterConnectors(list, { query: "nothing here", category: "all" }, true), []);
  assert.deepEqual(categoriesOf(list), ["notify", "productivity", "data"]);
  assert.equal(connectedCount(list), 1, "only a connection in the state connected counts");
});

test("Test all skips a connector that has nothing to test, and a connection that waits for a sign in", () => {
  const list = [connector({ connections: [conn()] }), connector({ id: "static", testMode: "none", connections: [conn({ id: "c_s" })] }), gmail()];
  list[2] = { ...list[2], connections: [conn({ id: "c_g", connectorId: "gmail", status: "needs_authorization" })] };
  assert.deepEqual(testableConnections(list).map((c) => c.id), ["c_1"]);
  assert.equal(testSends(connector({ testMode: "onClick" })), true);
  assert.equal(testSends(connector()), false);
});

test("the connect form: a required field is checked, a default is not demanded, and only filled fields go out", () => {
  const c = connector({ auth: { kind: "bearer", setupNote: "", fields: [
    { name: "token", label: "Token", secret: true, optional: false, help: "", placeholder: "", default: "" },
    { name: "owner", label: "Owner", secret: false, optional: true, help: "", placeholder: "", default: "" },
    { name: "base", label: "Base", secret: false, optional: false, help: "", placeholder: "", default: "https://api.example.com" },
  ] } });
  assert.deepEqual(connectProblems(c, {}), [{ name: "token", message: 'Fill in "Token".' }]);
  assert.deepEqual(connectProblems(c, { token: "  " }), [{ name: "token", message: 'Fill in "Token".' }]);
  assert.deepEqual(connectProblems(c, { token: "x" }), []);
  assert.deepEqual(connectFields(c, { token: " abc ", owner: "", base: "" }), { token: "abc" });
});

test("the schema form: each JSON Schema type becomes the right field and the right value", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["title", "count"],
    properties: {
      title: { type: "string", maxLength: 20, description: "A short title." },
      body: { type: "string", maxLength: 2000 },
      count: { type: "integer", minimum: 1, maximum: 5 },
      ratio: { type: "number" },
      draft: { type: "boolean" },
      state: { type: "string", enum: ["open", "closed"] },
      labels: { type: "array", items: { type: "string" } },
      payload: { type: "object" },
    },
  };
  const fields = fieldsFromSchema(schema);
  assert.deepEqual(fields.map((f) => [f.name, f.kind, f.required]), [
    ["title", "text", true], ["body", "textarea", false], ["count", "integer", true], ["ratio", "number", false], ["draft", "boolean", false], ["state", "select", false], ["labels", "list", false], ["payload", "json", false],
  ]);
  const good = buildInput(fields, { title: " Hello ", count: "3", ratio: "0.5", draft: "true", state: "open", labels: "a, b\nc", payload: '{"a":1}' });
  assert.deepEqual(good, { ok: true, input: { title: "Hello", count: 3, ratio: 0.5, draft: true, state: "open", labels: ["a", "b", "c"], payload: { a: 1 } } });
  const empty = buildInput(fields, {});
  assert.equal(empty.ok, false);
  assert.deepEqual(Object.keys((empty as { errors: Record<string, string> }).errors).sort(), ["count", "title"]);
  const bad = buildInput(fields, { title: "x".repeat(21), count: "9", ratio: "abc", state: "paused", payload: "{oops" }) as { ok: false; errors: Record<string, string> };
  assert.equal(bad.ok, false);
  assert.match(bad.errors.title, /20 characters/);
  assert.match(bad.errors.count, /5 or less/);
  assert.match(bad.errors.ratio, /a number/);
  assert.match(bad.errors.state, /listed values/);
  assert.match(bad.errors.payload, /valid JSON/);
  assert.equal((buildInput(fields, { title: "t", count: "1.5" }) as { errors: Record<string, string> }).errors.count, '"Count" must be a whole number.');
  assert.deepEqual(buildInput(fieldsFromSchema({ type: "object", properties: {} }), {}), { ok: true, input: {} });
});

test("a destructive action is never tried from the drawer, and the confirm text is the one the Worker expects", () => {
  const c = connector({ actions: [...connector().actions, { id: "wipe", title: "Wipe", description: "", risk: "destructive", dataClass: "internal", input: { type: "object" }, rateLimit: null }] });
  assert.deepEqual(tryableActions(c).map((a) => a.id), ["info"]);
  assert.equal(confirmText("github", "delete_branch"), "github.delete_branch");
  assert.equal(RISK_META.destructive.tone, "danger");
  assert.equal(DATA_CLASS_META.personal.label, "Personal data");
});

test("the Claude Code command holds a placeholder and never a token", () => {
  assert.equal(claudeCodeCommand(""), 'claude mcp add --transport http titan <WORKER_URL>/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"');
  assert.equal(claudeCodeCommand("https://w.example.workers.dev/"), 'claude mcp add --transport http titan https://w.example.workers.dev/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"');
  assert.ok(!claudeCodeCommand("https://w.example").includes("titan_mcp_"));
  const html = renderToStaticMarkup(<ClaudeCard />);
  assert.match(html, /&lt;YOUR_MCP_TOKEN&gt;/);
  assert.match(html, /The Claude app/);
  assert.match(html, /does not support that sign in yet/, "the card does not promise the Claude app path before it exists");
  assert.ok(!html.includes("titan_mcp_"));
});

test("token expiry reads in plain words, and a rule reads as one line", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(describeExpiry(null, null, now), "Does not expire");
  assert.equal(describeExpiry("2026-10-08T12:20:00Z", null, now), "Expires in less than an hour");
  assert.equal(describeExpiry("2026-10-08T20:00:00Z", null, now), "Expires in 8 hours");
  assert.equal(describeExpiry("2026-10-09T12:00:01Z", null, now), "Expires in 2 days");
  assert.equal(describeExpiry("2026-10-18T12:00:00Z", null, now), "Expires in 10 days");
  assert.equal(describeExpiry("2026-10-01T12:00:00Z", null, now), "Expired");
  assert.equal(describeExpiry("2026-12-01T12:00:00Z", "2026-10-02T00:00:00Z", now), "Revoked");
  assert.match(describeRule({ eventPattern: "task.failed", minSeverity: "warn", quietStart: "22:00", quietEnd: "07:00", tz: "America/Chicago", dedupeMinutes: 30 }), /Quiet 22:00 to 07:00 \(America\/Chicago\)\. Errors still go out\./);
  assert.match(describeRule({ eventPattern: "*", minSeverity: "info", quietStart: null, quietEnd: null, tz: "America/Chicago", dedupeMinutes: 0 }), /No quiet hours\./);
});

test("the connect window: password fields for secrets, a safe learn link, and no value in the markup", () => {
  const html = renderToStaticMarkup(<ConnectModal token="t" connector={connector()} vaultReady onClose={() => {}} onChanged={() => {}} onOpenDetails={() => {}} onUnauthorized={() => {}} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Connect Discord webhook/);
  assert.match(html, /<input id="connect-url" type="password"/);
  assert.match(html, />Show</);
  assert.match(html, /The URL is the secret\./);
  assert.match(html, /Where do I get this\?/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /TITAN encrypts it\. It is never shown again\./);
  assert.ok(!/id="connect-url"[^>]*value="[^"]/.test(html), "the field starts empty");
  assert.ok(!html.includes("Remember on this device"));
});

test("the connect window with no vault: the button is off and the reason is in words", () => {
  const html = renderToStaticMarkup(<ConnectModal token="t" connector={connector()} vaultReady={false} onClose={() => {}} onChanged={() => {}} onOpenDetails={() => {}} onUnauthorized={() => {}} />);
  assert.match(html, /The vault is not ready, so TITAN cannot store a secret yet/);
  assert.match(html, /<button class="btn btn-primary" disabled="">Connect and test<\/button>/);
  const free = renderToStaticMarkup(<ConnectModal token="t" connector={rss()} vaultReady={false} onClose={() => {}} onChanged={() => {}} onOpenDetails={() => {}} onUnauthorized={() => {}} />);
  assert.ok(!free.includes("The vault is not ready"), "a tool with no key needs no vault");
  assert.match(free, /This tool needs no key/);
});

test("the connect window for Google: the exact redirect address and the 7 day limit of the Testing status", () => {
  assert.equal(redirectUriFor("gmail", "https://w.example.workers.dev/"), "https://w.example.workers.dev/oauth/gmail/callback");
  assert.equal(redirectUriFor("gmail", ""), "<WORKER_URL>/oauth/gmail/callback");
  const html = renderToStaticMarkup(<ConnectModal token="t" connector={gmail()} vaultReady onClose={() => {}} onChanged={() => {}} onOpenDetails={() => {}} onUnauthorized={() => {}} />);
  assert.match(html, /Register this redirect address/);
  assert.match(html, /\/oauth\/gmail\/callback/);
  assert.match(html, /While your Google app has the status Testing, Google ends a sign in after 7 days/);
  assert.match(html, /<input id="connect-client_id" type="text"/);
  assert.match(html, /<input id="connect-client_secret" type="password"/);
});

test("the schema form renders a labelled control for each field and no value", () => {
  const html = renderToStaticMarkup(<SchemaForm schema={connector().actions[0].input} submitLabel="Run" onSubmit={() => {}} />);
  assert.match(html, /<label for="[^"]+">Text<\/label>/);
  assert.match(html, /aria-required="true"/);
  assert.match(html, />Run</);
  assert.match(renderToStaticMarkup(<SchemaForm schema={{ type: "object", properties: {} }} submitLabel="Run" onSubmit={() => {}} />), /This action needs no input\./);
});

// --- Health ----------------------------------------------------------------------------------------------------------------

function hrow(over: Partial<HealthRow> = {}): HealthRow {
  return { id: "worker", group: "core", label: "Worker", state: "ok", detail: "Fine.", checkedAt: "2026-10-08T10:00:00.000Z", latencyMs: 20, fix: null, ...over };
}

test("a health state is a word, and Not tested is never green", () => {
  assert.equal(HEALTH_STATE_META.ok.label, "Working");
  assert.equal(HEALTH_STATE_META.unknown.label, "Not tested");
  assert.notEqual(HEALTH_STATE_META.unknown.tone, "ok");
  assert.notEqual(HEALTH_STATE_META.warn.tone, "ok");
});

test("rows group in a fixed order, and an empty group is left out", () => {
  const rows = [hrow({ id: "e", group: "external" }), hrow({ id: "k", group: "keys" }), hrow({ id: "w" })];
  assert.deepEqual(groupRows(rows).map((g) => g.group), ["core", "keys", "external"]);
  assert.deepEqual(summaryOf([{ state: "ok" }, { state: "ok" }, { state: "down" }, { state: "unknown" }]), { ok: 2, warn: 0, down: 1, unknown: 1 });
});

test("the headline counts what is wrong before it says anything good", () => {
  assert.deepEqual(overallLine({ ok: 5, warn: 1, down: 2, unknown: 0 }), { tone: "danger", text: "2 parts are not working." });
  assert.deepEqual(overallLine({ ok: 5, warn: 0, down: 1, unknown: 0 }), { tone: "danger", text: "1 part is not working." });
  assert.deepEqual(overallLine({ ok: 5, warn: 2, down: 0, unknown: 0 }), { tone: "warn", text: "2 parts need a look." });
  assert.equal(overallLine({ ok: 0, warn: 0, down: 0, unknown: 3 }).text, "No part was tested yet.");
  assert.match(overallLine({ ok: 4, warn: 0, down: 0, unknown: 2 }).text, /All tested parts work\. 2 parts were not tested\./);
  assert.equal(overallLine({ ok: 4, warn: 0, down: 0, unknown: 0 }).text, "All parts work.");
});

test("a fix link of this dashboard gets the base path, and an outside link stays as it is", () => {
  assert.equal(fixHref("/keys/", "/TITAN-Runner"), "/TITAN-Runner/keys/");
  assert.equal(fixHref("/?settings=health", "/TITAN-Runner"), "/TITAN-Runner/?settings=health");
  assert.equal(fixHref("https://github.com/x/y", "/TITAN-Runner"), "https://github.com/x/y");
});

test("the setup ring: the percent, the dash, and the next step", () => {
  assert.equal(ringGeometry(0, 6).percent, 0);
  assert.equal(ringGeometry(3, 6).percent, 50);
  assert.equal(ringGeometry(6, 6).percent, 100);
  assert.equal(ringGeometry(1, 0).percent, 0, "no total never divides by zero");
  const g = ringGeometry(3, 6);
  assert.ok(Math.abs(g.dash + g.gap - g.circumference) < 1e-9);
  const items = [{ id: "a", label: "A", done: true, detail: "", link: null }, { id: "b", label: "B", done: false, detail: "", link: null }];
  assert.equal(nextSetupItem(items)?.id, "b");
  assert.equal(nextSetupItem([items[0]]), null);
  const html = renderToStaticMarkup(<Ring done={2} total={6} />);
  assert.match(html, /aria-label="2 of 6 setup steps done"/);
  assert.match(html, /33%/);
});

test("the version warning needs two known commits that differ", () => {
  assert.equal(versionMismatch("abc1234def", "abc1234999"), false, "the same short commit");
  assert.equal(versionMismatch("abc1234", "def5678"), true);
  assert.equal(versionMismatch("dev", "def5678"), false, "a local build has no commit");
  assert.equal(versionMismatch("abc1234", "unknown"), false);
  assert.equal(versionMismatch("abc1234", null), false);
  assert.equal(versionMismatch("abc1234", undefined), false);
});

// --- Safety rules for the source ------------------------------------------------------------------------------------------

test("no new source file stores a secret in the browser, logs, or puts a value in the URL", () => {
  const files = [
    "components/ConnectModal.tsx", "components/ConnectionDrawer.tsx", "components/ConnectorsPage.tsx", "components/McpPanel.tsx", "components/NotifyPanel.tsx", "components/ApprovalsPanel.tsx",
    "components/SchemaForm.tsx", "components/HealthPage.tsx", "components/HealthUrlsEditor.tsx", "components/SetupChecklist.tsx", "components/VersionFooter.tsx", "components/CopyButton.tsx",
    "lib/connectorsApi.ts", "lib/connectorsView.ts", "lib/healthApi.ts", "lib/healthView.ts",
  ];
  for (const f of files) {
    const text = readFileSync(join(__dirname, "..", f), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/localStorage|sessionStorage/.test(code), `${f} must not store anything in the browser`);
    assert.ok(!/console\.(log|info|warn|error)\(/.test(code), `${f} must not log`);
    assert.ok(!/searchParams\.set\(["'](token|secret|key|value)/.test(code), `${f} must not put a secret in the URL`);
    assert.ok(!/target="_blank"(?![^>]*rel="noopener noreferrer")/.test(code.replace(/\{\.\.\.\(isExternalHref[^}]*\}\)/g, "")), `${f} must open outside links with rel="noopener noreferrer"`);
  }
});

test("the dashboard never calls a new third party host: only the Worker", () => {
  for (const f of ["lib/connectorsApi.ts", "lib/healthApi.ts"]) {
    const text = readFileSync(join(__dirname, "..", f), "utf8");
    assert.ok(!/https?:\/\/(?!\/)/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/`\$\{[^}]*\}[^`]*`/g, "")), `${f} must not name a host`);
  }
});
