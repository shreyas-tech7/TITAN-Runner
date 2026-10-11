/**
 * Client for the titan-runner-brain Cloudflare Worker (build brief,
 * sections 1-5). Every call carries the admin token as `X-Titan-Auth`;
 * `UNAUTHORIZED` is thrown as a distinguishable error so `AdminGate` can
 * react to a wrong/revoked token specifically, the same never-silent-
 * redirect spirit as `lib/githubApi.ts`'s `GitHubApiError`.
 *
 * `NEXT_PUBLIC_TITAN_WORKER_URL` is empty until the Worker is actually
 * deployed and this is filled in (see docs/RUNTIME.md and the build
 * brief's manual-steps list) — every function here fails with a clear,
 * catchable message rather than a raw fetch error against an empty URL.
 */

import { PROVIDER_CATALOG } from "./providers";
import { handleDemoWorkerCall, isDemoMode } from "./demoFixtures";

const WORKER_URL = (process.env.NEXT_PUBLIC_TITAN_WORKER_URL || "").trim();

export function isWorkerConfigured(): boolean {
  return WORKER_URL.length > 0 || isDemoMode();
}

/** The public address of the Worker, without a trailing slash. It is empty when no Worker is set. It is not a secret. */
export function workerUrl(): string {
  return WORKER_URL.replace(/\/$/, "");
}

/** The providers that can run a sub-agent task by name: the direct adapters and the custom slots. The list comes from
 * the provider catalog (`config/providers.catalog.json`), the one source of truth. */
export const KNOWN_PROVIDERS: string[] = PROVIDER_CATALOG.filter((p) => p.failover !== null).map((p) => p.id);
export type KnownProvider = string;

export type SubagentStatus = "queued" | "dispatched" | "running" | "done" | "failed";

export interface SubagentRow {
  id: string;
  task_type: string;
  brief: string;
  status: SubagentStatus;
  source: "github-issue" | "dashboard" | "meta-agent";
  provider: string | null;
  queued_at: string;
  dispatched_at?: string | null;
  retry_count?: number;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  run_url: string | null;
  tokens_used: number | null;
}

export interface ProviderKeyMetaRow {
  provider: string;
  configured: 0 | 1;
  updated_at: string | null;
}

export interface LearningPathRow {
  id: number;
  subagent_id: string;
  topic: string;
  tree: string; // JSON: {topic, prerequisites:[{topic,reason}], resources:[string]}
  created_at: string;
}

export interface StatusResponse {
  subagents: SubagentRow[];
  providers: ProviderKeyMetaRow[];
  learningPaths: LearningPathRow[];
  generatedAt: string;
}

export interface OsintToolRow {
  name: string;
  category: string;
  url: string;
  description: string | null;
}

export interface GeospatialEventRow {
  id: number;
  investigation_id: string;
  subagent_id: string;
  label: string;
  lat: number | null;
  lon: number | null;
  ip: string | null;
  confidence: "low" | "medium" | "high" | null;
  recorded_at: string;
}

export interface SystemMemoryRow {
  id: number;
  category: string;
  lesson: string;
  prompt_injection: string;
  created_at: string;
}

export type VmStatus = "requested" | "provisioning" | "live" | "claimed" | "expired" | "failed";

export interface VmRow {
  id: string;
  subagent_id: string | null;
  brief: string | null;
  status: VmStatus;
  provider: string;
  region: string | null;
  vcpu: number | null;
  ram_mb: number | null;
  preview_url: string | null;
  claim_url: string | null;
  build_deadline: string | null;
  claim_deadline: string | null;
  run_url: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string | null;
}

export class WorkerApiError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "WorkerApiError";
    this.status = status;
  }
}

