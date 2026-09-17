import type { AgentsState, ProviderHealthRecord, ProviderStatus } from "./types";
import type { NetworkNode, NodeStatus } from "@/components/GeospatialGlobe";

/**
 * Fixed schematic positions for the provider mesh shown on the God's Eye
 * globe — spread across the map for a legible "global network" read, not a
 * claim about where any provider's actual infrastructure sits. The globe's
 * legend says so explicitly; nothing here is presented as verified geodata,
 * unlike the OSINT investigation pins layered on top of it (those *are*
 * real, resolved coordinates).
 */
const NODE_POSITION: Record<string, { lat: number; lon: number }> = {
  groq: { lat: 20, lon: -95 },
  together: { lat: 45, lon: -12 },
  openrouter: { lat: 35, lon: 25 },
  gemini: { lat: 10, lon: 100 },
  huggingface: { lat: 48, lon: 2 },
  opencode: { lat: -22, lon: 135 },
  freebuff: { lat: -12, lon: -60 },
  omniroute: { lat: 5, lon: -20 },
};

function toNodeStatus(status: ProviderStatus, configured: boolean): NodeStatus {
  if (status === "ok") return "online";
  if (!configured || status === "not_configured" || status === "unknown") return "idle";
  if (status === "rate_limited" || status === "exhausted" || status === "model_invalid") return "warning";
  return "offline";
}

function statusLabel(status: NodeStatus): string {
  switch (status) {
    case "online":
      return "online";
    case "warning":
      return "degraded";
    case "offline":
      return "unreachable";
    default:
      return "idle";
  }
}

/**
 * Builds the God's Eye network mesh from `state/providers.json` (health,
 * always present) and `state/agents.json` (the capability registry —
 * per-pool strengths, used here as each provider's "what it does"). Every
 * field shown is real; a provider with no health record yet is honestly
 * "idle", never invented as online.
 */
export function buildProviderNetwork(
  providers: Record<string, ProviderHealthRecord> | undefined,
  agents: AgentsState | undefined,
): NetworkNode[] {
  return Object.entries(NODE_POSITION).map(([id, pos]) => {
    const record = providers?.[id];
    const status = toNodeStatus(record?.status ?? "unknown", record?.configured ?? false);
    const capability = agents?.[`phase2:${id}`];
    const roles = capability?.strengths?.length ? capability.strengths.join(", ") : null;
    const detailParts = [`status: ${statusLabel(status)}`];
    if (record?.model) detailParts.push(`model: ${record.model}`);
    if (roles) detailParts.push(`roles: ${roles}`);
    return {
      id,
      label: id,
      lat: pos.lat,
      lon: pos.lon,
      status,
      detail: detailParts.join(" · "),
    };
  });
}
