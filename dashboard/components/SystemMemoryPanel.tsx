"use client";

/**
 * Hermes self-improvement panel (task brief, phase 5). Read-only: the
 * dashboard never writes system_memory — only run-subagent-task.mjs's
 * meta-lesson analysis does, via POST /internal/system-memory (see
 * worker/src/index.js). This just polls GET /system-memory so a maintainer
 * can see what future sub-agent tasks are currently being told.
 */
import { useCallback, useEffect, useState } from "react";
import { relative } from "@/lib/time";
import { fetchSystemMemory, WorkerApiError, type SystemMemoryRow } from "@/lib/workerApi";

export default function SystemMemoryPanel({ token }: { token: string }) {
  const [lessons, setLessons] = useState<SystemMemoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchSystemMemory(token);
      setLessons(result.lessons);
      setError(null);
    } catch (err) {
      setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    }
  }, [token]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Hermes lessons learned{lessons ? ` (${lessons.length})` : ""}</span>
        <span className="text-quiet" style={{ fontSize: 11 }}>
          worker/src/meta-agent.js, every 6h — full audit trail in system_memory_audit
        </span>
      </div>
      {error && <div className="empty">{error}</div>}
      {!error && lessons === null && <div className="empty">Loading…</div>}
      {!error && lessons?.length === 0 && (
        <div className="empty">No lessons recorded yet — the meta-agent hasn&apos;t found an analyzable failure.</div>
      )}
      {lessons && lessons.length > 0 && (
        <div>
          {lessons.map((l) => (
            <div className="row" key={l.id} style={{ flexWrap: "wrap" }}>
              <span className="chip mono">{l.category}</span>
              <span className="row-title" style={{ flex: 1 }}>
                {l.lesson}
              </span>
              <span className="row-quiet mono">{relative(l.created_at)}</span>
              <div className="field-hint" style={{ width: "100%", marginTop: 2 }}>
                Injected into future tasks: {l.prompt_injection}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
