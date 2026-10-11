/**
 * The connector, approval, MCP token, and notification routes of the Worker (Wave 12, Tracks C, M, and T).
 *
 * A secret goes out in one request body, over https, and nowhere else. This file never logs a body, never keeps a value, and
 * never puts a value in a URL. The Worker never returns a secret, so no type here has a field for one. Two answers show a
 * value one time: a new MCP token and a new hook secret. The page that asks for them shows the value once and drops it.
 */
import { callWorker, readErrorMessage, WorkerApiError } from "./workerApi";

export type Risk = "read" | "write" | "destructive";
export type DataClass = "public" | "internal" | "personal";
export type ConnectionStatus = "connected" | "unverified" | "error" | "needs_reconnect" | "needs_authorization";
export type PolicyMode = "auto" | "ask" | "deny";

export interface ConnectorField {
  name: string;
  label: string;
  secret: boolean;
  optional: boolean;
  help: string;
  placeholder: string;
  default: string;
}

/** A small subset of JSON Schema. It is all that the manifests use. */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: Array<string | number>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  default?: unknown;
  format?: string;
}

export interface ConnectorAction {
  id: string;
  title: string;
  description: string;
  risk: Risk;
  dataClass: DataClass;
  input: JsonSchema;
  rateLimit: { perMinute: number } | null;
}

export interface ConnectionView {
  id: string;
  connectorId: string;
  label: string;
  status: ConnectionStatus;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMs: number | null;
  lastError: string | null;
  createdAt: string;
  config: Record<string, string>;
  secretNames: string[];
  meta: Record<string, unknown>;
  ownerPaired: boolean;
  policies: Record<string, PolicyMode>;
}

export interface ConnectorView {
  id: string;
  name: string;
  icon: string;
  version: string;
  category: string;
  description: string;
  docsUrl: string;
  getKeyUrl: string;
  apiVersion: string;
  auth: { kind: string; setupNote: string; fields: ConnectorField[]; oauth?: { scopes: string[] } };
  egress: string[];
  testMode: string;
  triggers: string[];
  actions: ConnectorAction[];
  connections: ConnectionView[];
}

export interface CatalogResponse {
  vault: { ready: boolean; fix: string | null };
  connectors: ConnectorView[];
  requestId: string;
}

export interface TestResult {
  ok: boolean | null;
  skipped?: boolean;
  ms: number;
  status?: number;
  error?: string;
  message?: string;
  code?: string;
  data?: unknown;
}

export interface CallRow {
  id?: number;
  at: string;
  actionId: string;
  caller: string;
  outcome: string;
  httpStatus: number | null;
  ms: number | null;
  error: string | null;
}

export interface HookInfo {
  hookId: string;
  hookUrl: string;
  mode: string;
  target: string;
  calls: number;
  lastEventAt: string | null;
  events: Array<{ at: string; bytes: number; outcome: string; title: string | null }>;
}

export interface RemoteTool {
  name: string;
  description?: string;
  risk: Risk;
}

export interface ConnectionDetail {
  connection: ConnectionView;
  connector: Omit<ConnectorView, "connections">;
  calls: CallRow[];
  hook?: HookInfo | null;
  tools?: RemoteTool[];
  redirectUri?: string;
  requestId: string;
}

export interface Approval {
  id: string;
  connectionId: string;
  connectorId: string;
  actionId: string;
  risk: Risk;
  dataClass: DataClass;
  summary: string;
  requestedBy: string;
  status: "pending" | "approved" | "denied" | "expired" | "executed" | "failed";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  result: unknown;
  error: string | null;
}

