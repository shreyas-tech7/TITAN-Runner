"use client";

/** The two reads of the Security panel. Both come after the sign-in. */
import { OWNER, REPO } from "./githubApi";
import type { GitleaksRun, SigninLog } from "./opsView";
import { WorkerApiError, callWorker, readErrorMessage } from "./workerApi";

/** GET /admin/security/signins. The log holds IP addresses, so the Worker shows it only to a signed-in admin. */
export async function fetchSigninLog(token: string, limit = 25): Promise<SigninLog> {
  const res = await callWorker(`/admin/security/signins?limit=${limit}`, token, { method: "GET" });
  if (!res.ok) throw new WorkerApiError(await readErrorMessage(res, `Worker responded ${res.status}`), res.status);
  return res.json();
}

/** The last run of the gitleaks workflow on main, from the public GitHub API. Null when it cannot be read. */
export async function fetchGitleaksRun(fetchImpl: typeof fetch = fetch): Promise<GitleaksRun | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/gitleaks.yml/runs?branch=main&per_page=1`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { workflow_runs?: Array<{ status?: string; conclusion?: string | null; updated_at?: string; html_url?: string }> };
    const run = body.workflow_runs?.[0];
    if (!run) return null;
    const url = typeof run.html_url === "string" && run.html_url.startsWith("https://github.com/") ? run.html_url : null;
    return { status: run.status ?? null, conclusion: run.conclusion ?? null, updatedAt: run.updated_at ?? null, url };
  } catch {
    return null;
  }
}
