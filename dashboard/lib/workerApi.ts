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

const WORKER_URL = (process.env.NEXT_PUBLIC_TITAN_WORKER_URL || "").trim();

export function isWorkerConfigured(): boolean {
  return WORKER_URL.length > 0;
}

/** The five adapters this repo already has — must match
 * `src/providers/registry.js`'s `FAILOVER_ORDER` and the Worker's own
 * `KNOWN_PROVIDERS` exactly. */
export const KNOWN_PROVIDERS = ["groq", "together", "openrouter", "gemini", "huggingface"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export type SubagentStatus = "queued" | "dispatched" | "running" | "done" | "failed";

export interface SubagentRow {
  id: string;
  task_type: string;
  brief: string;
  status: SubagentStatus;
  source: "github-issue" | "dashboard";
  provider: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  run_url: string | null;
}

export interface ProviderKeyMetaRow {
  provider: string;
  configured: 0 | 1;
  updated_at: string | null;
}

export interface StatusResponse {
  subagents: SubagentRow[];
  providers: ProviderKeyMetaRow[];
  generatedAt: string;
}

export class WorkerApiError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "WorkerApiError";
    this.status = status;
  }
}

async function callWorker(path: string, token: string, init: RequestInit = {}): Promise<Response> {
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

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
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
