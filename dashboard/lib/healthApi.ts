/**
 * The health and setup routes of the Worker (Wave 12, Track H). A report from these routes holds no secret, so it is safe to
 * copy. The Worker caches `GET /health/full` for 30 seconds.
 */
import { callWorker, readErrorMessage, WorkerApiError } from "./workerApi";

export type HealthState = "ok" | "warn" | "down" | "unknown";
export type HealthGroup = "core" | "keys" | "connectors" | "fleet" | "external";

export interface HealthFix {
  text: string;
  doc?: string;
  action?: { label: string; href: string };
}

export interface HealthRow {
  id: string;
  group: HealthGroup;
  label: string;
  state: HealthState;
  detail: string;
  checkedAt: string;
  latencyMs: number | null;
  fix: HealthFix | null;
}

export interface HealthSummary {
  ok: number;
  warn: number;
  down: number;
  unknown: number;
}

export interface HealthResponse {
  rows: HealthRow[];
  generatedAt: string;
  summary: HealthSummary;
  cached: boolean;
  requestId: string;
}

export interface DiagnosisItem {
  id: string;
  label: string;
  state: HealthState;
  detail: string;
}

export interface DiagnosisResponse {
  generatedAt: string;
  summary: HealthSummary;
  items: DiagnosisItem[];
  report: string;
  requestId: string;
}

export interface SetupItem {
  id: string;
  label: string;
  done: boolean;
  detail: string;
  link: { text: string; href: string } | null;
}

export interface SetupResponse {
  items: SetupItem[];
  done: number;
  total: number;
  complete: boolean;
  requestId: string;
}

export interface HealthUrl {
  id: string;
  label: string;
  url: string;
}

export interface VersionResponse {
  service?: string;
  commit?: string;
  builtAt?: string;
  schemaVersion?: number | string;
}

async function getJson<T>(path: string, token: string): Promise<T> {
  const res = await callWorker(path, token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return (await res.json()) as T;
}

export const fetchHealth = (token: string) => getJson<HealthResponse>("/health/full", token);
export const fetchSetup = (token: string) => getJson<SetupResponse>("/admin/setup", token);
export const fetchHealthUrls = (token: string) => getJson<{ urls: HealthUrl[]; max: number }>("/admin/health/urls", token);

export async function runDiagnosis(token: string): Promise<DiagnosisResponse> {
  const res = await callWorker("/admin/diagnose/full", token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return (await res.json()) as DiagnosisResponse;
}

export async function saveHealthUrls(token: string, urls: HealthUrl[]): Promise<{ urls: HealthUrl[] }> {
  const res = await callWorker("/admin/health/urls", token, { method: "POST", body: JSON.stringify({ urls }) });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return (await res.json()) as { urls: HealthUrl[] };
}

/** `GET /version` is public. It needs no token, so this call goes out without the admin header. */
export async function fetchWorkerVersion(workerUrl: string): Promise<VersionResponse | null> {
  if (!workerUrl) return null;
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/version`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as VersionResponse) : null;
  } catch {
    return null;
  }
}
