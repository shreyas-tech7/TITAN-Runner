/**
 * The words, tones, and rules of the Connectors page (Wave 12, C4). Pure functions, so the tests need no browser.
 * A label tells the truth: a connection that was saved but never tested does not read "Connected".
 */
import type { ConnectionStatus, ConnectionView, ConnectorAction, ConnectorView, DataClass, JsonSchema, PolicyMode, Risk } from "./connectorsApi";
import type { Tone } from "@/components/kit";

export type CardState = "connected" | "attention" | "none" | "setup";

export const CARD_STATE_META: Record<CardState, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "ok" },
  attention: { label: "Needs attention", tone: "warn" },
  none: { label: "Not connected", tone: "neutral" },
  setup: { label: "Setup needed", tone: "corona" },
};

export const CONNECTION_STATUS_META: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "ok" },
  unverified: { label: "Saved, not verified", tone: "warn" },
  error: { label: "Needs attention", tone: "danger" },
  needs_reconnect: { label: "Needs a new sign in", tone: "warn" },
  needs_authorization: { label: "Approve the access", tone: "corona" },
};

export const RISK_META: Record<Risk, { label: string; tone: Tone; help: string }> = {
  read: { label: "Read", tone: "ion", help: "Reads data. It changes nothing." },
  write: { label: "Write", tone: "warn", help: "Changes data. A sub-agent needs your approval first." },
  destructive: { label: "Destructive", tone: "danger", help: "Deletes or overwrites data. Only you can run it, and you must type a confirm." },
};

export const DATA_CLASS_META: Record<DataClass, { label: string; tone: Tone; help: string }> = {
  public: { label: "Public data", tone: "neutral", help: "Public data. Safe to log." },
  internal: { label: "Internal data", tone: "plasma", help: "Data about TITAN or your accounts. It never goes to a public log." },
  personal: { label: "Personal data", tone: "corona", help: "Mail, calendar, notes, or chat. Only you can read it. A sub-agent cannot." },
};

export const POLICY_LABEL: Record<PolicyMode, string> = { auto: "Runs on its own", ask: "Asks first", deny: "Off" };

const CATEGORY_ORDER = ["notify", "productivity", "dev", "data", "ai", "automation", "custom"];
export const CATEGORY_LABEL: Record<string, string> = {
  notify: "Notify",
  productivity: "Productivity",
  dev: "Developer",
  data: "Data",
  ai: "AI",
  automation: "Automation",
  custom: "Custom",
};

export interface CardView {
  state: CardState;
  label: string;
  tone: Tone;
  detail: string;
  count: number;
  lastTestAt: string | null;
}

/** One state for a card, from all the connections of a connector. The worst state wins. */
export function cardView(connector: ConnectorView, vaultReady: boolean): CardView {
  const conns = connector.connections;
  const lastTestAt = conns.map((c) => c.lastTestAt).filter((x): x is string => Boolean(x)).sort().pop() ?? null;
  const needsVault = connector.auth.kind !== "none";
  const make = (state: CardState, detail: string): CardView => ({ state, ...CARD_STATE_META[state], detail, count: conns.length, lastTestAt });

  if (conns.length === 0) {
    if (needsVault && !vaultReady) return make("setup", "The vault is not ready. Set it up first.");
    return make("none", connector.description);
  }
  const waiting = conns.find((c) => c.status === "needs_authorization");
  if (waiting) return make("setup", "Approve the access to finish.");
  const bad = conns.find((c) => c.status === "error" || c.status === "needs_reconnect" || c.status === "unverified" || c.lastTestOk === false);
  if (bad) return make("attention", bad.lastError || CONNECTION_STATUS_META[bad.status].label);
  return make("connected", conns.length === 1 ? conns[0].label : `${conns.length} connections`);
}

const STATE_RANK: Record<CardState, number> = { attention: 0, setup: 1, connected: 2, none: 3 };

export interface Filter {
  query: string;
  category: string;
}

/** Search the name, the description, the id, and the category. Cards that need a look come first. */
export function filterConnectors(list: ConnectorView[], filter: Filter, vaultReady: boolean): ConnectorView[] {
  const q = filter.query.trim().toLowerCase();
  return list
    .filter((c) => (filter.category === "all" || c.category === filter.category) && (!q || `${c.name} ${c.id} ${c.description} ${c.category}`.toLowerCase().includes(q)))
    .map((c) => ({ c, rank: STATE_RANK[cardView(c, vaultReady).state] }))
    .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}

