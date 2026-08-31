"use client";

import { OWNER, REPO } from "@/lib/githubApi";

const STALE_THRESHOLD_MS = 45 * 60_000;

/**
 * The dead-man's-switch made visible (task instructions, section 3): if the
 * newest committed state is older than 45 minutes, say so loudly rather
 * than let the dashboard quietly show a queue that stopped moving hours
 * ago. `.github/workflows/deadman.yml` already files an issue at the
 * 24-hour mark server-side; this is the much-earlier, purely visual signal
 * for a viewer looking at the page right now.
 */
export default function StalenessBanner({ lastPulseAt }: { lastPulseAt: string | null }) {
  if (!lastPulseAt) return null;
  const ageMs = Date.now() - Date.parse(lastPulseAt);
  if (!Number.isFinite(ageMs) || ageMs < STALE_THRESHOLD_MS) return null;

  const ageMinutes = Math.round(ageMs / 60_000);
  return (
    <div className="banner" role="alert">
      <span>
        <strong className="text-warning">No pulse in {ageMinutes} minutes.</strong>{" "}
        <span className="text-muted">Expected every 15 — this could be a stuck run, an exhausted provider, or GitHub cron running late.</span>
      </span>
      <a className="btn btn-quiet" href={`https://github.com/${OWNER}/${REPO}/actions/workflows/titan-pulse.yml`} target="_blank" rel="noreferrer">
        Open Actions →
      </a>
    </div>
  );
}
