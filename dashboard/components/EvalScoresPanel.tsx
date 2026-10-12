"use client";

import { Badge, Meter, Panel } from "@/components/kit";
import { Freshness, MirrorBody, type MirrorInput } from "@/components/OpsShared";
import { STALE_AFTER_MS, evalCards, utcStamp, type EvalMirror } from "@/lib/opsView";

/**
 * The weekly golden task scores, from `state/ops/eval.json`. Fifteen small tasks cover the 12 categories, and a fixed
 * checker (an exact answer, a pattern, a schema, or a unit test) scores each answer. No model judges another model.
 * The router prefers a measured score over its own assumption.
 */
export default function EvalScoresPanel({ evalScores, now }: { evalScores: MirrorInput<EvalMirror>; now?: number }) {
  return (
    <Panel
      title="Eval scores"
      eyebrow="Weekly golden tasks"
      tone="plasma"
      actions={<Freshness at={evalScores.data?.generated_at} maxAgeMs={STALE_AFTER_MS.eval} now={now} />}
    >
      <MirrorBody input={evalScores} what="the eval scores" emptyText="No eval has run yet. The weekly run, on Sunday, fills this panel." isEmpty={(d) => evalCards(d).length === 0}>
        {(data) => (
          <div className="ops-cards" aria-label="Eval score of each model">
            {evalCards(data).map((card, i) => (
              <details key={card.model} className="ops-card" open={i === 0} data-model={card.model}>
                <summary>
                  <span className="e-row-name">{card.model}</span>
                  <Badge tone={card.tone}>{card.averagePct}% average</Badge>
                  <span className="e-dim e-num">{card.tasksRun} task{card.tasksRun === 1 ? "" : "s"}</span>
                </summary>
                <ul className="e-rows" aria-label={`Scores of ${card.model} by category`}>
                  {card.categories.map((c) => (
                    <li key={c.category} className="e-row">
                      <div className="e-row-head">
                        <span className="e-row-figure">{c.label}</span>
                        <span className="e-row-figure e-num">{c.pct}%</span>
                      </div>
                      <Meter value={c.score} max={1} tone={c.tone} label={`${card.model} ${c.label}`} text={`${c.pct} percent over ${c.tasksRun} task${c.tasksRun === 1 ? "" : "s"}`} />
                    </li>
                  ))}
                </ul>
                <p className="e-note">Eval {card.version ?? "version unknown"}, run {utcStamp(card.runAt)}.</p>
              </details>
            ))}
          </div>
        )}
      </MirrorBody>
    </Panel>
  );
}
