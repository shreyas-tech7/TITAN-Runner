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

export type TaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "complete"
  | "failed"
  | "blocked"
  | "pr-open";

export interface TaskRecord {
  id: string;
  type: "task" | "self-improve";
  issueNumber: number | null;
  issueUrl: string | null;
  title: string;
  prompt: string;
  status: TaskStatus;
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
  attempts: Array<{ modelId: string; pool: string; ok: boolean; ms: number }>;
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
  sharedContext: string;
  tasks: RunTaskSummary[];
  files: Array<{ path: string; sourceTaskId: string; conflict: boolean }>;
  markdownSummary: string;
}
