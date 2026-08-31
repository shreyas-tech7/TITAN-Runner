"use client";

/**
 * Direct browser -> api.github.com calls, authenticated with the PAT from
 * `lib/token.ts`. This is the entire "no serverless function, nothing else
 * to maintain" flow task instructions section 1 asks for: a static export
 * has no backend of its own to proxy through, so the browser talks to
 * GitHub's REST API directly, exactly the way a PAT-authenticated SPA is
 * meant to (GitHub's API sends CORS headers for this).
 */

export const OWNER = process.env.NEXT_PUBLIC_GITHUB_OWNER || "shreyas-tech7";
export const REPO = process.env.NEXT_PUBLIC_GITHUB_REPO || "TITAN-Runner";
const API_BASE = "https://api.github.com";

export class GitHubApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new GitHubApiError(`Could not reach api.github.com: ${err instanceof Error ? err.message : String(err)}`, 0);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const json = await res.json();
      detail = typeof json?.message === "string" ? json.message : "";
    } catch {
      // ignore — a non-JSON error body just means no extra detail
    }
    const suffix = detail ? `: ${detail}` : "";
    if (res.status === 401 || res.status === 403) {
      throw new GitHubApiError(`GitHub rejected the token (${res.status})${suffix}. Check its scope and expiry in Settings.`, res.status);
    }
    throw new GitHubApiError(`GitHub API ${method} ${path} -> ${res.status}${suffix}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface CreatedIssue {
  number: number;
  html_url: string;
}

export async function createIssue(token: string, title: string, body: string, labels: string[]): Promise<CreatedIssue> {
  return call(token, "POST", `/repos/${OWNER}/${REPO}/issues`, { title, body, labels });
}

export async function closeIssue(token: string, issueNumber: number): Promise<void> {
  await call(token, "PATCH", `/repos/${OWNER}/${REPO}/issues/${issueNumber}`, { state: "closed", state_reason: "not_planned" });
}

export async function reopenIssueWithRetryMarker(token: string, issueNumber: number): Promise<void> {
  await call(token, "PATCH", `/repos/${OWNER}/${REPO}/issues/${issueNumber}`, { state: "open" });
  await call(token, "POST", `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`, {
    body: "**Retry requested** from the TITAN-Runner dashboard. This issue was reopened for the next pulse to pick up again.",
  });
}

export interface PullSummary {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string; sha: string };
  draft: boolean;
  created_at: string;
}

/** Public-repo reads work with no token at all — an unauthenticated fetch is used when none is stored. */
export async function listOpenSelfImprovePulls(token: string | null): Promise<PullSummary[]> {
  const pulls: PullSummary[] = await call(token, "GET", `/repos/${OWNER}/${REPO}/pulls?state=open&per_page=30`);
  return pulls.filter((p) => p.head.ref.startsWith("self-improve/"));
}

export interface PullDetail extends PullSummary {
  additions: number;
  deletions: number;
  changed_files: number;
}

export async function getPull(token: string | null, number: number): Promise<PullDetail> {
  return call(token, "GET", `/repos/${OWNER}/${REPO}/pulls/${number}`);
}

export type CheckSummary = "success" | "failure" | "pending" | "none";

export async function getCheckSummary(token: string | null, ref: string): Promise<CheckSummary> {
  try {
    const res = await call(token, "GET", `/repos/${OWNER}/${REPO}/commits/${ref}/check-runs`);
    const runs = (res?.check_runs ?? []) as Array<{ status: string; conclusion: string | null }>;
    if (runs.length === 0) return "none";
    if (runs.some((r) => r.status !== "completed")) return "pending";
    if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled")) return "failure";
    return "success";
  } catch {
    return "none";
  }
}

export function issueUrl(issueNumber: number): string {
  return `https://github.com/${OWNER}/${REPO}/issues/${issueNumber}`;
}

export function newTokenSettingsUrl(): string {
  return `https://github.com/settings/personal-access-tokens/new?target_name=${OWNER}`;
}
