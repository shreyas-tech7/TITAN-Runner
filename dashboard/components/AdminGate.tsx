"use client";

/**
 * Gates the entire dashboard, not just the new panels (build brief,
 * section 5: "This is a public URL and status briefs may reference things
 * the operator does not want publicly readable, so private-by-default is the
 * right call here"). Purely a client-side check against a token in
 * this tab's session storage (or local storage when asked to remember). This is still a static export with no backend of its own,
 * so this cannot stop someone from reading the page's own HTML/JS source;
 * what it protects is the *data* (state/*.json content already renders
 * inside these components), which only ever loads once a token is entered.
 *
 * If the Worker isn't deployed yet (`isWorkerConfigured()` false), there is
 * nothing to validate the token against — any non-empty entry unlocks the
 * page, same "never a silent redirect, always honest about what it could
 * and couldn't check" spirit as `NewTaskModal`'s no-token fallback.
 */
import { useEffect, useState } from "react";
import { getAdminToken, setAdminToken, clearAdminToken, clearLegacyAdminToken } from "@/lib/adminAuth";
import { exitDemoMode, isDemoMode } from "@/lib/demoFixtures";
import { logout, unlock } from "@/lib/sessionApi";

export default function AdminGate({
  children,
}: {
  /** Render-prop, not plain children — everything behind the gate needs the
   * live token (to call the Worker) and a way to force re-lock (a 401 from
   * a revoked/rotated token, not just the explicit "Lock dashboard" button
   * below), and this is the one place both are known. */
  children: (token: string, lock: () => void) => React.ReactNode;
}) {
  const [token, setTokenState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [remember, setRemember] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why the page locked itself: the session ended. It shows on the sign-in screen, once. */
  const [notice, setNotice] = useState<string | null>(null);

  const [demo, setDemo] = useState(false);

  useEffect(() => {
    if (isDemoMode()) {
      setDemo(true);
      setTokenState("demo-token");
      setReady(true);
      return;
    }
    // An older version of this page kept the admin token itself. A session replaces it, so the old copy goes.
    clearLegacyAdminToken();
    setTokenState(getAdminToken());
    setReady(true);
  }, []);

  async function handleUnlock() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setError(null);
    setNotice(null);
    setChecking(true);
    const result = await unlock(trimmed);
    setChecking(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The page keeps the session token. The admin token that was typed is not kept.
    setAdminToken(result.token, remember);
    setTokenState(result.token);
    setDraft("");
  }

  /** The "Lock dashboard" button. It ends the session on the Worker too. */
  function handleLock() {
    if (token) void logout(token);
    clearAdminToken();
    setTokenState(null);
  }

  /** A panel got a 401: the session ended (idle or absolute limit), or the token was rotated. */
  function handleExpired() {
    clearAdminToken();
    setTokenState(null);
    setNotice("Your session ended. Sign in again.");
  }

  if (!ready) return null;

  if (!token) {
    return (
      <main className="admin-gate">
        <div className="admin-gate-box">
          <h1 className="brand">TITAN-Runner</h1>
          <div className="brand-sub" style={{ marginBottom: 20 }}>
            Private by default — paste the admin token to unlock this dashboard.
          </div>
          {notice ? (
            <div className="banner" role="status" data-testid="session-ended" style={{ marginBottom: 12 }}>
              <span>{notice}</span>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="admin-token-input">Admin token</label>
            <input
              id="admin-token-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the TITAN_ADMIN_TOKEN…"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
            />
          </div>
          <label className="check-row" htmlFor="admin-remember">
            <input id="admin-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember on this device
          </label>
          {error && <div className="field-error">{error}</div>}
          <button className="btn btn-primary" onClick={handleUnlock} disabled={!draft.trim() || checking}>
            {checking ? "Checking…" : "Unlock"}
          </button>
          <p className="field-hint" style={{ marginTop: 16 }}>
            The token you type starts a session on the titan-runner-brain Worker. The page keeps the session, not the
            token. The session ends after a time with no use and after a fixed time in all, and then you sign in again.
            It stays for this tab only, unless you tick Remember. Remembering keeps the session on this device, where
            any page on this site can read it. It goes only to the Worker, never to a log, never to a commit. This lock
            hides the dashboard in your browser. The data it shows is also public in the repository, so do not treat it
            as privacy for what you file.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="admin-unlocked">
      {demo ? (
        <div className="banner" role="status" data-testid="demo-banner" style={{ marginBottom: 12 }}>
          <span>
            <strong>Demo mode (read-only). </strong>Sample data is loaded in your browser so you can explore every page
            without an admin token or a live Worker.
          </span>
          <button className="btn btn-quiet" onClick={() => exitDemoMode()}>
            Exit demo
          </button>
        </div>
      ) : null}
      {children(token, handleExpired)}
      <aside className="admin-lock-row" aria-label="Dashboard lock">
        <button className="btn btn-quiet admin-lock-btn" onClick={demo ? exitDemoMode : handleLock} title="End the session and lock this dashboard again">
          {demo ? "Exit demo" : "Lock dashboard"}
        </button>
      </aside>
    </div>
  );
}
