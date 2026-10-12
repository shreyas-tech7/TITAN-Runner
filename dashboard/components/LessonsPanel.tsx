"use client";

import { Badge, Panel } from "@/components/kit";
import type { MirrorInput } from "@/components/OpsShared";
import type { Lesson } from "@/lib/opsView";
import { relative } from "@/lib/time";

/**
 * What the post-mortems learned, from `state/lessons.jsonl`. A failed task gets a short post-mortem, and a repeat of
 * the same failure raises the count instead of adding a line. The planner reads the 5 most relevant lessons before it
 * plans. The text holds no task title, prompt, or answer, because this repository is public.
 */
export default function LessonsPanel({ lessons, now }: { lessons: MirrorInput<Lesson[]>; now?: number }) {
  const list = lessons.data ?? [];
  return (
    <Panel title="Lessons" eyebrow="Post-mortems" tone="corona" actions={list.length > 0 ? <Badge tone="neutral">{list.length} shown</Badge> : null}>
      {lessons.loading && !lessons.data ? (
        <p className="e-dim">Loading the lessons…</p>
      ) : list.length === 0 ? (
        <p className="e-dim">No lessons yet. A task that fails writes one, and the planner reads it next time.</p>
      ) : (
        <ul className="e-list" aria-label="Lessons from failed tasks">
          {list.map((l) => (
            <li key={l.id} className="e-item" data-lesson={l.id}>
              <div className="e-item-head">
                <Badge tone={l.count >= 3 ? "warn" : "neutral"}>{l.count === 1 ? "once" : `${l.count} times`}</Badge>
                <span className="e-item-title">{l.what_failed}</span>
                <span className="e-dim e-num">last {relative(l.last_seen || null, now)}</span>
              </div>
              {l.likely_cause ? <div className="e-dim">Likely cause: {l.likely_cause}</div> : null}
              {l.suggested_fix ? <div className="e-dim">Suggested fix: {l.suggested_fix}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
