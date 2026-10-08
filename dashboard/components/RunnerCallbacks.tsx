"use client";

/**
 * The callback path between the GitHub runners and the Worker (Wave 12, K8). Runners call the Worker with the callback
 * token to report their results. "Repair runner callbacks" rotates that token and runs the round trip test. The round
 * trip is: the Worker fires a dispatch, the workflow `callback-ping` calls back, and this panel shows the seconds that
 * it took. The Settings window and the Health Center both show this panel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/kit";
import { fetchCallbackState, rotateCallbackToken, startCallbackPing, type CallbackState } from "@/lib/keysApi";
import { relative } from "@/lib/time";
import { WorkerApiError } from "@/lib/workerApi";

type Run = { phase: "idle" } | { phase: "working"; text: string } | { phase: "ok"; seconds: number | null; authKind: string | null } | { phase: "failed"; text: string };

export default function RunnerCallbacks({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [state, setState] = useState<CallbackState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await fetchCallbackState(token);
      if (alive.current) {
        setState(next);
        setLoadError(null);
      }
      return next;
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      if (alive.current) setLoadError(err instanceof Error ? err.message : "Could not read the callback state.");
      return null;
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function waitForPing(id: string): Promise<void> {
    const until = Date.now() + 90_000;
    while (alive.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3_000));
      const next = await load();
      if (next?.lastPing?.id === id && next.lastPing.receivedAt) {
        setRun({ phase: "ok", seconds: next.lastPing.seconds, authKind: next.lastPing.authKind });
        return;
      }
    }
    if (alive.current) setRun({ phase: "failed", text: "No answer in 90 seconds. Check the callback-ping runs on the Actions tab. The callback token may not be in the repo secrets yet." });
  }

  async function repair(rotate: boolean) {
    try {
      if (rotate) {
        setRun({ phase: "working", text: "Making a new callback token and writing it to the repo secrets." });
        await rotateCallbackToken(token);
      }
      setRun({ phase: "working", text: "Starting the round trip test. A runner will call the Worker." });
      const ping = await startCallbackPing(token);
      setRun({ phase: "working", text: "Waiting for the runner to call back." });
      await waitForPing(ping.id);
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setRun({ phase: "failed", text: err instanceof Error ? err.message : "The test could not start." });
    }
  }

  const working = run.phase === "working";
  return (
    <div className="callbacks" aria-live="polite">
      {loadError ? <p className="field-error" role="alert">{loadError} Check that the Worker runs and that the dashboard knows its address.</p> : null}
      {state ? (
        <dl className="e-facts">
          <div className="e-fact"><dt>Callback token</dt><dd>{state.hasToken ? `active since ${relative(state.activeSince)}` : "not made yet"}</dd></div>
          <div className="e-fact"><dt>Admin token on /internal</dt><dd>{state.legacyMode ? <Badge tone="warn">Still allowed (legacy mode)</Badge> : <Badge tone="ok">Refused</Badge>}</dd></div>
          <div className="e-fact"><dt>Last round trip</dt><dd>{state.lastPing ? (state.lastPing.receivedAt ? `${state.lastPing.seconds ?? "?"} s, with the ${state.lastPing.authKind} token, ${relative(state.lastPing.receivedAt)}` : `sent ${relative(state.lastPing.requestedAt)}, no answer`) : "never run"}</dd></div>
          {state.lastError ? <div className="e-fact"><dt>Last error</dt><dd>{state.lastError}</dd></div> : null}
        </dl>
      ) : (
        <p className="e-dim">Loading the callback state</p>
      )}
      {state?.legacyMode ? <p className="e-hint">Legacy mode ends 30 minutes after the first callback token is active. Until then, workflows that still hold the old secret keep working.</p> : null}
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={() => void repair(true)} disabled={working}>Repair runner callbacks</button>
        <button className="btn" onClick={() => void repair(false)} disabled={working}>Run the round trip test</button>
      </div>
      {run.phase === "working" ? <p className="e-hint" role="status">{run.text}</p> : null}
      {run.phase === "ok" ? <p className="e-hint" role="status">The callback path works. The round trip took {run.seconds ?? "?"} seconds with the {run.authKind} token.</p> : null}
      {run.phase === "failed" ? <p className="field-error" role="alert">{run.text}</p> : null}
    </div>
  );
}
