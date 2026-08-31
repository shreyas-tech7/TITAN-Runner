"use client";

import { useEffect, useState } from "react";
import type { TaskRecord, RunRecord } from "@/lib/types";
import { STATUS_META } from "@/lib/statusMeta";
import { relative, formatDuration } from "@/lib/time";

const OWNER = process.env.NEXT_PUBLIC_GITHUB_OWNER || "shreyas-tech7";
const REPO = process.env.NEXT_PUBLIC_GITHUB_REPO || "TITAN-Runner";

function useRunRecord(runId: string | null) {
  const [state, setState] = useState<{ data: RunRecord | null; loading: boolean; error: string | null }>({
    data: null,
    loading: Boolean(runId),
    error: null,
  });

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/main/state/runs/${runId}.json?t=${Date.now()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`run record responded ${res.status} — it may have been pruned into a weekly digest already`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return state;
}

export default function TaskDetailDrawer({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  const run = useRunRecord(task.runId);
  const meta = STATUS_META[task.status] ?? STATUS_META.pending;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label={`Task detail: ${task.title}`}>
        <div className="modal-head">
          <h2 className="modal-title" style={{ fontSize: 15 }}>
            {task.title || task.id}
          </h2>
          <button className="btn btn-quiet" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
          <span className={`badge ${meta.text}`}>
            <span className={`dot ${meta.dot}`} /> {meta.label}
          </span>
          {task.priority && <span className="chip">{task.priority} priority</span>}
          {task.routingHint && task.routingHint !== "any" && <span className="chip">{task.routingHint} routing</span>}
          {task.issueUrl && (
            <a className="text-muted" style={{ fontSize: 12 }} href={task.issueUrl} target="_blank" rel="noreferrer">
              Issue #{task.issueNumber} →
            </a>
          )}
        </div>

        <div className="label" style={{ marginBottom: 6 }}>
          Prompt
        </div>
        <p className="text-muted" style={{ fontSize: 13, whiteSpace: "pre-wrap", marginTop: 0, marginBottom: 16 }}>
          {task.prompt}
        </p>

        <div className="pulse-grid" style={{ marginBottom: 16 }}>
          <div className="metric">
            <div className="label">Filed</div>
            <div className="value mono" style={{ fontSize: 13 }}>
              {relative(task.createdAt)}
            </div>
          </div>
          <div className="metric">
            <div className="label">Completed</div>
            <div className="value mono" style={{ fontSize: 13 }}>
              {relative(task.completedAt)}
            </div>
          </div>
        </div>

        {task.error && (
          <div style={{ marginBottom: 16 }}>
            <div className="label" style={{ marginBottom: 6 }}>
              Error
            </div>
            <div className="text-failure mono" style={{ fontSize: 12 }}>
              {task.error}
            </div>
          </div>
        )}

        <div className="label" style={{ marginBottom: 6, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          Subtask decomposition
        </div>

        {!task.runId && <div className="empty">No run yet — this task hasn&apos;t been claimed by a pulse.</div>}
        {task.runId && run.loading && <div className="empty">Loading run record…</div>}
        {task.runId && run.error && <div className="empty text-failure">{run.error}</div>}
        {run.data && (
          <>
            {run.data.actionsRunUrl && (
              <a className="btn btn-quiet" style={{ marginBottom: 12 }} href={run.data.actionsRunUrl} target="_blank" rel="noreferrer">
                Open exact Actions run →
              </a>
            )}
            {run.data.tasks.map((sub) => (
              <div key={sub.id} className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span className="row-title" style={{ fontWeight: 600 }}>
                    {sub.title}
                  </span>
                  <span className={`badge ${sub.state === "complete" ? "text-signal" : "text-failure"}`}>{sub.state}</span>
                </div>
                <div className="row-quiet mono">aspect: {sub.aspect}</div>
                {sub.assignment && (
                  <div className="row-quiet mono">
                    assigned: {sub.assignment.modelId} ({sub.assignment.reason})
                  </div>
                )}
                {sub.attempts.length > 0 && (
                  <div className="row-quiet mono">
                    {sub.attempts.map((a, i) => (
                      <div key={i}>
                        {a.pool}/{a.modelId} — {a.ok ? "ok" : "failed"} — {formatDuration(a.ms)}
                        {a.tokensUsed != null ? ` — ${a.tokensUsed} tokens` : ""}
                      </div>
                    ))}
                  </div>
                )}
                {sub.outputPreview && (
                  <details>
                    <summary className="text-muted" style={{ fontSize: 12, cursor: "pointer" }}>
                      Output preview
                    </summary>
                    <pre className="mono" style={{ fontSize: 11, whiteSpace: "pre-wrap", background: "var(--bg-2)", padding: 8, borderRadius: 3 }}>
                      {sub.outputPreview}
                    </pre>
                  </details>
                )}
              </div>
            ))}

            <div className="label" style={{ margin: "16px 0 6px", borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              Final output
            </div>
            <pre className="mono" style={{ fontSize: 12, whiteSpace: "pre-wrap", background: "var(--bg-2)", padding: 10, borderRadius: 3 }}>
              {run.data.markdownSummary || "(no summary)"}
            </pre>
          </>
        )}
      </div>
    </>
  );
}
