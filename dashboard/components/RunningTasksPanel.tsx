"use client";

/**
 * The command center's live operations feed — merges the two real sources
 * of "TITAN is doing something right now" this repo already has: the task
 * queue (`state/tasks.json`, polled at the page level) and the optional
 * sub-agent cluster (`GET /status`'s `subagents`, only present once the
 * titan-runner-brain Worker is deployed). No fabricated progress
 * percentages — there is no such field anywhere in this data, so a running
 * item gets an honest indeterminate progress indicator, not an invented
 * number.
 */
import { useEffect, useState } from "react";
import { WAIT_REASON_LABEL } from "@/lib/statusMeta";
import type { TaskRecord } from "@/lib/types";
import type { SubagentRow } from "@/lib/workerApi";
import { formatElapsed } from "@/lib/time";

type LiveStatus = "running" | "waiting";

interface LiveItem {
  id: string;
  title: string;
  source: string;
  status: LiveStatus;
  statusLabel: string;
  dotClass: string;
  startedAt: string | null;
}

function taskToLiveItem(t: TaskRecord): LiveItem | null {
  if (t.status === "running") {
    return {
      id: `task-${t.id}`,
      title: t.title || t.id,
      source: t.type === "self-improve" ? "self-improvement" : "task",
      status: "running",
      statusLabel: "Running",
      dotClass: "dot-live dot-pulsing",
      startedAt: t.startedAt ?? t.claimedAt ?? t.createdAt,
    };
  }
  if (t.status === "pending" || t.status === "waiting" || t.status === "paused") {
    return {
      id: `task-${t.id}`,
      title: t.title || t.id,
      source: t.type === "self-improve" ? "self-improvement" : "task",
      status: "waiting",
      statusLabel: t.status === "waiting" ? `Waiting on ${WAIT_REASON_LABEL[t.waitReason ?? ""] ?? t.waitReason ?? "…"}` : t.status === "paused" ? "Paused" : "Queued",
      dotClass: "dot-idle",
      startedAt: t.claimedAt ?? t.createdAt,
    };
  }
  return null;
}

function subagentToLiveItem(s: SubagentRow): LiveItem | null {
  if (s.status === "running" || s.status === "dispatched") {
    return {
      id: `sub-${s.id}`,
      title: s.brief || s.task_type,
      source: `sub-agent · ${s.provider ?? s.task_type}`,
      status: "running",
      statusLabel: s.status === "running" ? "Running" : "Dispatched",
      dotClass: "dot-live dot-pulsing",
      startedAt: s.started_at ?? s.queued_at,
    };
  }
  if (s.status === "queued") {
    return {
      id: `sub-${s.id}`,
      title: s.brief || s.task_type,
      source: `sub-agent · ${s.task_type}`,
      status: "waiting",
      statusLabel: "Queued",
      dotClass: "dot-idle",
      startedAt: s.queued_at,
    };
  }
  return null;
}

export default function RunningTasksPanel({
  tasks,
  subagents,
  workerConfigured,
}: {
  tasks: TaskRecord[];
  subagents: SubagentRow[];
  workerConfigured: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const items = [...tasks.map(taskToLiveItem), ...subagents.map(subagentToLiveItem)]
    .filter((x): x is LiveItem => x !== null)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "running" ? -1 : 1;
      return Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? "");
    });

  const runningCount = items.filter((i) => i.status === "running").length;

  return (
    <div className="panel panel-interactive panel-enter">
      <div className="panel-head">
        <div className="panel-title">
          <span className={`dot ${runningCount > 0 ? "dot-live dot-pulsing" : "dot-idle"}`} aria-hidden />
          Running tasks {items.length > 0 && <span className="text-quiet">({items.length})</span>}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          Nothing running right now. TITAN is idle — waiting on the next pulse
          {workerConfigured ? " or a queued sub-agent job" : ""}.
        </div>
      ) : (
        <div>
          {items.map((item) => {
            const elapsedMs = item.startedAt ? now - Date.parse(item.startedAt) : null;
            return (
              <div className="live-row" key={item.id}>
                <span className={`dot ${item.dotClass}`} aria-hidden />
                <div className="live-row-main">
                  <div className="live-row-title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="live-row-meta mono">
                    <span>{item.source}</span>
                    {elapsedMs !== null && Number.isFinite(elapsedMs) && (
                      <span>{item.status === "running" ? `running ${formatElapsed(elapsedMs)}` : `waiting ${formatElapsed(elapsedMs)}`}</span>
                    )}
                  </div>
                  {item.status === "running" && (
                    <div className="progress-track live-row-progress">
                      <div className="progress-fill progress-fill-indeterminate" />
                    </div>
                  )}
                </div>
                <span className={`badge ${item.status === "running" ? "text-signal" : "text-quiet"}`}>{item.statusLabel}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