/** The categories that exist, in a fixed order. */
export function categoriesOf(list: ConnectorView[]): string[] {
  const present = new Set(list.map((c) => c.category));
  return [...CATEGORY_ORDER.filter((c) => present.has(c)), ...[...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort()];
}

export function connectedCount(list: ConnectorView[]): number {
  return list.reduce((n, c) => n + c.connections.filter((x) => x.status === "connected").length, 0);
}

/** Every connection that has a secret behind it and a test to run. */
export function testableConnections(list: ConnectorView[]): ConnectionView[] {
  return list.filter((c) => c.testMode !== "none").flatMap((c) => c.connections.filter((x) => x.status !== "needs_authorization"));
}

/** A connection that sends a message when tested. The page asks first, so a test never posts by surprise. */
export function testSends(connector: Pick<ConnectorView, "testMode">): boolean {
  return connector.testMode === "onClick";
}

// ---------------------------------------------------------------------
// The connect form
// ---------------------------------------------------------------------

export interface FieldProblem {
  name: string;
  message: string;
}

/** Check the connect form before it goes out. The Worker checks again. */
export function connectProblems(connector: ConnectorView, values: Record<string, string>): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const f of connector.auth.fields) {
    const v = (values[f.name] ?? "").trim();
    if (!v && f.default) continue;
    if (!v && !f.optional) problems.push({ name: f.name, message: `Fill in "${f.label}".` });
  }
  return problems;
}

/** Only the fields with a value go to the Worker. A field with a default and no value is left out, so the Worker applies it. */
export function connectFields(connector: ConnectorView, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of connector.auth.fields) {
    const v = (values[f.name] ?? "").trim();
    if (v) out[f.name] = v;
  }
  return out;
}

// ---------------------------------------------------------------------
// The "Try it" form, made from a JSON Schema
// ---------------------------------------------------------------------

export type FormKind = "text" | "textarea" | "number" | "integer" | "boolean" | "select" | "list" | "json";

export interface FormField {
  name: string;
  label: string;
  kind: FormKind;
  required: boolean;
  help: string;
  options: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  initial: string;
}

const titleOf = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function fieldsFromSchema(schema: JsonSchema | undefined): FormField[] {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.entries(props).map(([name, s]) => {
    let kind: FormKind = "text";
    if (s.enum) kind = "select";
    else if (s.type === "boolean") kind = "boolean";
    else if (s.type === "integer") kind = "integer";
    else if (s.type === "number") kind = "number";
    else if (s.type === "array" && (!s.items || s.items.type === "string")) kind = "list";
    else if (s.type === "array" || s.type === "object") kind = "json";
    else if (s.type === "string" && (s.maxLength ?? 0) > 200) kind = "textarea";
    return {
      name,
      label: titleOf(name),
      kind,
      required: required.has(name),
      help: s.description ?? "",
      options: (s.enum ?? []).map(String),
      min: s.minimum,
      max: s.maximum,
      maxLength: s.maxLength,
      initial: s.default === undefined ? "" : typeof s.default === "object" ? JSON.stringify(s.default) : String(s.default),
    };
  });
}

