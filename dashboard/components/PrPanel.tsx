"use client";

import { useEffect, useState } from "react";
import { getToken } from "@/lib/token";
import { listOpenSelfImprovePulls, getPull, getCheckSummary, type PullDetail, type CheckSummary } from "@/lib/githubApi";

interface Row extends PullDetail {
  checkSummary: CheckSummary;
}

const CHECK_META: Record<CheckSummary, { label: string; cls: string }> = {
  success: { label: "Passing", cls: "text-signal" },
  failure: { label: "Failing", cls: "text-failure" },
  pending: { label: "Running", cls: "text-warning" },
  none: { label: "No checks yet", cls: "text-quiet" },
};

/**
 * Read-only list of open agent-authored PRs (task instructions, section 3)
 * — branch prefix `self-improve/` per `src/selfImprove.js`. Merging is a
 * human decision, made on GitHub; this panel never offers a merge button.
 */
export default function PrPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    (async () => {
      try {
        const pulls = await listOpenSelfImprovePulls(token);
        const details = await Promise.all(
          pulls.map(async (p) => {
            const [detail, checkSummary] = await Promise.all([getPull(token, p.number), getCheckSummary(token, p.head.sha)]);
            return { ...detail, checkSummary };
          }),
        );
        if (!cancelled) setRows(details);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load pull requests.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Self-improvement PRs</span>
        <span className="text-quiet" style={{ fontSize: 11 }}>
          read-only — merge on GitHub
        </span>
      </div>
      {error && <div className="empty text-failure">{error}</div>}
      {!error && rows === null && <div className="empty">Loading…</div>}
      {!error && rows !== null && rows.length === 0 && <div className="empty">No open self-improvement pull requests.</div>}
      {rows && rows.length > 0 && (
        <div>
          {rows.map((pr) => {
            const check = CHECK_META[pr.checkSummary];
            return (
              <a key={pr.number} className="row row-button" style={{ display: "flex" }} href={pr.html_url} target="_blank" rel="noreferrer">
                <span className="row-title">{pr.title}</span>
                <span className="row-quiet mono">
                  +{pr.additions}/-{pr.deletions} · {pr.changed_files} file(s)
                </span>
                <span className={`badge ${check.cls}`}>{check.label}</span>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
