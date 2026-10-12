"use client";

/**
 * The Security panel. It shows after the sign-in only, because the sign-in log holds IP addresses. The log comes from
 * the Worker (`GET /admin/security/signins`) and never from the public repository. The panel also shows the last
 * gitleaks scan of the full history, from the public GitHub API.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Panel } from "@/components/kit";
import { SIGNIN_META, gitleaksStatus, reasonWords, signinHeadline, type GitleaksRun, type SigninLog } from "@/lib/opsView";
import { fetchGitleaksRun, fetchSigninLog } from "@/lib/securityApi";
import { relative } from "@/lib/time";
import { WorkerApiError, isWorkerConfigured } from "@/lib/workerApi";

export function SecurityView({ log, run, error, loading, now }: { log: SigninLog | null; run: GitleaksRun | null; error: string | null; loading: boolean; now?: number }) {
  const scan = gitleaksStatus(run);
  const headline = log ? signinHeadline(log.summary) : null;
  return (
    <>
      <div className="ops-security-scan" data-testid="gitleaks-status">
        <Badge tone={scan.tone}>Secret scan: {scan.label}</Badge>
        <span className="e-dim">{scan.detail}</span>
        {run?.updatedAt ? <span className="e-dim e-num">{relative(run.updatedAt, now)}</span> : null}
        {run?.url ? (
          <a href={run.url} target="_blank" rel="noopener noreferrer">
            Open the run
          </a>
        ) : null}
      </div>
      {loading && !log ? <p className="e-dim">Loading the sign-in log…</p> : null}
      {error ? (
        <p className="e-dim" role="alert">
          Could not load the sign-in log ({error}).
        </p>
      ) : null}
      {headline ? (
        <p data-testid="signin-headline">
          <Badge tone={headline.tone}>Last 24 hours</Badge> {headline.text}
        </p>
      ) : null}
      {log && log.entries.length === 0 ? <p className="e-dim">No sign-in is logged yet.</p> : null}
      {log && log.entries.length > 0 ? (
        <div className="ops-table-wrap" role="region" aria-label="The sign-in log, scrolls sideways on a narrow screen" tabIndex={0}>
          <table className="ops-table">
            <caption className="sr-only">The latest sign-in attempts</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Result</th>
                <th scope="col">Why</th>
                <th scope="col">Address</th>
              </tr>
            </thead>
            <tbody>
              {log.entries.map((e) => {
                const meta = SIGNIN_META[e.result] ?? { label: e.result, tone: "neutral" as const };
                return (
                  <tr key={e.id} data-result={e.result}>
                    <td title={e.at}>{relative(e.at, now)}</td>
                    <td>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                    <td title={e.userAgent ?? undefined}>{reasonWords(e.reason)}</td>
                    <td className="e-num">{e.ip}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="e-note">The log stays in the Worker database for 90 days. It is never written to the repository. A client that is locked out is logged once each 5 minutes.</p>
    </>
  );
}

export default function SecurityPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [log, setLog] = useState<SigninLog | null>(null);
  const [run, setRun] = useState<GitleaksRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const scan = fetchGitleaksRun().then(setRun);
    if (isWorkerConfigured()) {
      try {
        setLog(await fetchSigninLog(token));
        setError(null);
      } catch (err) {
        if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
        else setError(err instanceof Error ? err.message : "unknown error");
      }
    } else {
      setError("the Worker is not set up yet");
    }
    await scan;
    setLoading(false);
  }, [token, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel
      title="Security"
      eyebrow="After sign-in only"
      tone="corona"
      actions={
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      }
    >
      <SecurityView log={log} run={run} error={error} loading={loading} />
    </Panel>
  );
}
