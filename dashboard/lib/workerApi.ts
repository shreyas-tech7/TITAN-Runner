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

const WORKER_URL = (process.env.NEXT_PUBLIC_TITAN_WORKER_URL || "").trim();

export function isWorkerConfigured(): boolean {
  return WORKER_URL.length > 0;
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
  try {
    const body = (await res.json()) as { error?: string };
    return body?.error || fallback;
  } catch {
    return fallback;
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
