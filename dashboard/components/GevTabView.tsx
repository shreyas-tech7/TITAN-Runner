/**
 * The God's Eye View tab, as a pure view. It takes the controller state and
 * renders the status bar, the body for the current phase, and the attribution
 * footer. No hooks and no router, so it renders on its own in the tests.
 * `GodsEyeTab` connects it to the Worker and the host.
 */
import type { RefObject } from "react";
import type { GevState } from "@/lib/gev";

export const GEV_REPO_URL = "https://github.com/bilawalsidhu/gods-eye-view";

function statusOf(state: GevState): { label: string; dot: string } {
  switch (state.phase) {
    case "ready":
      return state.reachable === false
        ? { label: "Unreachable, retrying", dot: "dot-warn" }
        : { label: "Reachable", dot: "dot-live" };
    case "waking":
      return { label: "Waking up", dot: "dot-warn dot-pulsing" };
    case "checking":
    case "minting":
      return { label: state.phase === "checking" ? "Checking" : "Signing in", dot: "dot-accent dot-pulsing" };
    case "unconfigured":
      return { label: "Gate not configured", dot: "dot-warn" };
    case "error":
      return { label: "Error", dot: "dot-fail" };
    default:
      return { label: "Not configured", dot: "dot-idle" };
  }
}

function Body({
  state,
  frameRef,
  onReload,
}: {
  state: GevState;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onReload: () => void;
}) {
  switch (state.phase) {
    case "empty":
      return (
        <div className="gev-state" data-gev-state="empty">
          <h2>God&apos;s Eye View is not connected</h2>
          <p className="text-muted">
            {state.emptyReason === "invalid" ? (
              <>
                <span className="mono">NEXT_PUBLIC_GEV_URL</span> is not a valid https URL.
              </>
            ) : (
              <>
                Set <span className="mono">NEXT_PUBLIC_GEV_URL</span> to the TITAN-GEV host URL.
              </>
            )}{" "}
            Add it as the repository variable <span className="mono">GEV_URL</span> and redeploy the dashboard.
            See <span className="mono">docs/GODS-EYE-VIEW.md</span>.
          </p>
        </div>
      );
    case "checking":
    case "minting":
      return (
        <div className="gev-state" data-gev-state={state.phase}>
          <h2>{state.phase === "checking" ? "Checking the host" : "Signing in"}</h2>
        </div>
      );
    case "waking":
      return (
        <div className="gev-state" data-gev-state="waking">
          <h2>Waking up, this can take a minute</h2>
          <p className="text-muted">
            Free hosts sleep when idle. Retrying automatically
            {state.attempts > 1 ? ` (check ${state.attempts})` : ""}.
          </p>
        </div>
      );
    case "unconfigured":
      return (
        <div className="gev-state" data-gev-state="unconfigured">
          <h2>The access gate is not set up</h2>
          <p className="text-muted">
            {state.missing === "worker" ? (
              <>
                The titan-runner-brain Worker is not configured, so the dashboard cannot mint an access link. Set{" "}
                <span className="mono">NEXT_PUBLIC_TITAN_WORKER_URL</span>.
              </>
            ) : (
              <>
                The Worker has no <span className="mono">GEV_SHARED_SECRET</span>. Set the same secret on the Worker and
                on the host, then reload.
              </>
            )}
          </p>
        </div>
      );
    case "error":
      return (
        <div className="gev-state" data-gev-state="error">
          <h2>Could not open God&apos;s Eye View</h2>
          <p className="text-failure">{state.message}</p>
          <p className="text-muted">Retrying automatically.</p>
          <div>
            <button className="btn" onClick={onReload}>
              Try again now
            </button>
          </div>
        </div>
      );
    case "ready":
      return (
        <>
          <iframe
            key={state.frameKey}
            ref={frameRef}
            className="gev-frame"
            src={state.src ?? undefined}
            title="God's Eye View"
            allow="fullscreen; clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads allow-modals"
            data-gev-state="ready"
          />
          {state.sessionBlocked && (
            <div className="gev-banner" role="alert">
              Your browser blocked the session cookie for this embedded view. Use Open full screen to load the globe as
              its own page.
            </div>
          )}
        </>
      );
  }
}

export default function GevTabView({
  state,
  origin,
  frameRef,
  onReload,
  onOpenFullScreen,
}: {
  state: GevState;
  origin: string | null;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onReload: () => void;
  onOpenFullScreen: () => void;
}) {
  const status = statusOf(state);
  const connected = origin !== null;
  return (
    <>
      <div className="gev-bar" role="status" aria-live="polite">
        <span className="gev-bar-status">
          <span className={`dot ${status.dot}`} aria-hidden />
          {status.label}
        </span>
        <span className="gev-bar-host" title={origin ?? undefined}>
          {origin ? origin.replace(/^https?:\/\//, "") : "no host URL set"}
        </span>
        <span className="gev-bar-actions">
          <button className="btn btn-quiet" onClick={onReload} disabled={!connected}>
            Reload session
          </button>
          <button className="btn btn-quiet" onClick={onOpenFullScreen} disabled={!connected}>
            Open full screen
          </button>
        </span>
      </div>
      <div className="gev-stage">
        <Body state={state} frameRef={frameRef} onReload={onReload} />
      </div>
      <p className="footer-note" data-gev-attribution>
        God&apos;s Eye View is open source software by{" "}
        <a href="https://github.com/bilawalsidhu" target="_blank" rel="noreferrer">
          Bilawal Sidhu
        </a>{" "}
        under the MIT license. Source:{" "}
        <a href={GEV_REPO_URL} target="_blank" rel="noreferrer">
          bilawalsidhu/gods-eye-view
        </a>
        . Hosted through{" "}
        <a href="https://github.com/shreyas-tech7/TITAN-GEV" target="_blank" rel="noreferrer">
          TITAN-GEV
        </a>
        . Live data and map imagery belong to their providers and keep their own terms.
      </p>
    </>
  );
}
