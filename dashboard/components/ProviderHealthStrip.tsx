"use client";

import type { ProviderHealthRecord, ProviderStatus } from "@/lib/types";
import { relative, formatDuration } from "@/lib/time";

const STATUS_META: Record<ProviderStatus, { label: string; dot: string; text: string }> = {
  ok: { label: "OK", dot: "dot-live", text: "text-signal" },
  not_configured: { label: "Not configured", dot: "dot-idle", text: "text-quiet" },
  no_public_api: { label: "No public API", dot: "dot-idle", text: "text-quiet" },
  misconfigured: { label: "Misconfigured", dot: "dot-fail", text: "text-failure" },
  error: { label: "Error", dot: "dot-fail", text: "text-failure" },
  rate_limited: { label: "Rate limited", dot: "dot-warn", text: "text-warning" },
  exhausted: { label: "Exhausted", dot: "dot-warn", text: "text-warning" },
  model_invalid: { label: "Rediscovering model", dot: "dot-warn", text: "text-warning" },
  unknown: { label: "Never checked", dot: "dot-idle", text: "text-quiet" },
};

/** Every provider the pulse knows about, shown even if `state/providers.json`
 *  has no entry for it yet (a fresh checkout before the first self-test). */
const ALL_PROVIDER_IDS = ["groq", "together", "openrouter", "gemini", "huggingface", "opencode", "freebuff"];

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
  const rows = ALL_PROVIDER_IDS.map((id) => providers?.[id] ?? emptyRecord(id));
  const inCooldown = (r: ProviderHealthRecord) => r.cooldownUntil && Date.parse(r.cooldownUntil) > Date.now();

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Providers</span>
        <span className="text-quiet" style={{ fontSize: 11 }}>
          from the weekly self-test — see docs/RUNTIME.md
        </span>
      </div>
      <div>
        {rows.map((r) => {
          const meta = STATUS_META[r.status] ?? STATUS_META.unknown;
          return (
            <div className="row" key={r.id}>
              <span className={`dot ${meta.dot}`} aria-hidden />
              <span className="row-title mono" style={{ flex: "0 0 110px" }}>
                {r.id}
              </span>
              <span className={`badge ${meta.text}`} style={{ flex: "0 0 140px" }}>
                {meta.label}
                {inCooldown(r) ? " (cooldown)" : ""}
              </span>
              <span className="row-quiet mono" style={{ flex: 1 }}>
                {r.status === "ok" || r.status === "error" || r.status === "rate_limited"
                  ? `last ok ${relative(r.lastSuccessAt)} · p50 ${formatDuration(r.p50LatencyMs)} · err ${(r.errorRate * 100).toFixed(0)}%`
                  : r.model
                    ? r.model
                    : ""}
              </span>
              {r.model && r.status === "ok" && <span className="row-quiet mono">{r.model}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
