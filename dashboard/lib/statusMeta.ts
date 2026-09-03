import type { TaskStatus } from "./types";

export const STATUS_META: Record<TaskStatus, { label: string; dot: string; text: string }> = {
  pending: { label: "Pending", dot: "dot-idle", text: "text-muted" },
  claimed: { label: "Claimed", dot: "dot-idle", text: "text-muted" },
  running: { label: "Running", dot: "dot-live dot-pulsing", text: "text-signal" },
  complete: { label: "Complete", dot: "dot-live", text: "text-signal" },
  failed: { label: "Failed", dot: "dot-fail", text: "text-failure" },
  blocked: { label: "Blocked", dot: "dot-fail", text: "text-failure" },
  cancelled: { label: "Cancelled", dot: "dot-idle", text: "text-quiet" },
  "pr-open": { label: "PR open", dot: "dot-warn", text: "text-warning" },
};
