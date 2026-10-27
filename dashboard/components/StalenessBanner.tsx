"use client";

import { useEffect, useState } from "react";
import { OWNER, REPO } from "@/lib/githubApi";
import { bannerState } from "@/lib/keeperBanner";
import { fetchPulseKeeper, type PulseKeeperState } from "@/lib/keysApi";
import { isWorkerConfigured } from "@/lib/workerApi";
import { SysPill } from "@/components/SysPill";

/**
 * The dead-man's-switch made visible. If the newest committed state is older than 45 minutes, say so. Wave 12 adds the
 * pulse keeper: the Worker starts a pulse itself when GitHub is late. So the alert is a warning only when the keeper
 * fails too. When the keeper has started a pulse, the alert is a quiet note.
 * The alert is a small status pill. A click opens the detail and the link to Actions.
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
  const minutes = Math.round(ageMs / 60_000);
  const state = bannerState(minutes, keeper, Date.now());
  if (state.kind === "none") return null;

  const [headline, ...rest] = state.text.split(". ");
  const alert = state.kind === "alert";
  return (
    <SysPill
      role={alert ? "alert" : "status"}
      tone={alert ? "warn" : "info"}
      code={alert ? "SYS_WARNING" : "SYS_NOTE"}
      text={`No pulse in ${minutes} min`}
      title={headline.endsWith(".") ? headline : `${headline}.`}
    >
      <p className="e-dim">{rest.join(". ") || "The Worker keeps the pulse alive."}</p>
      <div className="modal-actions">
        <a className="btn btn-primary" href={`https://github.com/${OWNER}/${REPO}/actions/workflows/titan-pulse.yml`} target="_blank" rel="noopener noreferrer">
          Open Actions →
        </a>
      </div>
    </SysPill>
  );
}
