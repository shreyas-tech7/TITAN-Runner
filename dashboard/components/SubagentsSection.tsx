"use client";

/**
 * The sub-agent cluster panel (build brief, section 5): the "+ queue a
 * task" field posting to the Worker's `POST /tasks`, and a live list of
 * `subagents` rows from `GET /status` — separate from, and never a
 * replacement for, `TaskQueueSection`'s GitHub-issue-backed queue above it.
 */
import { useState } from "react";
import { relative } from "@/lib/time";
import { queueTask, KNOWN_PROVIDERS, WorkerApiError, type SubagentRow, type SubagentStatus, type LearningPathRow } from "@/lib/workerApi";

const STATUS_META: Record<SubagentStatus, { label: string; dot: string; text: string }> = {
  queued: { label: "Queued", dot: "dot-idle", text: "text-muted" },
  dispatched: { label: "Dispatched", dot: "dot-warn dot-pulsing", text: "text-warning" },
  running: { label: "Running", dot: "dot-live dot-pulsing", text: "text-signal" },
  done: { label: "Done", dot: "dot-live", text: "text-signal" },
  failed: { label: "Failed", dot: "dot-fail", text: "text-failure" },
};

/**
 * Renders a learning path's stored tree (task brief, phase 4: "render this
 * generated learning/execution path in the TITAN dashboard under the task
 * status UI"). `tree` is opaque JSON from the model, so this degrades to a
 * plain "couldn't render" message rather than crashing on a shape it
 * doesn't recognize — the same defensive spirit `parseProbeJson`'s caller
 * already applies server-side.
 */
function LearningPathView({ path }: { path: LearningPathRow }) {
  let tree: { prerequisites?: Array<{ topic: string; reason: string }>; resources?: string[] } | null = null;
  try {
    tree = JSON.parse(path.tree);
  } catch {
    tree = null;
  }
  return (
    <div className="field-hint" style={{ width: "100%", marginTop: 4, paddingLeft: 12, borderLeft: "2px solid var(--warning-dim)" }}>
      <strong>Learning gap: {path.topic}</strong>
      {tree?.prerequisites && tree.prerequisites.length > 0 && (
        <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
          {tree.prerequisites.map((p, i) => (
            <li key={i}>
              {p.topic} — {p.reason}
            </li>
          ))}
        </ul>
      )}
      {tree?.resources && tree.resources.length > 0 && <div>Resources: {tree.resources.join(", ")}</div>}
      {!tree && <div>(learning path recorded but not renderable)</div>}
    </div>
  );
}

function SubagentRowView({ row, learningPath }: { row: SubagentRow; learningPath: LearningPathRow | undefined }) {
  const meta = STATUS_META[row.status] ?? STATUS_META.queued;
  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <span className={`dot ${meta.dot}`} aria-hidden />
      <span className="row-title" title={row.brief} style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {row.brief}
      </span>
      <span className="chip mono">{row.task_type}</span>
      <span className="chip">{row.source}</span>
      {row.provider && <span className="chip mono">{row.provider}</span>}
      <span className="row-quiet mono">{relative(row.finished_at ?? row.started_at ?? row.queued_at)}</span>
      <span className={`badge ${meta.text}`}>{meta.label}</span>
      {row.run_url && (
        <a className="mono text-quiet" href={row.run_url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
          run →
        </a>
      )}
      {row.result_summary && (
        <div className="field-hint" style={{ width: "100%", marginTop: 2 }}>
          {row.result_summary}
        </div>
      )}
      {learningPath && <LearningPathView path={learningPath} />}
    </div>
  );
}

export default function SubagentsSection({
  token,
  subagents,
  learningPaths,
  onQueued,
}: {
  token: string;
  subagents: SubagentRow[];
  learningPaths: LearningPathRow[];
  onQueued: () => void;
}) {
  const [taskType, setTaskType] = useState("auto");
  const [brief, setBrief] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justQueuedId, setJustQueuedId] = useState<string | null>(null);

  async function handleSubmit() {
    const trimmed = brief.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await queueTask(token, taskType, trimmed);
      setBrief("");
      setJustQueuedId(result.id);
      onQueued();
    } catch (err) {
      setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Sub-agent cluster ({subagents.length} recent)</span>
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label htmlFor="subagent-brief">Queue a task</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
          <select
            aria-label="Task type / provider routing"
            value={taskType}
            onChange={(e) => setTaskType(e.target.value)}
            style={{ maxWidth: 140 }}
          >
            <option value="auto">auto</option>
            {KNOWN_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <textarea
            id="subagent-brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Brief for the sub-agent cluster…"
            style={{ flex: 1, minWidth: 200, minHeight: 38 }}
          />
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!brief.trim() || submitting}>
            {submitting ? "Queuing…" : "Queue"}
          </button>
        </div>
        {error && <div className="field-error">{error}</div>}
        {justQueuedId && !error && (
          <div className="field-hint">
            Queued as <span className="mono">{justQueuedId}</span> — picked up by the next 1-minute Worker tick.
          </div>
        )}
      </div>

      {subagents.length === 0 ? (
        <div className="empty">No sub-agent rows yet — queue one above, or file a titan-task-labeled issue.</div>
      ) : (
        <div>
          {subagents.map((row) => (
            <SubagentRowView key={row.id} row={row} learningPath={learningPaths.find((p) => p.subagent_id === row.id)} />
          ))}
        </div>
      )}
    </section>
  );
}
