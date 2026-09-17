"use client";

/**
 * Wires the two new sub-agent-cluster panels to a single `GET /status`
 * poll (build brief, section 5) and re-locks the dashboard immediately if
 * the Worker ever rejects the token mid-session (rotated/revoked by
 * Shreyas) rather than spinning on 401s forever.
 *
 * The poll itself now lives one level up, in `app/page.tsx` — the
 * command-center redesign's Running Tasks and Agents panels need the same
 * `subagents` rows this component does, and a second independent
 * `useWorkerStatus` call here would just double the polling traffic for no
 * benefit. This component is now a pure view over the status it's handed.
 */
import { useEffect } from "react";
import type { WorkerStatusResult } from "@/lib/useWorkerStatus";
import { isWorkerConfigured } from "@/lib/workerApi";
import SubagentsSection from "./SubagentsSection";
import ProviderKeysPanel from "./ProviderKeysPanel";
import OmniRouteStatusPanel from "./OmniRouteStatusPanel";
import OsintPanel from "./OsintPanel";
import SystemMemoryPanel from "./SystemMemoryPanel";

export default function ClusterPanels({
  token,
  status,
  onUnauthorized,
}: {
  token: string;
  status: WorkerStatusResult;
  onUnauthorized: () => void;
}) {
  useEffect(() => {
    if (status.unauthorized) onUnauthorized();
  }, [status.unauthorized, onUnauthorized]);

  if (!isWorkerConfigured()) {
    return (
      <section className="section">
        <div className="section-head">
          <span className="label">Sub-agent cluster</span>
        </div>
        <div className="empty">
          The titan-runner-brain Worker isn&apos;t deployed/configured on this build yet
          (<span className="mono">NEXT_PUBLIC_TITAN_WORKER_URL</span> is empty) — see docs/RUNTIME.md.
        </div>
      </section>
    );
  }

  if (status.loading && !status.data) {
    return (
      <section className="section">
        <div className="section-head">
          <span className="label">Sub-agent cluster</span>
        </div>
        <div className="empty">Loading…</div>
      </section>
    );
  }

  if (status.error && !status.data) {
    return (
      <section className="section">
        <div className="section-head">
          <span className="label">Sub-agent cluster</span>
        </div>
        <div className="empty">{status.error}</div>
      </section>
    );
  }

  return (
    <>
      <SubagentsSection
        token={token}
        subagents={status.data?.subagents ?? []}
        learningPaths={status.data?.learningPaths ?? []}
        onQueued={status.refresh}
      />
      <ProviderKeysPanel token={token} providers={status.data?.providers ?? []} onChanged={status.refresh} />
      <OmniRouteStatusPanel subagents={status.data?.subagents ?? []} />
      <OsintPanel token={token} subagents={status.data?.subagents ?? []} onQueued={status.refresh} />
      <SystemMemoryPanel token={token} />
    </>
  );
}
