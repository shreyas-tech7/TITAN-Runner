"use client";

/**
 * The Health Center (Wave 12, H1 and H2): one row for each part of TITAN. A row shows the state in words, the time of the
 * last check, the latency, and a fix when something is wrong. "Not tested" is its own state and is never green. The full
 * diagnosis makes a report that holds no secret, so a person can copy it into a bug report.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import CopyButton from "@/components/CopyButton";
import HealthUrlsEditor from "@/components/HealthUrlsEditor";
import RunnerCallbacks from "@/components/RunnerCallbacks";
import { Badge, Panel } from "@/components/kit";
import { fetchHealth, runDiagnosis, type DiagnosisResponse, type HealthResponse, type HealthRow } from "@/lib/healthApi";
import { HEALTH_STATE_META, fixHref, groupRows, isExternalHref, overallLine } from "@/lib/healthView";
import { relative } from "@/lib/time";
import { WorkerApiError, isWorkerConfigured } from "@/lib/workerApi";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

function Row({ row }: { row: HealthRow }) {
  const meta = HEALTH_STATE_META[row.state];
  const fix = row.fix;
  return (
    <li className="e-item" data-health={row.id} data-state={row.state}>
      <div className="e-item-head">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="e-item-title">{row.label}</span>
        <span className="e-dim e-num">
          {row.latencyMs !== null ? `${row.latencyMs} ms · ` : ""}
          {relative(row.checkedAt)}
        </span>
      </div>
      <div className="e-dim">{row.detail}</div>
      {fix && row.state !== "ok" ? (
        <div className="e-item-links">
          <span>{fix.text}</span>
          {fix.action ? (
            <a href={fixHref(fix.action.href, BASE)} {...(isExternalHref(fix.action.href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{fix.action.label}</a>
          ) : null}
          {fix.doc ? (
            <a href={fix.doc} target="_blank" rel="noopener noreferrer">Read the guide</a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function DiagnosisBox({ report }: { report: DiagnosisResponse }) {
  return (
    <div role="status" aria-live="polite">
      <p className="e-dim">
        {report.summary.ok} working, {report.summary.warn} need a look, {report.summary.down} not working, {report.summary.unknown} not tested. The report holds no secret.
      </p>
      <table className="keys-table">
        <caption className="sr-only">Full diagnosis</caption>
        <thead>
          <tr><th scope="col">Check</th><th scope="col">State</th><th scope="col">Detail</th></tr>
        </thead>
        <tbody>
          {report.items.map((i) => (
            <tr key={i.id} data-diagnosis={i.id} data-state={i.state}>
              <td data-label="Check">{i.label}</td>
              <td data-label="State"><Badge tone={HEALTH_STATE_META[i.state].tone}>{HEALTH_STATE_META[i.state].label}</Badge></td>
              <td data-label="Detail" className="e-dim">{i.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre className="result-box" tabIndex={0} aria-label="Diagnosis report">{report.report}</pre>
      <CopyButton text={report.report} what="the diagnosis report" label="Copy report" />
    </div>
  );
}

export default function HealthPage({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResponse | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await fetchHealth(token);
      if (alive.current) {
        setHealth(out);
        setError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not read the health checks.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [load]);

  async function diagnose() {
    setDiagBusy(true);
    setDiagError(null);
    try {
      setDiagnosis(await runDiagnosis(token));
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setDiagError(err instanceof Error ? err.message : "The diagnosis failed to run.");
    }
    setDiagBusy(false);
  }

  if (!isWorkerConfigured()) {
    return (
      <Panel title="Health Center" eyebrow="Status" tone="ion">
        <p className="e-dim">The Worker is not set for this build, so the dashboard cannot check the system. Set the repo variable <span className="e-num">TITAN_WORKER_URL</span> and rebuild the Pages site. See docs/RUNTIME.md.</p>
      </Panel>
    );
  }
  if (!health && !error) {
    return (
      <Panel title="Health Center" eyebrow="Status" tone="ion">
        <p className="e-dim" role="status">Running the checks. This takes up to 6 seconds.</p>
      </Panel>
    );
  }
  if (!health) {
    return (
      <Panel title="Health Center" eyebrow="Status" tone="ion" actions={<button className="btn" onClick={() => void load()}>Try again</button>}>
        <p className="field-error" role="alert">{error}</p>
        <p className="e-dim">The Worker did not answer. If the Worker is down, the dashboard cannot check anything else. Open the Worker address in a browser, and read docs/RUNBOOK.md.</p>
      </Panel>
    );
  }

  const line = overallLine(health.summary);
  const groups = groupRows(health.rows);

  return (
    <>
      <Panel
        title="Health Center"
        eyebrow="Status"
        tone="ion"
        actions={
          <>
            <Badge tone={line.tone}>{line.text}</Badge>
            <button className="btn" onClick={() => void load()}>Check again</button>
            <button className="btn btn-primary" onClick={() => void diagnose()} disabled={diagBusy}>{diagBusy ? "Running" : "Run full diagnosis"}</button>
          </>
        }
      >
        <p className="e-dim">
          Checked {relative(health.generatedAt)}{health.cached ? " (the Worker keeps an answer for 30 seconds)" : ""} · request <span className="e-num">{health.requestId}</span>
        </p>
        {error ? <p className="field-error" role="alert">The last refresh failed: {error}</p> : null}
        {diagError ? <p className="field-error" role="alert">{diagError}</p> : null}
        {diagnosis ? <DiagnosisBox report={diagnosis} /> : null}
      </Panel>

      {groups.map((g) => (
        <Panel key={g.group} title={g.label} eyebrow="Checks" tone="plasma">
          <ul className="e-list" aria-label={g.label}>
            {g.rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </ul>
        </Panel>
      ))}

      <Panel title="Runner callbacks" eyebrow="Repair" tone="ion">
        <RunnerCallbacks token={token} onUnauthorized={onUnauthorized} />
      </Panel>

      <Panel title="Health addresses" eyebrow="Settings" tone="corona">
        <HealthUrlsEditor token={token} onUnauthorized={onUnauthorized} onSaved={() => void load()} />
      </Panel>
    </>
  );
}
