"use client";

/**
 * OSINT investigation panel (task brief, phase 2). This form is the ONLY
 * UI path that can create an OSINT-category sub-agent task — it calls
 * POST /osint/investigate, which is gated by the same admin token that
 * already gates this entire dashboard (AdminGate) and every other write
 * route on the Worker. A public GitHub issue can never reach this path;
 * see worker/src/index.js's own doc comment on that route and
 * mirrorGithubIssues()'s hardcoded task_type='auto'.
 */
import { useState } from "react";
import { relative } from "@/lib/time";
import { investigateOsint, ingestOsintTools, WorkerApiError, type SubagentRow } from "@/lib/workerApi";

export default function OsintPanel({
  token,
  subagents,
  onQueued,
}: {
  token: string;
  subagents: SubagentRow[];
  onQueued: () => void;
}) {
  const [targetLabel, setTargetLabel] = useState("");
  const [category, setCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQueued, setLastQueued] = useState<{ id: string; tool: string | null } | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestMessage, setIngestMessage] = useState<string | null>(null);

  const osintRows = subagents.filter((r) => r.task_type === "osint");

  async function handleSubmit() {
    const trimmed = targetLabel.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await investigateOsint(token, trimmed, category.trim());
      setTargetLabel("");
      setLastQueued({ id: result.id, tool: result.tool });
      onQueued();
    } catch (err) {
      setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleIngest() {
    setIngesting(true);
    setIngestMessage(null);
    try {
      const result = await ingestOsintTools(token);
      setIngestMessage(`Parsed ${result.parsed} tools, inserted ${result.inserted} new.`);
    } catch (err) {
      setIngestMessage(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    } finally {
      setIngesting(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">OSINT investigation ({osintRows.length} recent)</span>
        <button className="btn btn-quiet" onClick={handleIngest} disabled={ingesting} style={{ fontSize: 11 }}>
          {ingesting ? "Ingesting…" : "Refresh tool catalog"}
        </button>
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label htmlFor="osint-target">
          Target to investigate — visible on the /ops/geospatial globe if a location is resolved
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
          <input
            id="osint-target"
            value={targetLabel}
            onChange={(e) => setTargetLabel(e.target.value)}
            placeholder="e.g. an IP address, domain, or username"
            style={{ flex: 1, minWidth: 200 }}
          />
          <input
            aria-label="Category hint (optional)"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="category (optional)"
            style={{ maxWidth: 180 }}
          />
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!targetLabel.trim() || submitting}>
            {submitting ? "Queuing…" : "Investigate"}
          </button>
        </div>
        {error && <div className="field-error">{error}</div>}
        {ingestMessage && <div className="field-hint">{ingestMessage}</div>}
        {lastQueued && !error && (
          <div className="field-hint">
            Queued as <span className="mono">{lastQueued.id}</span>
            {lastQueued.tool && (
              <>
                {" "}
                — suggested tool: <span className="mono">{lastQueued.tool}</span>
              </>
            )}
          </div>
        )}
        <p className="field-hint" style={{ marginTop: 8 }}>
          This is the only way an OSINT task can be created — a public GitHub issue can never
          reach this path. Only use it for targets you are authorized to investigate.
        </p>
      </div>

      {osintRows.length === 0 ? (
        <div className="empty">No OSINT investigations yet.</div>
      ) : (
        <div>
          {osintRows.map((row) => (
            <div className="row" key={row.id} style={{ flexWrap: "wrap" }}>
              <span
                className={`dot ${row.status === "done" ? "dot-live" : row.status === "failed" ? "dot-fail" : "dot-warn dot-pulsing"}`}
                aria-hidden
              />
              <span className="row-title" title={row.brief} style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.brief}
              </span>
              <span className="row-quiet mono">{relative(row.finished_at ?? row.started_at ?? row.queued_at)}</span>
              <span className="badge text-quiet">{row.status}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