export async function callWorker(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  if (isDemoMode() || token === "demo-token") {
    return handleDemoWorkerCall(path, init);
  }
  if (!WORKER_URL) {
    throw new WorkerApiError("The titan-runner-brain Worker isn't configured yet (NEXT_PUBLIC_TITAN_WORKER_URL is empty) — see docs/RUNTIME.md.");
  }
  let res: Response;
  try {
    res = await fetch(`${WORKER_URL.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Titan-Auth": token, ...(init.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new WorkerApiError("Could not reach the titan-runner-brain Worker. Check your connection.");
  }
  if (res.status === 401) throw new WorkerApiError("Unauthorized — the admin token was rejected.", 401);
  return res;
}

export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  // The Worker puts a short reason in `message` and a code in `error`. It also sends a request id (Wave 12, R5), so a person
  // can quote it. The id appears at the end of every error text.
  const header = res.headers.get("X-Request-Id");
  try {
    const body = (await res.json()) as { error?: string; message?: string; requestId?: string };
    const text = body?.message || body?.error || fallback;
    const id = header || body?.requestId;
    return id && !text.includes(id) ? `${text} (request id ${id})` : text;
  } catch {
    return header ? `${fallback} (request id ${header})` : fallback;
  }
}

export async function fetchStatus(token: string): Promise<StatusResponse> {
  const res = await callWorker("/status", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

/** POST /tasks/:id/retry: a failed or stuck task goes back to queued (Wave 12, K9). */
export async function retryTask(token: string, id: string): Promise<{ ok: true; id: string }> {
  const res = await callWorker(`/tasks/${encodeURIComponent(id)}/retry`, token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function queueTask(token: string, taskType: string, brief: string): Promise<{ ok: true; id: string }> {
  const res = await callWorker("/tasks", token, {
    method: "POST",
    body: JSON.stringify({ task_type: taskType, brief }),
  });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function setProviderKey(token: string, provider: string, value: string): Promise<{ ok: true }> {
  const res = await callWorker("/admin/keys", token, {
    method: "POST",
    body: JSON.stringify({ provider, value }),
  });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

/** A read-only GITHUB_PAT self-test (GET /admin/diagnose) — lets the admin
 * confirm the Worker can actually reach GitHub's secrets API before
 * pasting a real provider key. Always resolves with {ok, error?}: a failed
 * diagnosis is a successful diagnosis, not a thrown WorkerApiError. */
export async function diagnoseGithubPat(token: string): Promise<{ ok: boolean; error?: string }> {
  const res = await callWorker("/admin/diagnose", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export interface GevTokenResponse {
  token: string;
  expires_at: string;
  ttl_seconds: number;
}

/** A short lived (about five minute) access link credential for the God's Eye
 * View tab (GET /gev/token). The TITAN-GEV host trades it for a session
 * cookie. A 503 with `gev_not_configured` means the Worker has no
 * GEV_SIGNING_KEY yet. */
export async function fetchGevToken(token: string): Promise<GevTokenResponse> {
  const res = await callWorker("/gev/token", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

// ---------------------------------------------------------------------
// Phase 2 — OSINT catalog + owner-gated investigation. Every call here
// carries the same admin token as everything else — POST /osint/investigate
// is the ONLY way an OSINT-category task can ever be created (see
// worker/src/index.js's own doc comment); it is never reachable from a
// public GitHub issue.
// ---------------------------------------------------------------------

export async function fetchOsintTools(token: string, category: string, q: string): Promise<{ tools: OsintToolRow[] }> {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (q) params.set("q", q);
  const res = await callWorker(`/osint/tools?${params.toString()}`, token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function investigateOsint(
  token: string,
  targetLabel: string,
  category: string,
): Promise<{ ok: true; id: string; tool: string | null }> {
  const res = await callWorker("/osint/investigate", token, {
    method: "POST",
    body: JSON.stringify({ target_label: targetLabel, category }),
  });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function ingestOsintTools(token: string): Promise<{ ok: true; parsed: number; inserted: number }> {
  const res = await callWorker("/admin/osint/ingest", token, { method: "POST" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

// ---------------------------------------------------------------------
// Phase 3 — the God's Eye geospatial feed. Reads only what
// POST /internal/geospatial-event was willing to write, so this is exactly
// as gated as that route (see worker/src/index.js).
// ---------------------------------------------------------------------

export async function fetchGeospatialEvents(token: string): Promise<{ events: GeospatialEventRow[]; generatedAt: string }> {
  const res = await callWorker("/geospatial/events", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

// ---------------------------------------------------------------------
// Phase 5 — Hermes system memory (read-only from the dashboard's side;
// only run-subagent-task.mjs's meta-lesson analysis ever writes it).
// ---------------------------------------------------------------------

export async function fetchSystemMemory(token: string): Promise<{ lessons: SystemMemoryRow[] }> {
  const res = await callWorker("/system-memory", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

// ---------------------------------------------------------------------
// VM fleet — Railway free VMs (ssh railway.new). A VM is provisioned by the
// vm-agent workflow on a GitHub runner (never by the Worker or the browser);
// these two calls just file a request and read the fleet. Same admin-token
// gate as everything else.
// ---------------------------------------------------------------------

export async function fetchVms(token: string): Promise<{ vms: VmRow[]; generatedAt: string }> {
  const res = await callWorker("/vms", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function provisionVm(token: string, brief: string): Promise<{ ok: true; id: string }> {
  const res = await callWorker("/vms/provision", token, {
    method: "POST",
    body: JSON.stringify({ brief }),
  });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

// ---------------------------------------------------------------------
// Wave 12 Release 3 — Instant Chat (A1), Schedules (A2), Daily Brief (A3),
// Pulse Approvals (A4/T4), Activity Timeline (A5), and MCP OAuth 2.1 (M5)
// ---------------------------------------------------------------------

export interface ChatProviderOption {
  id: string;
  label: string;
  defaultModel: string;
  models: string[];
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  provider: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  ms: number | null;
  at: string;
}

export async function fetchChatThreads(token: string): Promise<{
  ready: boolean;
  providers: ChatProviderOption[];
  threads: ChatThreadSummary[];
}> {
  const res = await callWorker("/chat/threads", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function fetchChatThread(
  token: string,
  threadId: string,
): Promise<{ thread: ChatThreadSummary; messages: ChatMessageRow[] }> {
  const res = await callWorker(`/chat/threads/${encodeURIComponent(threadId)}`, token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function deleteChatThread(token: string, threadId: string): Promise<{ ok: true }> {
  const res = await callWorker(`/chat/threads/${encodeURIComponent(threadId)}`, token, { method: "DELETE" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function clearChatHistory(token: string): Promise<{ ok: true }> {
  const res = await callWorker("/chat/threads", token, { method: "DELETE" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function saveChatProviderOrder(token: string, order: string[]): Promise<{ ok: true; order: string[] }> {
  const res = await callWorker("/chat/order", token, { method: "POST", body: JSON.stringify({ order }) });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export interface ScheduleRecord {
  id: string;
  label: string;
  cron: string;
  tz: string;
  kind: "task" | "brief";
  taskType: string;
  brief: string;
  enabled: boolean;
  builtIn: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  nextRuns: string[];
  lastStatus: string | null;
  lastError: string | null;
}

export async function fetchSchedules(token: string): Promise<{ schedules: ScheduleRecord[] }> {
  const res = await callWorker("/schedules", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function createSchedule(
  token: string,
  body: { label: string; cron: string; tz: string; brief: string; taskType?: string },
): Promise<{ schedule: ScheduleRecord }> {
  const res = await callWorker("/schedules", token, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function toggleSchedule(
  token: string,
  id: string,
  enabled?: boolean,
): Promise<{ schedule: ScheduleRecord }> {
  const res = await callWorker(`/schedules/${encodeURIComponent(id)}/toggle`, token, {
    method: "POST",
    body: JSON.stringify(typeof enabled === "boolean" ? { enabled } : {}),
  });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function runScheduleNow(token: string, id: string): Promise<{ ok: true; taskId?: string }> {
  const res = await callWorker(`/schedules/${encodeURIComponent(id)}/run`, token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function deleteSchedule(token: string, id: string): Promise<{ ok: true }> {
  const res = await callWorker(`/schedules/${encodeURIComponent(id)}`, token, { method: "DELETE" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export interface DailyBriefRecord {
  date: string;
  generatedAt: string;
  weather: string | null;
  calendar: string[];
  tasks: { done: number; failed: number; running: number };
  pendingApprovals: number;
  keysNeedingCare: string[];
  researchDigest: string | null;
  healthOk: boolean;
  aiSummary: string | null;
  text: string;
}

export async function fetchDailyBrief(token: string): Promise<{ brief: DailyBriefRecord | null }> {
  const res = await callWorker("/brief", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function generateDailyBriefNow(
  token: string,
  send = false,
): Promise<{ brief: DailyBriefRecord }> {
  const res = await callWorker("/brief/generate", token, { method: "POST", body: JSON.stringify({ send }) });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function decidePulseApproval(
  token: string,
  issueNumber: number,
  key: string,
  decision: "approve" | "deny",
): Promise<{ ok: true; issueNumber: number; key: string; decision: string; command: string }> {
  const res = await callWorker("/approvals/pulse", token, {
    method: "POST",
    body: JSON.stringify({ issueNumber, key, decision }),
  });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export interface ActivityItem {
  id: string;
  kind: "task" | "key" | "connector" | "approval" | "schedule" | "deploy" | "event";
  at: string;
  title: string;
  detail: string | null;
  status: string;
}

export async function fetchActivity(token: string, kind = "", limit = 50): Promise<{ items: ActivityItem[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (kind) params.set("kind", kind);
  const res = await callWorker(`/activity?${params.toString()}`, token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function cancelTask(token: string, id: string): Promise<{ ok: true; id: string; cancelled: boolean }> {
  const res = await callWorker(`/tasks/${encodeURIComponent(id)}/cancel`, token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

export async function approveMcpOauth(
  token: string,
  body: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state?: string;
    scopes: string[];
  },
): Promise<{ ok: true; code: string; redirectTo: string }> {
  const res = await callWorker("/oauth/mcp/authorize", token, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

