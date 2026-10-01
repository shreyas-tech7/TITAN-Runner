"use client";

import { usePolledJson } from "@/lib/usePolledJson";
import { OWNER, REPO } from "@/lib/githubApi";
import type { ResearchView, SafetyView } from "@/lib/types";

const REASON_LABEL: Record<string, string> = {
  rate_limited: "every provider was rate-limited",
  provider_down: "no provider was reachable",
  budget_exhausted: "free-tier quota was spent",
  "empty-response": "the model returned nothing usable",
  "provider-error": "the provider call failed",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

function ResearchCard({ view, missing }: { view: ResearchView | null; missing: boolean }) {
  const digest = view?.digest ?? null;
  const url = digest?.file ? `https://github.com/${OWNER}/${REPO}/blob/main/${digest.file}` : null;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Daily research digest</span>
        {view?.lastStatus === "skipped" && <span className="badge text-warning">last try skipped</span>}
        {view?.lastStatus === "written" && <span className="badge text-signal">written</span>}
      </div>
      {missing && <div className="empty">No digest yet. The first one is written by the first pulse of a day that has a free provider available.</div>}
      {!missing && !digest && <div className="empty">No digest written yet{view?.lastReason ? ` — last try skipped: ${REASON_LABEL[view.lastReason] ?? view.lastReason}` : ""}.</div>}
      {digest && (
        <>
          <div className="row-quiet mono" style={{ marginBottom: 8 }}>
            {digest.date} · {digest.provider ?? "?"}
            {digest.model ? ` (${digest.model})` : ""}
            {url && (
              <>
                {" · "}
                <a href={url} target="_blank" rel="noreferrer">full digest</a>
              </>
            )}
          </div>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 260, overflow: "auto", fontSize: 12 }}>{digest.preview ?? ""}</pre>
          <div className="text-quiet" style={{ fontSize: 11, marginTop: 8 }}>
            Written by a free-tier model from its own training knowledge — no web access, no live sources. Treat it as leads to verify.
          </div>
        </>
      )}
      {view?.lastStatus === "skipped" && digest && (
        <div className="text-quiet" style={{ fontSize: 11, marginTop: 4 }}>
          Latest attempt ({when(view.lastAttemptAt)}) was skipped: {REASON_LABEL[view.lastReason ?? ""] ?? view.lastReason ?? "unknown"}. It retries automatically.
        </div>
      )}
    </div>
  );
}

function RulesCard({ view, missing }: { view: SafetyView | null; missing: boolean }) {
  const a = view?.approvals;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Safety rules</span>
        {view && <span className="row-quiet mono">{view.rules.source}</span>}
      </div>
      {missing && <div className="empty">Rules view not published yet — it is written at the end of every pulse.</div>}
      {view && (
        <>
          <div className="label" style={{ marginBottom: 4 }}>Always asks a human first</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {view.rules.alwaysAsk.map((c) => (
              <span key={c} className="badge text-warning" title={view.rules.hardFloor.includes(c) ? "hard floor: cannot be loosened by the rules file" : undefined}>
                {c}{view.rules.hardFloor.includes(c) ? " 🔒" : ""}
              </span>
            ))}
          </div>
          <div className="label" style={{ marginBottom: 4 }}>Auto-approved</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {view.rules.autoApprove.map((c) => (
              <span key={c} className="badge text-signal">{c}</span>
            ))}
          </div>
          <div className="text-quiet" style={{ fontSize: 11, marginBottom: 8 }}>
            Anything unlisted: {view.rules.default === "ask" ? "asks first" : "allowed"}. The autonomy dial can only make this stricter.
          </div>
          {view.rules.warnings.map((w) => (
            <div key={w} className="text-warning" style={{ fontSize: 12 }}>⚠ {w}</div>
          ))}
          <div className="label" style={{ margin: "10px 0 4px" }}>
            Decisions humans made ({a?.approved ?? 0} approved · {a?.denied ?? 0} denied)
          </div>
          {(a?.recent.length ?? 0) === 0 && <div className="empty">No approve/deny decisions recorded yet.</div>}
          {a?.recent.slice(0, 5).map((r, i) => (
            <div key={`${r.at}-${i}`} className="row" style={{ display: "flex" }}>
              <span className="row-title">{r.category} · {r.taskId}</span>
              <span className="row-quiet mono">{r.by} · {when(r.at)}</span>
              <span className={`badge ${r.decision === "approved" ? "text-signal" : "text-failure"}`}>{r.decision}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * Read-only: the latest research digest and the safety rules in force with the
 * approve/deny history they are tuned from. Both come from derived views the
 * pulse writes (`state/views/research.json`, `state/views/safety.json`); a
 * view that does not exist yet is an empty state, not an error.
 */
export default function SafetyResearchPanel() {
  const research = usePolledJson<ResearchView>("state/views/research.json", 120_000);
  const safety = usePolledJson<SafetyView>("state/views/safety.json", 120_000);
  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Research &amp; safety</span>
        <span className="text-quiet" style={{ fontSize: 11 }}>read-only — edit config/ on GitHub</span>
      </div>
      <div className="bento-grid">
        <ResearchCard view={research.data} missing={!research.loading && !research.data} />
        <RulesCard view={safety.data} missing={!safety.loading && !safety.data} />
      </div>
    </section>
  );
}