export type BuiltInput = { ok: true; input: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** Turn the form values into the input object of an action. An empty optional field is left out. */
export function buildInput(fields: FormField[], values: Record<string, string>): BuiltInput {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = values[f.name] ?? f.initial;
    const text = f.kind === "textarea" || f.kind === "json" ? raw : raw.trim();
    if (f.kind === "boolean") {
      if (raw === "true") input[f.name] = true;
      else if (raw === "false" && f.required) input[f.name] = false;
      else if (f.required && raw !== "false") errors[f.name] = `Choose a value for "${f.label}".`;
      continue;
    }
    if (!text.trim()) {
      if (f.required) errors[f.name] = `Fill in "${f.label}".`;
      continue;
    }
    switch (f.kind) {
      case "number":
      case "integer": {
        const n = Number(text);
        if (!Number.isFinite(n) || (f.kind === "integer" && !Number.isInteger(n))) errors[f.name] = `"${f.label}" must be ${f.kind === "integer" ? "a whole number" : "a number"}.`;
        else if (f.min !== undefined && n < f.min) errors[f.name] = `"${f.label}" must be ${f.min} or more.`;
        else if (f.max !== undefined && n > f.max) errors[f.name] = `"${f.label}" must be ${f.max} or less.`;
        else input[f.name] = n;
        break;
      }
      case "list":
        input[f.name] = text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
        break;
      case "json":
        try {
          input[f.name] = JSON.parse(text);
        } catch {
          errors[f.name] = `"${f.label}" must be valid JSON.`;
        }
        break;
      case "select":
        if (f.options.length > 0 && !f.options.includes(text)) errors[f.name] = `Choose one of the listed values for "${f.label}".`;
        else input[f.name] = text;
        break;
      default:
        if (f.maxLength && text.length > f.maxLength) errors[f.name] = `"${f.label}" can hold ${f.maxLength} characters.`;
        else input[f.name] = text;
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, input };
}

/** The actions that "Try it" may run from the drawer: reads only. A write or a destructive action has its own button and its own rules. */
export const tryableActions = (connector: Pick<ConnectorView, "actions">): ConnectorAction[] => connector.actions.filter((a) => a.risk === "read");

/** The text for the confirm of a destructive action. It is the same text that the Worker expects. */
export const confirmText = (connectorId: string, actionId: string) => `${connectorId}.${actionId}`;

// ---------------------------------------------------------------------
// MCP: "Use TITAN from Claude" (M4)
// ---------------------------------------------------------------------

/** The Claude Code command. It holds a placeholder for the token and never a real one. */
export function claudeCodeCommand(workerUrl: string): string {
  const base = workerUrl.trim().replace(/\/$/, "") || "<WORKER_URL>";
  return `claude mcp add --transport http titan ${base}/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"`;
}

export const SCOPE_HELP: Record<string, string> = {
  "status:read": "Read the status of tasks and the pulse.",
  "tasks:write": "Queue a new task.",
  "connectors:read": "Run read actions on your connections.",
  "connectors:write": "Run write actions. A write action may still wait for your approval.",
  "personal:read": "Read personal data such as the calendar and mail.",
  "notify:write": "Send a message to your notification channels.",
  "chat:write": "Use instant chat.",
};

/** Tokens that carry a broad right are marked, so a person sees what a token can do. */
export const SENSITIVE_SCOPES = ["connectors:write", "personal:read", "tasks:write"];

export function describeExpiry(expiresAt: string | null, revokedAt: string | null, now = Date.now()): string {
  if (revokedAt) return "Revoked";
  if (!expiresAt) return "Does not expire";
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return "Expired";
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 1) return "Expires in less than an hour";
  if (hours < 24) return `Expires in ${hours} hours`;
  const days = Math.ceil(ms / 86_400_000);
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** The address to register with the OAuth provider. It is the Worker, not the dashboard. */
export const redirectUriFor = (connectorId: string, workerUrl: string) => `${workerUrl.trim().replace(/\/$/, "") || "<WORKER_URL>"}/oauth/${connectorId}/callback`;

/** Whether the Google refresh token limit applies to this connector. See docs/CONNECTORS.md. */
export const isGoogleOAuth = (connectorId: string) => connectorId === "google_calendar" || connectorId === "gmail";

/** The connectors that can carry a notification. The list matches `isChannel` in the Worker. */
export const CHANNEL_CONNECTORS = ["telegram", "discord_webhook", "slack_webhook", "ntfy", "webhook_out"];

/** The events and patterns that a rule may name. The Worker checks the pattern again. */
export const RULE_PATTERNS = ["*", "task.*", "task.failed", "task.done", "approval.needed", "key.invalid", "key.proven", "callback.broken", "pulse.late", "connector.needs_reconnect", "brief.daily", "schedule.fired"];

export const SEVERITY_LABEL: Record<string, string> = { info: "Info and above", warn: "Warning and above", error: "Errors only" };

/** A short line for a rule, for the table and for the tests. */
export function describeRule(rule: { eventPattern: string; minSeverity: string; quietStart: string | null; quietEnd: string | null; tz: string; dedupeMinutes: number }): string {
  const quiet = rule.quietStart && rule.quietEnd ? `Quiet ${rule.quietStart} to ${rule.quietEnd} (${rule.tz}). Errors still go out.` : "No quiet hours.";
  return `${rule.eventPattern} · ${SEVERITY_LABEL[rule.minSeverity] ?? rule.minSeverity} · ${quiet} · Same message once in ${rule.dedupeMinutes} min.`;
}
