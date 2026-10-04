"use client";

/**
 * Wires the two new sub-agent-cluster panels to a single `GET /status`
 * poll (build brief, section 5) and re-locks the dashboard immediately if
 * the Worker ever rejects the token mid-session (rotated/revoked by
 * the operator) rather than spinning on 401s forever.
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
import VmFleetPanel from "./VmFleetPanel";
import { Panel } from "./kit";

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
      <Panel title="Sub-agent cluster" eyebrow="Agents" tone="plasma">
        <p className="e-dim">
          The titan-runner-brain Worker isn&apos;t deployed or configured on this build yet (<span className="e-num">NEXT_PUBLIC_TITAN_WORKER_URL</span> is empty). See docs/RUNTIME.md.
        </p>
      </Panel>
    );
  }

  if (status.loading && !status.data) {
    return (
      <Panel title="Sub-agent cluster" eyebrow="Agents" tone="plasma">
        <p className="e-dim">Loading…</p>
      </Panel>
    );
  }

  if (status.error && !status.data) {
    return (
      <Panel title="Sub-agent cluster" eyebrow="Agents" tone="plasma">
        <p className="e-dim" role="alert">{status.error}</p>
      </Panel>
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
      <VmFleetPanel token={token} />
      <OsintPanel token={token} subagents={status.data?.subagents ?? []} onQueued={status.refresh} />
      <SystemMemoryPanel token={token} />
    </>
  );
}
