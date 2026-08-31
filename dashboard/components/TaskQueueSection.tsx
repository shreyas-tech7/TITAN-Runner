"use client";

import { useState } from "react";
import type { TaskRecord, TaskStatus } from "@/lib/types";
import type { OptimisticTask } from "@/lib/optimisticTasks";
import { removeOptimisticTask } from "@/lib/optimisticTasks";
import { getToken } from "@/lib/token";
import { closeIssue, reopenIssueWithRetryMarker, GitHubApiError } from "@/lib/githubApi";
import { relative } from "@/lib/time";
import { STATUS_META } from "@/lib/statusMeta";

const ACTIVE_STATUSES = new Set<TaskStatus>(["pending", "claimed", "running", "pr-open"]);
const CANCELLABLE_STATUSES = new Set<TaskStatus>(["pending", "claimed"]);
const RETRYABLE_STATUSES = new Set<TaskStatus>(["failed", "blocked", "cancelled"]);

function OptimisticRow({ task, onSelect }: { task: OptimisticTask; onSelect: () => void }) {
  return (
    <button className="row row-button" onClick={onSelect} style={{ width: "100%" }}>
      <span className="dot dot-warn dot-pulsing" aria-hidden />
      <span className="row-title">{task.title}</span>
      <span className="chip chip-optimistic">queued, waiting for next pulse</span>
    </button>
  );
}

function TaskRow({
  task,
  onSelect,
  onAction,
  busy,
  actionError,
}: {
  task: TaskRecord;
  onSelect: () => void;
  onAction: (task: TaskRecord, kind: "cancel" | "retry") => void;
  busy: boolean;
  actionError: string | null;
}) {
  const meta = STATUS_META[task.status] ?? STATUS_META.pending;
  const canCancel = CANCELLABLE_STATUSES.has(task.status) && task.issueNumber != null;
  const canRetry = RETRYABLE_STATUSES.has(task.status) && task.issueNumber != null;

  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <button className="row-button" onClick={onSelect} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, padding: "4px 6px" }}>
        <span className={`dot ${meta.dot}`} aria-hidden />
        <span className="row-title">{task.title || task.id}</span>
        {task.priority && task.priority !== "normal" && <span className="chip">{task.priority}</span>}
      </button>
      {task.issueUrl && (
        <a className="mono text-quiet" href={task.issueUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
          #{task.issueNumber}
        </a>
      )}
      <span className="row-quiet mono">{relative(task.completedAt ?? task.createdAt)}</span>
      <span className={`badge ${meta.text}`}>{meta.label}</span>
      {canCancel && (
        <button className="btn btn-quiet" disabled={busy} onClick={() => onAction(task, "cancel")}>
          {busy ? "…" : "Cancel"}
        </button>
      )}
      {canRetry && (
        <button className="btn btn-quiet" disabled={busy} onClick={() => onAction(task, "retry")}>
          {busy ? "…" : "Retry"}
        </button>
      )}
      {actionError && <div className="field-error" style={{ width: "100%" }}>{actionError}</div>}
    </div>
  );
}

export default function TaskQueueSection({
  tasks,
  optimisticTasks,
  onSelectTask,
  onNeedToken,
}: {
  tasks: TaskRecord[];
  optimisticTasks: OptimisticTask[];
  onSelectTask: (id: string) => void;
  onNeedToken: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});

  const active = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  const visibleOptimistic = optimisticTasks.filter((o) => !active.some((t) => t.issueNumber === o.issueNumber));

  async function handleAction(task: TaskRecord, kind: "cancel" | "retry") {
    const token = getToken();
    if (!token || task.issueNumber == null) {
      onNeedToken();
      return;
    }
    setBusyId(task.id);
    setErrorsById((prev) => ({ ...prev, [task.id]: "" }));
    try {
      if (kind === "cancel") {
        await closeIssue(token, task.issueNumber);
        removeOptimisticTask(task.issueNumber);
      } else {
        await reopenIssueWithRetryMarker(token, task.issueNumber);
      }
    } catch (err) {
      setErrorsById((prev) => ({ ...prev, [task.id]: err instanceof GitHubApiError ? err.message : "Action failed — check your connection." }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Task queue ({active.length + visibleOptimistic.length} active)</span>
      </div>
      {active.length === 0 && visibleOptimistic.length === 0 ? (
        <div className="empty">Nothing queued or in progress. File a task to get started.</div>
      ) : (
        <div>
          {visibleOptimistic.map((t) => (
            <OptimisticRow key={t.localId} task={t} onSelect={() => window.open(t.issueUrl, "_blank")} />
          ))}
          {active.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              onSelect={() => onSelectTask(t.id)}
              onAction={handleAction}
              busy={busyId === t.id}
              actionError={errorsById[t.id] || null}
            />
          ))}
        </div>
      )}
    </section>
  );
}
