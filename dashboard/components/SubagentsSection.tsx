"use client";

/**
 * The sub-agent cluster panel (build brief, section 5): the "+ queue a
 * task" field posting to the Worker's `POST /tasks`, and a live list of
 * `subagents` rows from `GET /status` — separate from, and never a
 * replacement for, `TaskQueueSection`'s GitHub-issue-backed queue above it.
 */
import { useState } from "react";
import { relative } from "@/lib/time";
import { Badge, Panel, StatusDot, type Tone } from "@/components/kit";
import { queueTask, KNOWN_PROVIDERS, WorkerApiError, type SubagentRow, type SubagentStatus, type LearningPathRow } from "@/lib/workerApi";

const STATUS_META: Record<SubagentStatus, { label: string; tone: Tone; pulse: boolean }> = {
  queued: { label: "Queued", tone: "neutral", pulse: false },
  dispatched: { label: "Dispatched", tone: "warn", pulse: true },
  running: { label: "Running", tone: "plasma", pulse: true },
  done: { label: "Done", tone: "ok", pulse: false },
  failed: { label: "Failed", tone: "danger", pulse: false },
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
    <div className="e-learn">
      <strong>Learning gap: {path.topic}</strong>
      {tree?.prerequisites && tree.prerequisites.length > 0 && (
        <ul>
          {tree.prerequisites.map((p, i) => (
            <li key={i}>
              {p.topic}: {p.reason}
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
    <li className="e-item">
      <div className="e-item-head">
        <StatusDot tone={meta.tone} pulse={meta.pulse} label={meta.label} />
        <span className="e-item-title" title={row.brief}>
          {row.brief}
        </span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <div className="e-item-head">
        <Badge tone="plasma">{row.task_type}</Badge>
        <Badge>{row.source}</Badge>
        {row.provider && <Badge tone="ion">{row.provider}</Badge>}
        <span className="e-dim e-num">{relative(row.finished_at ?? row.started_at ?? row.queued_at)}</span>
        {row.run_url && (
          <span className="e-item-links">
            <a href={row.run_url} target="_blank" rel="noreferrer">
              View run
            </a>
          </span>
        )}
      </div>
      {row.result_summary && <div className="e-hint">{row.result_summary}</div>}
      {learningPath && <LearningPathView path={learningPath} />}
    </li>
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
    <Panel title="Sub-agent cluster" eyebrow="Agents" tone="plasma" actions={<Badge tone="neutral">{subagents.length} recent</Badge>}>
      <div className="e-form">
        <label htmlFor="subagent-brief">Queue a task</label>
        <div className="e-form-row">
          <select aria-label="Task type / provider routing" value={taskType} onChange={(e) => setTaskType(e.target.value)} style={{ maxWidth: 140 }}>
            <option value="auto">auto</option>
            {KNOWN_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <textarea id="subagent-brief" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Brief for the sub-agent cluster…" />
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!brief.trim() || submitting}>
            {submitting ? "Queuing…" : "Queue"}
          </button>
        </div>
        {error && <div className="e-error" role="alert">{error}</div>}
        {justQueuedId && !error && (
          <div className="e-hint">
            Queued as <span className="e-num">{justQueuedId}</span>. The next 1-minute Worker tick picks it up.
          </div>
        )}
      </div>

      {subagents.length === 0 ? (
        <p className="e-dim">No sub-agent rows yet. Queue one above, or file a titan-task-labeled issue.</p>
      ) : (
        <ul className="e-list" aria-label="Recent sub-agent tasks">
          {subagents.map((row) => (
            <SubagentRowView key={row.id} row={row} learningPath={learningPaths.find((p) => p.subagent_id === row.id)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
