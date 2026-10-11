"use client";

/**
 * Unified Activity Timeline (Wave 12, A5 and X16).
 *
 * Displays one chronological feed of sub-agent tasks, provider key events, connector calls, approvals, schedules, and
 * Worker deploys (`GET /activity`), with category filter chips.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Panel } from "@/components/kit";
import { relative } from "@/lib/time";
import { fetchActivity, isWorkerConfigured, WorkerApiError, type ActivityItem } from "@/lib/workerApi";

const FILTERS: Array<{ id: string; label: string }> = [
  { id: "", label: "All" },
  { id: "task", label: "Tasks" },
  { id: "key", label: "Keys" },
  { id: "connector", label: "Connectors" },
  { id: "approval", label: "Approvals" },
  { id: "schedule", label: "Schedules" },
  { id: "deploy", label: "Deploys" },
];

export default function ActivityPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [kind, setKind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!isWorkerConfigured()) return;
    try {
      const out = await fetchActivity(token, kind, 40);
      if (alive.current) {
        setItems(out.items);
        setError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not load activity.");
    }
  }, [token, kind, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  if (!isWorkerConfigured()) return null;

  return (
    <Panel
      title="Activity Timeline"
      eyebrow="Tasks, keys, connectors, approvals, schedules, and deploys"
      tone="plasma"
      actions={
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
      }
    >
      <div className="chip-row" role="group" aria-label="Activity category">
        {FILTERS.map((f) => (
          <button key={f.id || "all"} className="chip-button" aria-pressed={kind === f.id} onClick={() => setKind(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {items !== null && items.length === 0 ? <p className="e-dim">No activity in this category yet.</p> : null}
      <ul className="e-list" aria-label="Activity items">
        {(items ?? []).slice(0, 20).map((item) => (
          <li className="e-item" key={item.id} data-activity-kind={item.kind}>
            <div className="e-item-head">
              <Badge tone={item.kind === "deploy" ? "corona" : item.status === "ok" || item.status === "done" ? "ok" : "neutral"}>
                {item.kind}
              </Badge>
              <span className="e-item-title">{item.title}</span>
              <span className="e-dim e-num">{relative(item.at)}</span>
            </div>
            {item.detail ? <div className="e-dim">{item.detail}</div> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
