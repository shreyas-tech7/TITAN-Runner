"use client";

/**
 * "Existing agents" — TITAN's real dispatch targets. Every provider the
 * orchestrator can route work to (`src/providers/registry.js`'s
 * FAILOVER_ORDER, plus opencode/freebuff) shown as a roster card: live
 * health from `state/providers.json`, purpose from the capability registry
 * in `state/agents.json` (`phase2:<provider>`'s `strengths`), and — when
 * the sub-agent cluster Worker is configured — what it is dispatched to
 * right now. Nothing here is invented: a provider with no health record
 * yet is honestly "idle", not silently hidden or marked "online".
 */
import { useState } from "react";
import type { AgentsState, ProviderHealthRecord, ProviderStatus } from "@/lib/types";
import type { SubagentRow } from "@/lib/workerApi";
import { relative, formatDuration } from "@/lib/time";

const ROSTER_IDS = ["groq", "together", "openrouter", "gemini", "huggingface", "opencode", "freebuff"];

type RosterStatus = "running" | "online" | "warning" | "offline" | "idle";

const STATUS_META: Record<RosterStatus, { label: string; dot: string; text: string }> = {
  running: { label: "Running", dot: "dot-live dot-pulsing", text: "text-signal" },
  online: { label: "Online", dot: "dot-live", text: "text-signal" },
  warning: { label: "Degraded", dot: "dot-warn", text: "text-warning" },
  offline: { label: "Offline", dot: "dot-fail", text: "text-failure" },
  idle: { label: "Idle", dot: "dot-idle", text: "text-quiet" },
};

function statusFor(record: ProviderHealthRecord | undefined, activeCount: number): RosterStatus {
  if (activeCount > 0) return "running";
  const status: ProviderStatus | undefined = record?.status;
  if (status === "ok") return "online";
  if (status === "rate_limited" || status === "exhausted" || status === "model_invalid") return "warning";
  if (status === "misconfigured" || status === "error") return "offline";
  return "idle";
}

export default function AgentsPanel({
  providers,
  agents,
  subagents,
}: {
  providers: Record<string, ProviderHealthRecord> | undefined;
  agents: AgentsState | undefined;
  subagents: SubagentRow[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = ROSTER_IDS.map((id) => {
    const record = providers?.[id];
    const capability = agents?.[`phase2:${id}`];
    const active = subagents.filter((s) => s.provider === id && (s.status === "running" || s.status === "dispatched"));
    const status = statusFor(record, active.length);
    const purpose = capability?.strengths?.length ? capability.strengths.join(", ") : "General-purpose dispatch target";
    return { id, record, capability, active, status, purpose };
  });

  const onlineCount = rows.filter((r) => r.status === "online" || r.status === "running").length;

  return (
    <div className="panel panel-interactive panel-enter">
      <div className="panel-head">
        <div className="panel-title">
          <span className={`dot ${onlineCount > 0 ? "dot-live" : "dot-idle"}`} aria-hidden />
          Agents <span className="text-quiet">({onlineCount}/{rows.length} online)</span>
        </div>
      </div>

      <div className="agent-grid">
        {rows.map((r) => {
          const meta = STATUS_META[r.status];
          const isOpen = expanded === r.id;
          return (
            <button
              key={r.id}
              type="button"
              className="agent-card"
              aria-expanded={isOpen}
              onClick={() => setExpanded(isOpen ? null : r.id)}
              style={{ textAlign: "left" }}
            >
              <div className="agent-card-head">
                <span className="agent-name mono">{r.id}</span>
                <span className={`dot ${meta.dot}`} aria-hidden title={meta.label} />
              </div>
              <div className={`agent-status ${meta.text}`}>{meta.label}</div>
              <div className="agent-purpose" title={r.purpose}>
                {r.active.length > 0 ? `Dispatched: ${r.active[0].brief}` : r.purpose}
              </div>
              {isOpen && (
                <div className="agent-detail">
                  {r.record?.model && (
                    <div>
                      Model: <span className="mono">{r.record.model}</span>
                    </div>
                  )}
                  {r.record?.lastSuccessAt && <div>Last success: {relative(r.record.lastSuccessAt)}</div>}
                  {r.record?.p50LatencyMs != null && <div>p50 latency: {formatDuration(r.record.p50LatencyMs)}</div>}
                  {r.capability?.contextWindow && <div>Context window: {r.capability.contextWindow.toLocaleString()} tokens</div>}
                  {r.active.length > 1 && <div>{r.active.length} active dispatches</div>}
                  {!r.record && <div className="text-quiet">No health record yet — not checked by a self-test.</div>}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
