"use client";

import type { TaskRecord } from "@/lib/types";
import { STATUS_META } from "@/lib/statusMeta";
import { relative } from "@/lib/time";

const TERMINAL_STATUSES = new Set(["complete", "failed", "blocked", "cancelled"]);

export default function RunHistorySection({ tasks, onSelectTask }: { tasks: TaskRecord[]; onSelectTask: (id: string) => void }) {
  const recent = tasks
    .filter((t) => TERMINAL_STATUSES.has(t.status))
    .slice()
    .reverse()
    .slice(0, 30);

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Recent run history</span>
      </div>
      {recent.length === 0 ? (
        <div className="empty">No completed runs yet.</div>
      ) : (
        <div>
          {recent.map((t) => {
            const meta = STATUS_META[t.status] ?? STATUS_META.pending;
            return (
              <button key={t.id} className="row row-button" style={{ width: "100%" }} onClick={() => onSelectTask(t.id)}>
                <span className={`dot ${meta.dot}`} aria-hidden />
                <span className="row-title">{t.title || t.id}</span>
                <span className="row-quiet mono">{relative(t.completedAt ?? t.createdAt)}</span>
                <span className={`badge ${meta.text}`}>{meta.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
