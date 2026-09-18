/**
 * Mirrors the runner's data contract (`schemas/*.schema.json`, exported from
 * `src/state/schema.js`). `test/contract.test.js` on the runner side checks
 * that the status, priority, and wait-reason unions below match the engine's
 * lists exactly — edit them together.
 */
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
  /** v2 engine: the pulse id (lease owner), its time budget, and model calls. */
  pulseId?: string;
  budget?: { budgetMs: number; elapsedMs: number; remainingMs: number; draining: boolean };
  modelCalls?: number;
}

export interface PulseHistoryEntry {
  at: string;
  durationMs: number;
  status: "ok" | "error";
  tasksClaimed: number;
  tasksCompleted: number;
  tasksFailed: number;
  modelCalls?: number;
}

export interface PulseHistoryState {
  version: number;
  pulses: PulseHistoryEntry[];
}

/** Exactly `TASK_STATUSES` in src/state/schema.js (tasks.json v2). */
export type TaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "paused"
  | "complete"
  | "failed"
  | "blocked"
  | "cancelled"
  | "expired"
  | "dead-lettered"
  | "pr-open";

/** Exactly `WAIT_REASONS` in src/state/schema.js. */
export type WaitReason = "backoff" | "dependency" | "approval" | "budget" | "quota" | "pulse-budget" | "provider";
/** Exactly `PRIORITIES` in src/state/schema.js. */
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type RoutingHint = "fast" | "cheap" | "careful" | "any";
export type AutonomyLevel = "dry-run" | "propose" | "approval" | "autonomous";

export interface TaskFailure {
  class: string;
  code: string | null;
  message: string;
  at: string;
}

export interface TaskHistoryEntry {
  at: string;
  from: string | null;
  to: string;
  reason: string | null;
}

export interface TaskRecord {
  id: string;
  type: "task" | "self-improve";
  issueNumber: number | null;
  issueUrl: string | null;
  author?: string | null;
  title: string;
  prompt: string;
  priority?: TaskPriority | null;
  routingHint?: RoutingHint | null;
  status: TaskStatus;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  error: string | null;
  // ---- tasks.json v2 lifecycle fields (all optional for a v1 file) ----
  waitReason?: WaitReason | null;
  wakeAt?: string | null;
  attempts?: number;
  maxAttempts?: number;
  lease?: { owner: string; acquiredAt: string; expiresAt: string } | null;
  dependsOn?: string[];
  parentId?: string | null;
  deadline?: string | null;
  expiresAt?: string | null;
  idempotencyKey?: string | null;
  failure?: TaskFailure | null;
  history?: TaskHistoryEntry[];
  autonomy?: AutonomyLevel | null;
  parks?: number;
  usage?: { calls: number; tokens: number; wallMs: number } | null;
  approvals?: Record<string, { decision: "approved" | "denied"; by?: string; at?: string }> | null;
  duplicateOf?: string | null;
}

/** state/control.json — operator controls, changed only by the control workflow/CLI. */
export interface ControlState {
  version: number;
  killSwitch: boolean;
  drain: boolean;
  safeMode: boolean;
  autonomy: AutonomyLevel;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string | null;
}

/** state/views/queue.json — derived every pulse (src/observability/views.js). */
export interface QueueView {
  version: number;
  updatedAt: string;
  total: number;
  byStatus: Partial<Record<TaskStatus, number>>;
  byWaitReason: Partial<Record<WaitReason, number>>;
  active: number;
  running: Array<{ id: string; title: string; since: string | null; lease: string | null }>;
  nextWake: { id: string; wakeAt: string; waitReason: WaitReason } | null;
  oldestPending: { id: string; title: string; createdAt: string; ageMinutes: number } | null;
  approvalsPending: Array<{ id: string; title: string; issueNumber: number | null; since: string }>;
  deadLettered: Array<{ id: string; title: string; code: string | null; class: string | null; at: string | null }>;
}

/** state/views/analytics.json — outcomes and cost over the retained event window. */
export interface AnalyticsView {
  version: number;
  updatedAt: string;
  window: { events: number; from: string | null; to: string | null; archived: { days: number; events: number; calls: number } };
  tasks: { finished: number; succeeded: number; successRate: number | null; byOutcome: Record<string, number>; deadLetteredByClass: Record<string, number> };
  reliability: { retriesByClass: Record<string, number>; parks: number; loops: number; remediations: number };
  verification: { runs: number; passRate: number | null; unjudged: number };
  tools: { calls: number; denied: number };
  policy: { approvalsRequested: number; denials: number };
  cost: { modelCalls: number; upstreamCalls: number; tokens: number; callsPerCompletedTask: number | null; callsPerPulse: number | null };
  pulses: { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
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
