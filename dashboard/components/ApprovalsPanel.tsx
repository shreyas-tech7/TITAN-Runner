"use client";

/**
 * Calls that wait for a person (Wave 12, C3). A write action from a sub-agent or a tool does not run on its own. It lands here,
 * and it runs one time after the person chooses Approve. An approval ends after 24 hours. The same decision works in Telegram.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/kit";
import { decideApproval, fetchApprovals, type Approval } from "@/lib/connectorsApi";
import { DATA_CLASS_META, RISK_META } from "@/lib/connectorsView";
import { relative, until } from "@/lib/time";
import { WorkerApiError } from "@/lib/workerApi";

const DONE_TONE: Record<Approval["status"], "ok" | "warn" | "danger" | "neutral" | "corona"> = {
  pending: "corona", approved: "neutral", executed: "ok", failed: "danger", denied: "neutral", expired: "warn",
};

export default function ApprovalsPanel({ token, onUnauthorized, onChanged }: { token: string; onUnauthorized: () => void; onChanged?: () => void }) {
  const [items, setItems] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await fetchApprovals(token);
      if (alive.current) {
        setItems(out.approvals);
        setError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not read the approvals.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = window.setInterval(() => void load(), 20_000);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [load]);

  async function decide(a: Approval, decision: "approve" | "deny") {
    setBusy(a.id);
    setNotice(null);
    let message: string;
    try {
      const out = await decideApproval(token, a.id, decision);
      message = decision === "deny" ? `Denied: ${a.summary}` : out.status === "executed" ? `Approved and done: ${a.summary}` : `Approved, but the call failed: ${out.error ?? "unknown error"}`;
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      message = err instanceof Error ? err.message : "Could not record the decision.";
    }
    // Refresh the list first, so the notice never sits next to a call that already ran.
    await load();
    setNotice(message);
    onChanged?.();
    setBusy(null);
  }

  const pending = (items ?? []).filter((a) => a.status === "pending");
  const decided = (items ?? []).filter((a) => a.status !== "pending").slice(0, 10);

  return (
    <div aria-live="polite">
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {items === null && !error ? <p className="e-dim" role="status">Loading the approvals</p> : null}
      {notice ? <p className="e-hint" role="status">{notice}</p> : null}
      {items !== null && pending.length === 0 ? <p className="e-dim">No call waits for you. A write action from a sub-agent or a tool appears here before it runs.</p> : null}

      <ul className="e-list" aria-label="Calls that wait for approval">
        {pending.map((a) => (
          <li className="e-item" key={a.id} data-approval={a.id}>
            <div className="e-item-head">
              <span className="e-item-title">{a.summary}</span>
              <Badge tone={RISK_META[a.risk].tone}>{RISK_META[a.risk].label}</Badge>
              <Badge tone={DATA_CLASS_META[a.dataClass].tone}>{DATA_CLASS_META[a.dataClass].label}</Badge>
            </div>
            <div className="e-dim">Asked by <span className="e-num">{a.requestedBy}</span> {relative(a.createdAt)}. It ends {until(a.expiresAt)}.</div>
            <div className="modal-actions" style={{ marginTop: 4 }}>
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => void decide(a, "approve")}>Approve</button>
              <button className="btn" disabled={busy !== null} onClick={() => void decide(a, "deny")}>Deny</button>
            </div>
          </li>
        ))}
      </ul>

      {decided.length > 0 ? (
        <>
          <h3 className="guide-title" style={{ marginTop: 16 }}>Decided</h3>
          <ul className="e-list" aria-label="Decided calls">
            {decided.map((a) => (
              <li className="e-item" key={a.id}>
                <div className="e-item-head">
                  <Badge tone={DONE_TONE[a.status]}>{a.status}</Badge>
                  <span className="e-item-title">{a.summary}</span>
                  <span className="e-dim e-num">{relative(a.decidedAt ?? a.createdAt)}</span>
                </div>
                {a.error ? <div className="e-dim">{a.error}</div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
