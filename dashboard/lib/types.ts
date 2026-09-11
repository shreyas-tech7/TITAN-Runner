export interface HeartbeatState {
  version: number;
  lastPulseAt: string | null;
  lastPulseStatus: "ok" | "error" | null;
  lastPulseDurationMs: number | null;
  lastPulseTasksClaimed: number;
  lastPulseTasksCompleted: number;
  lastPulseTasksFailed: number;
  lastPulseError: string | null;
  consecutivePulseFailures: number;
  totalPulses: number;
  cadenceMinutes: number;
}

export interface PulseHistoryEntry {
  at: string;
  durationMs: number;
  status: "ok" | "error";
  tasksClaimed: number;
  tasksCompleted: number;
  tasksFailed: number;
}

export interface PulseHistoryState {
  version: number;
  pulses: PulseHistoryEntry[];
}

export type TaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "complete"
  | "failed"
  | "blocked"
  | "cancelled"
  | "pr-open";

export type TaskPriority = "low" | "normal" | "high";
export type RoutingHint = "fast" | "cheap" | "careful" | "any";

export interface TaskRecord {
  id: string;
  type: "task" | "self-improve";
  issueNumber: number | null;
  issueUrl: string | null;
  title: string;
  prompt: string;
  priority?: TaskPriority | null;
  routingHint?: RoutingHint | null;
  status: TaskStatus;
  retryCount?: number | null;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  error: string | null;
}

export interface TasksState {
  version: number;
  updatedAt: string;
  tasks: TaskRecord[];
}

export interface CapabilityRecord {
  modelId: string;
  pool: string;
  strengths: string[];
  weaknesses: string[];
  latencyClass: "fast" | "medium" | "slow";
  contextWindow: number;
  source: "seed" | "probe";
  probedAt: string | null;
  observed: Record<string, { runs: number; successRate: number; avgMs: number }>;
}

export type AgentsState = Record<string, CapabilityRecord>;

export interface RunTaskSummary {
  id: string;
  title: string;
  aspect: string;
  state: string;
  assignment: { modelId: string; pool: string; reason: string } | null;
  attempts: Array<{ modelId: string; pool: string; ok: boolean; ms: number; tokensUsed: number | null }>;
  outputPreview: string | null;
  error: { code: string; message: string } | null;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  taskTitle: string;
  issueUrl: string | null;
  createdAt: string;
  durationMs: number;
  state: "complete" | "failed";
  actionsRunUrl: string | null;
  sharedContext: string;
  tasks: RunTaskSummary[];
  files: Array<{ path: string; sourceTaskId: string; conflict: boolean }>;
  markdownSummary: string;
}

/** Mirrors src/providers/health.js's ProviderHealthStore record shape exactly. */
export type ProviderStatus =
  | "not_configured"
  | "ok"
  | "misconfigured"
  | "rate_limited"
  | "exhausted"
  | "model_invalid"
  | "no_public_api"
  | "error"
  | "unknown";

export interface ProviderHealthRecord {
  id: string;
  configured: boolean;
  status: ProviderStatus;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  latencyMs: number | null;
  p50LatencyMs: number | null;
  samples: number;
  errorRate: number;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastError: string | null;
  model: string | null;
  discoveredModels: string[];
  modelsDiscoveredAt: string | null;
  note: string | null;
}

export interface ProvidersState {
  version: number;
  updatedAt: string;
  providers: Record<string, ProviderHealthRecord>;
}
