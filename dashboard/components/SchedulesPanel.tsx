"use client";

/**
 * Schedules panel (Wave 12, A2).
 *
 * Manages recurring tasks in D1 (`GET /schedules`, `POST /schedules`, `POST /schedules/:id/toggle`,
 * `POST /schedules/:id/run`, `DELETE /schedules/:id`) and shows the next 3 run times in the schedule's time zone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Panel } from "@/components/kit";
import { relative } from "@/lib/time";
import {
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  isWorkerConfigured,
  runScheduleNow,
  toggleSchedule,
  WorkerApiError,
  type ScheduleRecord,
} from "@/lib/workerApi";

export default function SchedulesPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [tz, setTz] = useState("America/Chicago");
  const [taskType, setTaskType] = useState("research");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!isWorkerConfigured()) return;
    try {
      const out = await fetchSchedules(token);
      if (alive.current) {
        setSchedules(out.schedules);
        setError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not load schedules.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function handleAdd() {
    if (!label.trim() || !brief.trim()) {
      setError("Give the schedule both a label and a task brief.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createSchedule(token, { label: label.trim(), cron: cron.trim(), tz: tz.trim(), taskType, brief: brief.trim() });
      setLabel("");
      setBrief("");
      setNotice("Schedule saved.");
      await load();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Could not create schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(s: ScheduleRecord) {
    try {
      await toggleSchedule(token, s.id, !s.enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update schedule.");
    }
  }

  async function handleRunNow(s: ScheduleRecord) {
    try {
      const out = await runScheduleNow(token, s.id);
      setNotice(out.taskId ? `Triggered ${s.label} (task ${out.taskId}).` : `Triggered ${s.label}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run schedule.");
    }
  }

  async function handleDelete(s: ScheduleRecord) {
    try {
      await deleteSchedule(token, s.id);
      setNotice(`Deleted ${s.label}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete schedule.");
    }
  }

  if (!isWorkerConfigured()) return null;

  return (
    <Panel
      title="Schedules"
      eyebrow="Cron tasks in D1"
      tone="corona"
      actions={
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
      }
    >
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="e-hint" role="status">
          {notice}
        </p>
      ) : null}

      <ul className="e-list" aria-label="Schedules">
        {(schedules ?? []).map((s) => (
          <li className="e-item" key={s.id} data-schedule={s.id}>
            <div className="e-item-head">
              <span className="e-item-title">{s.label}</span>
              <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "Enabled" : "Paused"}</Badge>
              <span className="e-num e-dim">
                {s.cron} ({s.tz})
              </span>
              {s.lastRunAt ? <span className="e-dim e-num">Last ran {relative(s.lastRunAt)}</span> : null}
            </div>
            <div className="e-dim">{s.brief}</div>
            {s.nextRuns.length > 0 ? (
              <div className="e-dim e-num" style={{ fontSize: "0.85em", marginTop: 4 }}>
                Next 3 runs: {s.nextRuns.map((r) => r.replace(".000Z", "Z")).join(" · ")}
              </div>
            ) : null}
            <div className="modal-actions" style={{ marginTop: 6 }}>
              <button className="btn btn-quiet" onClick={() => void handleToggle(s)}>
                {s.enabled ? "Pause" : "Resume"}
              </button>
              <button className="btn btn-quiet" onClick={() => void handleRunNow(s)}>
                Run now
              </button>
              {!s.builtIn ? (
                <button className="btn btn-quiet" onClick={() => void handleDelete(s)}>
                  Delete
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <details style={{ marginTop: 12 }}>
        <summary className="btn btn-quiet">+ Add recurring schedule</summary>
        <div style={{ marginTop: 10 }}>
          <div className="e-pair">
            <div className="field">
              <label htmlFor="sched-label">Label</label>
              <input id="sched-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Weekday paper digest" />
            </div>
            <div className="field">
              <label htmlFor="sched-cron">5-field Cron</label>
              <input id="sched-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" />
            </div>
          </div>
          <div className="e-pair">
            <div className="field">
              <label htmlFor="sched-tz">Time zone</label>
              <input id="sched-tz" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/Chicago" />
            </div>
            <div className="field">
              <label htmlFor="sched-type">Task type</label>
              <select id="sched-type" value={taskType} onChange={(e) => setTaskType(e.target.value)}>
                <option value="research">research</option>
                <option value="code">code</option>
                <option value="auto">auto</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="sched-brief">Task brief</label>
            <textarea id="sched-brief" rows={2} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Summarize new alignment papers…" />
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void handleAdd()}>
            {busy ? "Saving…" : "Save schedule"}
          </button>
        </div>
      </details>
    </Panel>
  );
}
