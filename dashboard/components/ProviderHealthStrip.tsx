"use client";

import type { ProviderHealthRecord, ProviderStatus } from "@/lib/types";
import { relative, formatDuration } from "@/lib/time";
import { Badge, Panel, StatusDot, type Tone } from "@/components/kit";
import { pulseProviderIds } from "@/lib/providers";

const STATUS_META: Record<ProviderStatus, { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "ok" },
  not_configured: { label: "Not configured", tone: "neutral" },
  no_public_api: { label: "No public API", tone: "neutral" },
  misconfigured: { label: "Misconfigured", tone: "danger" },
  error: { label: "Error", tone: "danger" },
  rate_limited: { label: "Rate limited", tone: "warn" },
  exhausted: { label: "Exhausted", tone: "warn" },
  model_invalid: { label: "Rediscovering model", tone: "warn" },
  unknown: { label: "Never checked", tone: "neutral" },
};

function emptyRecord(id: string): ProviderHealthRecord {
  return {
    id,
    configured: false,
    status: "unknown",
    lastCheckedAt: null,
    lastSuccessAt: null,
    latencyMs: null,
    p50LatencyMs: null,
    samples: 0,
    errorRate: 0,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastError: null,
    model: null,
    discoveredModels: [],
    modelsDiscoveredAt: null,
    note: null,
  };
}

export default function ProviderHealthStrip({ providers }: { providers: Record<string, ProviderHealthRecord> | undefined }) {
  // The ids come from the catalog, so a provider shows even before `state/providers.json` has an entry for it.
  const rows = pulseProviderIds(providers).map((id) => providers?.[id] ?? emptyRecord(id));
  const inCooldown = (r: ProviderHealthRecord) => r.cooldownUntil && Date.parse(r.cooldownUntil) > Date.now();

  return (
    <Panel title="Provider health" eyebrow="Providers" tone="plasma" actions={<span className="e-dim">from the weekly self-test, see docs/RUNTIME.md</span>}>
      <ul className="e-list" aria-label="Provider health">
        {rows.map((r) => {
          const meta = STATUS_META[r.status] ?? STATUS_META.unknown;
          const detail =
            r.status === "ok" || r.status === "error" || r.status === "rate_limited"
              ? `last ok ${relative(r.lastSuccessAt)} · p50 ${formatDuration(r.p50LatencyMs)} · err ${(r.errorRate * 100).toFixed(0)}%`
              : r.model
                ? r.model
                : "";
          return (
            <li className="e-item" key={r.id}>
              <div className="e-item-head">
                <StatusDot tone={meta.tone} label={meta.label} />
                <span className="e-item-title e-num">{r.id}</span>
                <Badge tone={meta.tone}>
                  {meta.label}
                  {inCooldown(r) ? " (cooldown)" : ""}
                </Badge>
              </div>
              {detail || (r.model && r.status === "ok") ? (
                <div className="e-row-sub e-num">
                  {detail ? <span>{detail}</span> : null}
                  {r.model && r.status === "ok" ? <span>{r.model}</span> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
