import type { TaskStatus } from "./types";

/** One entry per `TaskStatus` (the runner's TASK_STATUSES); the contract test on the runner side checks the set. */
export const STATUS_META: Record<TaskStatus, { label: string; dot: string; text: string }> = {
  pending: { label: "Pending", dot: "dot-idle", text: "text-muted" },
  running: { label: "Running", dot: "dot-live dot-pulsing", text: "text-signal" },
  waiting: { label: "Waiting", dot: "dot-warn", text: "text-warning" },
  paused: { label: "Paused", dot: "dot-idle", text: "text-quiet" },
  complete: { label: "Complete", dot: "dot-live", text: "text-signal" },
  failed: { label: "Failed", dot: "dot-fail", text: "text-failure" },
  blocked: { label: "Blocked", dot: "dot-fail", text: "text-failure" },
  cancelled: { label: "Cancelled", dot: "dot-idle", text: "text-quiet" },
  expired: { label: "Expired", dot: "dot-idle", text: "text-quiet" },
  "dead-lettered": { label: "Dead-lettered", dot: "dot-fail", text: "text-failure" },
  "pr-open": { label: "PR open", dot: "dot-warn", text: "text-warning" },
};

/** A short human line for a waiting task: what it waits on. */
export const WAIT_REASON_LABEL: Record<string, string> = {
  backoff: "retry backoff",
  dependency: "dependencies",
  approval: "your approval (/titan approve)",
  budget: "budget",
  quota: "provider quota",
  "pulse-budget": "the next pulse",
  provider: "a provider to recover",
};
