"use client";

import { useEffect, useState } from "react";
import { OWNER, REPO } from "@/lib/githubApi";
import { bannerState } from "@/lib/keeperBanner";
import { fetchPulseKeeper, type PulseKeeperState } from "@/lib/keysApi";
import { isWorkerConfigured } from "@/lib/workerApi";

/**
 * The dead-man's-switch made visible. If the newest committed state is older than 45 minutes, say so. Wave 12 adds the
 * pulse keeper: the Worker starts a pulse itself when GitHub is late. So the banner is a warning only when the keeper
 * fails too. When the keeper has started a pulse, the banner is a quiet note.
 * `.github/workflows/deadman.yml` still files an issue at the 24-hour mark.
 */
export default function StalenessBanner({ lastPulseAt, token }: { lastPulseAt: string | null; token?: string }) {
  const [keeper, setKeeper] = useState<PulseKeeperState | null>(null);
  const ageMs = lastPulseAt ? Date.now() - Date.parse(lastPulseAt) : NaN;
  const stale = Number.isFinite(ageMs) && ageMs >= 45 * 60_000;

  useEffect(() => {
    if (!stale || !token || !isWorkerConfigured()) return undefined;
    let alive = true;
    const load = () => fetchPulseKeeper(token).then((k) => alive && setKeeper(k)).catch(() => alive && setKeeper(null));
    void load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [stale, token]);

  if (!lastPulseAt || !Number.isFinite(ageMs)) return null;
  const state = bannerState(Math.round(ageMs / 60_000), keeper, Date.now());
  if (state.kind === "none") return null;

  return (
    <div className="banner" role={state.kind === "alert" ? "alert" : "status"}>
      <span>
        <strong className={state.kind === "alert" ? "text-warning" : "text-muted"}>{state.text.split(". ")[0]}.</strong>{" "}
        <span className="text-muted">{state.text.split(". ").slice(1).join(". ")}</span>
      </span>
      <a className="btn btn-quiet" href={`https://github.com/${OWNER}/${REPO}/actions/workflows/titan-pulse.yml`} target="_blank" rel="noopener noreferrer">
        Open Actions →
      </a>
    </div>
  );
}