export interface McpToken {
  id: string;
  label: string;
  scopes: string[];
  kind: string;
  clientId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface NotifyRule {
  id: string;
  label: string;
  eventPattern: string;
  minSeverity: "info" | "warn" | "error";
  connectionIds: string[];
  quietStart: string | null;
  quietEnd: string | null;
  tz: string;
  dedupeMinutes: number;
  allowPersonal: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface EventRow {
  id: number;
  at: string;
  type: string;
  severity: "info" | "warn" | "error";
  title: string;
  body: string | null;
  source: string | null;
}

async function getJson<T>(path: string, token: string): Promise<T> {
  const res = await callWorker(path, token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return (await res.json()) as T;
}

async function sendJson<T>(path: string, token: string, method: "POST" | "DELETE", body: unknown = {}): Promise<T> {
  const res = await callWorker(path, token, { method, body: JSON.stringify(body) });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return (await res.json()) as T;
}

// --- catalog and connections -----------------------------------------------------------------------------------

export const fetchCatalog = (token: string) => getJson<CatalogResponse>("/connectors", token);
export const fetchConnection = (token: string, id: string) => getJson<ConnectionDetail>(`/connections/${encodeURIComponent(id)}`, token);
export const fetchCalls = (token: string, id: string, limit = 50) => getJson<{ calls: CallRow[] }>(`/connections/${encodeURIComponent(id)}/calls?limit=${limit}`, token);

export type ConnectOutcome =
  | { kind: "connected"; connection: ConnectionView; test: TestResult; needsAuthorization: boolean; hook?: { hookId: string; hookUrl: string; hookSecret: string; mode: string }; bot?: { username?: string; webhookSet?: boolean }; tools?: RemoteTool[]; extras: Record<string, unknown> }
  | { kind: "test_failed"; message: string; test: TestResult }
  | { kind: "failed"; status: number; error: string; message: string; fix: string | null; errors: string[] };

/** Connect a tool. The fields hold the secrets. The outcome never repeats one, except the one-time hook secret. */
export async function connectTool(token: string, connectorId: string, body: { label?: string; fields: Record<string, string>; saveIfUnverified?: boolean }): Promise<ConnectOutcome> {
  const res = await callWorker(`/connectors/${encodeURIComponent(connectorId)}/connect`, token, { method: "POST", body: JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // A body that is not JSON falls through to the generic failure below.
  }
  if (res.status === 201 && json.connection) {
    const { connection, test, needsAuthorization, ...extras } = json as { connection: ConnectionView; test: TestResult; needsAuthorization?: boolean } & Record<string, unknown>;
    return {
      kind: "connected",
      connection,
      test: test ?? { ok: null, ms: 0 },
      needsAuthorization: needsAuthorization === true,
      hook: extras.hookSecret ? { hookId: String(extras.hookId), hookUrl: String(extras.hookUrl), hookSecret: String(extras.hookSecret), mode: String(extras.mode ?? "") } : undefined,
      bot: extras.botUsername || extras.webhookSet !== undefined ? { username: extras.botUsername ? String(extras.botUsername) : undefined, webhookSet: extras.webhookSet === true } : undefined,
      tools: Array.isArray(extras.tools) ? (extras.tools as RemoteTool[]) : undefined,
      extras,
    };
  }
  if (res.status === 401) throw new WorkerApiError("Unauthorized — the admin token was rejected.", 401);
  if (res.status === 422 && json.error === "test_failed") return { kind: "test_failed", message: String(json.message ?? "The test failed."), test: (json.test as TestResult) ?? { ok: false, ms: 0 } };
  return {
    kind: "failed",
    status: res.status,
    error: String(json.error ?? "error"),
    message: String(json.message ?? `The Worker answered ${res.status}.`),
    fix: typeof json.fix === "string" ? json.fix : null,
    errors: Array.isArray(json.errors) ? (json.errors as string[]) : [],
  };
}

export const testConnectionNow = (token: string, id: string, send = false) => sendJson<TestResult & { connectionId: string }>(`/connections/${encodeURIComponent(id)}/test`, token, "POST", { send });
export const renameConnection = (token: string, id: string, label: string) => sendJson<{ connection: ConnectionView }>(`/connections/${encodeURIComponent(id)}/rename`, token, "POST", { label });
export const disconnectConnection = (token: string, id: string) => sendJson<{ ok: boolean; warnings?: string[] }>(`/connections/${encodeURIComponent(id)}/disconnect`, token, "POST", {});
export const setActionPolicy = (token: string, id: string, actionId: string, mode: PolicyMode) => sendJson<{ ok: true }>(`/connections/${encodeURIComponent(id)}/policy`, token, "POST", { actionId, mode });
export const rotateHook = (token: string, id: string) => sendJson<{ hookId: string; hookSecret: string; secretShownOnce: boolean }>(`/connections/${encodeURIComponent(id)}/hook/rotate`, token, "POST", {});
export const setToolRisk = (token: string, id: string, name: string, risk: Risk) => sendJson<{ ok: true }>(`/connections/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}/risk`, token, "POST", { risk });
export const telegramPair = (token: string, id: string) => sendJson<{ code: string; expiresAt: string; minutes: number; botUsername: string | null; instruction: string }>(`/connections/${encodeURIComponent(id)}/telegram/pair`, token, "POST", {});
export const telegramUnpair = (token: string, id: string) => sendJson<{ ok: true }>(`/connections/${encodeURIComponent(id)}/telegram/unpair`, token, "POST", {});
export const beginOAuth = (token: string, connectorId: string, connectionId: string) => sendJson<{ authorizeUrl: string; redirectUri?: string }>(`/oauth/${encodeURIComponent(connectorId)}/begin`, token, "POST", { connectionId });

export type ActionOutcome =
  | { kind: "done"; data: unknown; status?: number; ms?: number; truncated?: boolean }
  | { kind: "pending"; approvalId: string }
  | { kind: "error"; message: string; status?: number };

/** Run one action. A `read` action runs at once. A `write` action may wait for approval, and a `destructive` one needs the typed confirm. */
export async function runAction(token: string, connectionId: string, actionId: string, input: Record<string, unknown>, confirm?: string): Promise<ActionOutcome> {
  const res = await callWorker(`/connections/${encodeURIComponent(connectionId)}/actions/${encodeURIComponent(actionId)}`, token, { method: "POST", body: JSON.stringify({ input, ...(confirm ? { confirm } : {}) }) });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // fall through
  }
  if (res.status === 202 && json.state === "pending_approval") return { kind: "pending", approvalId: String(json.approvalId) };
  if (res.ok && json.state === "done") return { kind: "done", data: json.data, status: json.status as number | undefined, ms: json.ms as number | undefined, truncated: json.truncated === true };
  if (res.ok) return { kind: "error", message: String(json.error ?? "The tool refused the call."), status: json.status as number | undefined };
  return { kind: "error", message: String(json.message ?? json.error ?? `The Worker answered ${res.status}.`), status: res.status };
}

// --- approvals --------------------------------------------------------------------------------------------------

export const fetchApprovals = (token: string, status?: string) => getJson<{ approvals: Approval[] }>(`/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`, token);
export const decideApproval = (token: string, id: string, decision: "approve" | "deny") => sendJson<Approval & { executed: boolean }>(`/approvals/${encodeURIComponent(id)}/${decision}`, token, "POST", {});

// --- MCP tokens -------------------------------------------------------------------------------------------------

export const fetchMcpTokens = (token: string) => getJson<{ tokens: McpToken[]; scopes: string[] }>("/admin/mcp/tokens", token);
export const createMcpToken = (token: string, body: { label: string; scopes: string[]; expiresInDays?: number }) =>
  sendJson<{ id: string; token: string; label: string; scopes: string[]; expiresAt: string | null; shownOnce: boolean }>("/admin/mcp/tokens", token, "POST", body);
export const revokeMcpToken = (token: string, id: string) => sendJson<{ ok: true }>(`/admin/mcp/tokens/${encodeURIComponent(id)}`, token, "DELETE", {});

// --- notification rules and events ------------------------------------------------------------------------------

export const fetchRules = (token: string) => getJson<{ rules: NotifyRule[]; eventTypes: string[] }>("/admin/notify/rules", token);
export const saveRule = (token: string, rule: Partial<NotifyRule> & { connectionIds: string[]; eventPattern: string }) => sendJson<{ rule: NotifyRule }>("/admin/notify/rules", token, "POST", rule);
export const deleteRule = (token: string, id: string) => sendJson<{ ok: true }>(`/admin/notify/rules/${encodeURIComponent(id)}`, token, "DELETE", {});
export const applyRulePreset = (token: string, connectionId: string) => sendJson<{ made: NotifyRule[] }>("/admin/notify/preset", token, "POST", { connectionId });
export const sendChannelTest = (token: string, connectionId: string) => sendJson<{ ok: boolean; error?: string }>("/admin/notify/test", token, "POST", { connectionId });
export const fetchEvents = (token: string, limit = 50) => getJson<{ events: EventRow[] }>(`/admin/events?limit=${limit}`, token);
