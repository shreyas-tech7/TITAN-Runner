/**
 * The key routes of the Worker (Wave 12, Track K). A key value goes out in one request body, over https, and nowhere
 * else. This file never logs, stores, or puts a value in a URL.
 */
import { callWorker, readErrorMessage, WorkerApiError } from "./workerApi";

export type KeyState = "missing" | "saved_unverified" | "provider_ok" | "proven" | "invalid" | "rate_limited" | "unverifiable" | "error";

export interface ProviderCheck {
  result: string;
  httpStatus: number | null;
  httpClass: string;
  latencyMs: number | null;
  at: string;
  detail: string | null;
}

export interface RunnerProof {
  result: "ok" | "failed";
  source: "runner" | "pulse";
  model: string | null;
  latencyMs: number | null;
  at: string;
  detail: string | null;
}

export interface PulseView {
  status: string | null;
  model: string | null;
  latencyMs: number | null;
  errorRate: number | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  models: string[];
  modelCount: number;
}

export interface KeyInputSpec {
  required?: boolean;
  default?: string;
  help?: string;
}

export interface KeyRow {
  id: string;
  label: string;
  verifiable: boolean;
  unverifiableReason: string | null;
  usedBy: string[];
  note: string | null;
  inputs: Record<string, KeyInputSpec>;
  keyHint: string;
  getKeyUrl: string;
  noCard: boolean;
  freeTierNote: { text: string; source: string; checkedOn: string };
  canChat: boolean;
  secretName: string;
  secretPresent: boolean | null;
  secretUpdatedAt: string | null;
  savedVia: "dashboard" | "outside" | null;
  replacedOutside: boolean;
  savedAt: string | null;
  fingerprint: string | null;
  last4: string | null;
  alsoForChat: boolean;
  providerCheck: ProviderCheck | null;
  runnerProof: RunnerProof | null;
  pulseView: PulseView | null;
  state: KeyState;
  stateReason: string;
}

export interface PatBlock {
  ok: false;
  status: number | null;
  permission: string;
  hint: string;
  message: string;
}

export interface KeysResponse {
  generatedAt: string;
  requestId: string;
  repo: string;
  vault: { ready: boolean; fix: string | null };
  pat: PatBlock | null;
  reconciled: string[];
  misnamedSecrets: Array<{ found: string; suggest: string; provider: string }>;
  providers: KeyRow[];
}

export interface KeyEvent {
  id: number;
  at: string;
  action: string;
  provider: string | null;
  fingerprint: string | null;
  old_fingerprint: string | null;
  result: string | null;
  actor: string;
  request_id: string | null;
  detail: string | null;
}

export interface SaveKeyBody {
  provider: string;
  value: string;
  baseUrl?: string;
  model?: string;
  chatPath?: string;
  specialization?: string;
  label?: string;
  alsoForChat?: boolean;
  saveIfUnverified?: boolean;
}

export type SaveOutcome =
  | { kind: "saved"; provider: string; fingerprint: string; last4: string; verified: boolean; selftest: string; chat: string; warnings: string[]; requestId: string; providerCheck: ProviderCheck }
  | { kind: "rejected"; reason: string; requestId: string }
  | { kind: "needs_confirm"; reason: string; warnings: string[]; requestId: string }
  | { kind: "failed"; status: number; error: string; message: string; permission: string | null; requestId: string | null };

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function fetchKeys(token: string): Promise<KeysResponse> {
  const res = await callWorker("/admin/keys", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson<KeysResponse>(res);
}

/** Send a key. The value is in the request body only. The outcome never holds it. */
export async function saveKey(token: string, body: SaveKeyBody): Promise<SaveOutcome> {
  const res = await callWorker("/admin/keys", token, { method: "POST", body: JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // A body that is not JSON falls through to the generic failure below.
  }
  const requestId = typeof json.requestId === "string" ? json.requestId : null;
  if (res.status === 200 && json.ok === true) {
    return {
      kind: "saved",
      provider: String(json.provider),
      fingerprint: String(json.fingerprint),
      last4: String(json.last4),
      verified: json.verified === true,
      selftest: String(json.selftest),
      chat: String(json.chat),
      warnings: Array.isArray(json.warnings) ? (json.warnings as string[]) : [],
      requestId: requestId ?? "",
      providerCheck: json.providerCheck as ProviderCheck,
    };
  }
  if (res.status === 422) return { kind: "rejected", reason: String(json.reason ?? "The provider rejected this key."), requestId: requestId ?? "" };
  if (res.status === 202 && json.needsConfirm === true) {
    return { kind: "needs_confirm", reason: String(json.reason ?? "The provider did not answer."), warnings: Array.isArray(json.warnings) ? (json.warnings as string[]) : [], requestId: requestId ?? "" };
  }
  const pat = json.pat as { permission?: string } | undefined;
  return {
    kind: "failed",
    status: res.status,
    error: String(json.error ?? "error"),
    message: String(json.message ?? json.error ?? `The Worker answered ${res.status}.`),
    permission: pat?.permission ?? null,
    requestId,
  };
}

export async function removeKey(token: string, provider: string): Promise<{ ok: true; removed: string[] }> {
  const res = await callWorker(`/admin/keys/${encodeURIComponent(provider)}`, token, { method: "DELETE", body: JSON.stringify({ confirm: provider }) });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson(res);
}

export async function testKey(token: string, provider: string): Promise<{ ok: true; requestId: string }> {
  const res = await callWorker(`/admin/keys/${encodeURIComponent(provider)}/test`, token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson(res);
}

export async function fetchKeyEvents(token: string, limit = 20): Promise<KeyEvent[]> {
  const res = await callWorker(`/admin/keys/events?limit=${limit}`, token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return (await readJson<{ events: KeyEvent[] }>(res)).events;
}

// --- the callback path (Wave 12, K8) -----------------------------------------------------------------------------

export interface CallbackState {
  hasToken: boolean;
  activeSince: string | null;
  legacyMode: boolean;
  retryAfter: string | null;
  lastError: string | null;
  lastPing: { id: string; requestedAt: string; receivedAt: string | null; authKind: string | null; seconds: number | null } | null;
}

export async function fetchCallbackState(token: string): Promise<CallbackState> {
  const res = await callWorker("/admin/callback", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson(res);
}

export async function rotateCallbackToken(token: string): Promise<{ ok: true; previousValidUntil: string }> {
  const res = await callWorker("/admin/callback-token/rotate", token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson(res);
}

export async function startCallbackPing(token: string): Promise<{ ok: true; id: string }> {
  const res = await callWorker("/admin/callback-ping", token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson(res);
}

// --- the pulse keeper (Wave 12, R1) ------------------------------------------------------------------------------

export interface PulseKeeperState {
  lastHeartbeatAt: string | null;
  heartbeatAgeMinutes: number | null;
  lastDispatchAt: string | null;
  keeperError: string | null;
  keeperHealthy: boolean;
}

export async function fetchPulseKeeper(token: string): Promise<PulseKeeperState> {
  const res = await callWorker("/admin/pulse", token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson(res);
}

export async function runPulseNow(token: string): Promise<{ ok: true }> {
  const res = await callWorker("/admin/pulse/run", token, { method: "POST", body: "{}" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return readJson(res);
}
