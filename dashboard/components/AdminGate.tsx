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
import { getAdminToken, setAdminToken, clearAdminToken } from "@/lib/adminAuth";
import { fetchStatus, isWorkerConfigured, WorkerApiError } from "@/lib/workerApi";

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

  useEffect(() => {
    setTokenState(getAdminToken());
    setReady(true);
  }, []);

  async function handleUnlock() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setError(null);

    if (isWorkerConfigured()) {
      setChecking(true);
      try {
        await fetchStatus(trimmed);
      } catch (err) {
        setChecking(false);
        if (err instanceof WorkerApiError && err.status === 401) {
          setError("That token was rejected by the Worker.");
          return;
        }
        // Worker unreachable for some other reason (network, cold start) —
        // don't lock someone out of their own dashboard over a transient
        // fetch failure; accept the token and let the panels themselves
        // show the connection error.
      }
      setChecking(false);
    }

    setAdminToken(trimmed, remember);
    setTokenState(trimmed);
    setDraft("");
  }

  function handleLock() {
    clearAdminToken();
    setTokenState(null);
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
            The token is kept for this tab only and forgotten when you close it, unless you tick Remember. Remembering
            keeps it on this device, where any page on this site can read it. It is sent only as a header to the
            titan-runner-brain Worker, never logged, never committed. This lock hides the dashboard in your browser. The
            data it shows is also public in the repository, so do not treat it as privacy for what you file.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="admin-unlocked">
      {children(token, handleLock)}
      <aside className="admin-lock-row" aria-label="Dashboard lock">
        <button className="btn btn-quiet admin-lock-btn" onClick={handleLock} title="Forget the admin token and lock this dashboard again">
          Lock dashboard
        </button>
      </aside>
    </div>
  );
}
