"use client";

/**
 * The agent status board: TITAN's real dispatch targets. Every provider the
 * orchestrator can route work to (`src/providers/registry.js`'s
 * FAILOVER_ORDER, plus opencode/freebuff) shown as a card: live health from
 * `state/providers.json`, purpose from the capability registry in
 * `state/agents.json` (`phase2:<provider>`'s `strengths`), today's call use
 * from `state/quota.json`, and, when the sub-agent cluster Worker is
 * configured, what the provider is dispatched to right now. Nothing here is
 * invented: a provider with no health record yet is honestly "idle", not
 * silently hidden or marked "online".
 */
import { useState } from "react";
import type { AgentsState, ProviderHealthRecord, ProviderStatus } from "@/lib/types";
import type { SubagentRow } from "@/lib/workerApi";
import type { QuotaRow } from "@/lib/quota";
import { relative, formatDuration } from "@/lib/time";
import { Badge, Meter, Panel, StatusDot, type Tone } from "@/components/kit";

const ROSTER_IDS = ["groq", "together", "openrouter", "gemini", "huggingface", "opencode", "freebuff"];

type RosterStatus = "running" | "online" | "warning" | "offline" | "idle";

const STATUS_META: Record<RosterStatus, { label: string; tone: Tone; pulse: boolean }> = {
  running: { label: "Running", tone: "plasma", pulse: true },
  online: { label: "Online", tone: "ok", pulse: false },
  warning: { label: "Degraded", tone: "warn", pulse: false },
  offline: { label: "Offline", tone: "danger", pulse: false },
  idle: { label: "Idle", tone: "neutral", pulse: false },
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
  quota,
}: {
  providers: Record<string, ProviderHealthRecord> | undefined;
  agents: AgentsState | undefined;
  subagents: SubagentRow[];
  quota?: QuotaRow[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = ROSTER_IDS.map((id) => {
    const record = providers?.[id];
    const capability = agents?.[`phase2:${id}`];
    const active = subagents.filter((s) => s.provider === id && (s.status === "running" || s.status === "dispatched"));
    const status = statusFor(record, active.length);
    const purpose = capability?.strengths?.length ? capability.strengths.join(", ") : "General-purpose dispatch target";
    const q = quota?.find((r) => r.id === id);
    return { id, record, capability, active, status, purpose, q };
  });

  const onlineCount = rows.filter((r) => r.status === "online" || r.status === "running").length;

  return (
    <Panel
      title="Agent status board"
      eyebrow="Agents"
      tone="plasma"
      actions={
        <Badge tone={onlineCount > 0 ? "ok" : "neutral"}>
          {onlineCount} of {rows.length} online
        </Badge>
      }
    >
      <div className="e-agents">
        {rows.map((r) => {
          const meta = STATUS_META[r.status];
          const isOpen = expanded === r.id;
          return (
            <button key={r.id} type="button" className="e-agent" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : r.id)}>
              <span className="e-agent-head">
                <span className="e-agent-name">{r.id}</span>
                <StatusDot tone={meta.tone} pulse={meta.pulse} label={meta.label} />
              </span>
              <span className="e-agent-status">
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </span>
              <span className="e-agent-purpose" title={r.purpose}>
                {r.active.length > 0 ? `Dispatched: ${r.active[0].brief}` : r.purpose}
              </span>
              {r.q ? (
                <span className="e-agent-quota">
                  <Meter value={r.q.dayUsed} max={r.q.dayLimit} marker={r.q.dayLimit - r.q.reserve} label={`${r.id} calls used today`} text={`${r.q.dayUsed} of ${r.q.dayLimit} calls`} />
                  <span className="e-row-sub">
                    <span className="e-num">{r.q.dayPct}% of the day&apos;s calls</span>
                  </span>
                </span>
              ) : null}
              {isOpen && (
                <span className="e-agent-detail">
                  {r.record?.model && (
                    <span>
                      Model: <span className="e-num">{r.record.model}</span>
                    </span>
                  )}
                  {r.record?.lastSuccessAt && <span>Last success: {relative(r.record.lastSuccessAt)}</span>}
                  {r.record?.p50LatencyMs != null && <span>p50 latency: {formatDuration(r.record.p50LatencyMs)}</span>}
                  {r.capability?.contextWindow && <span>Context window: {r.capability.contextWindow.toLocaleString()} tokens</span>}
                  {r.active.length > 1 && <span>{r.active.length} active dispatches</span>}
                  {!r.record && <span className="e-dim">No health record yet. A self-test has not checked it.</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
