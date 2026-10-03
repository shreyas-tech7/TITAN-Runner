"use client";

import { useState } from "react";
import { getToken, setToken, clearToken, maskToken, tokenLocation } from "@/lib/token";
import { newTokenSettingsUrl, OWNER, REPO } from "@/lib/githubApi";
import { useModal } from "@/components/useModal";

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [stored, setStored] = useState<string | null>(() => getToken());
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(false);
  const [where, setWhere] = useState(() => tokenLocation());
  const dialogRef = useModal(onClose);

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setToken(trimmed, remember);
    setWhere(tokenLocation());
    setStored(trimmed);
    setDraft("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  function handleForget() {
    clearToken();
    setStored(null);
  }

  return (
    <div className="overlay-scrim" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-head">
            <h2 className="modal-title" id="settings-title">Settings</h2>
            <button className="btn btn-quiet" onClick={onClose} aria-label="Close settings">
              Close
            </button>
          </div>

          <div className="label" style={{ marginBottom: 8 }}>
            GitHub token
          </div>

          {stored ? (
            <div className="field">
              <div className="row" style={{ padding: "10px 0" }}>
                <span className="mono row-title">{maskToken(stored)}</span>
                <button className="btn btn-danger" onClick={handleForget}>
                  Forget token
                </button>
              </div>
              <div className="field-hint">
                {where === "local" ? "Remembered on this device (local storage), where any page on this site can read it." : "Kept for this tab only, and forgotten when you close it."} Forgetting it removes it immediately, with nothing to undo.
              </div>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="pat-input">Fine-grained personal access token</label>
              <input
                id="pat-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="github_pat_…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <label className="check-row" htmlFor="pat-remember">
                <input id="pat-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Remember on this device
              </label>
              <div className="field-hint">
                Kept for this tab only unless you tick Remember. Never sent anywhere but api.github.com, never logged, never written into state/, never committed.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button className="btn btn-primary" onClick={handleSave} disabled={draft.trim().length === 0}>
                  {saved ? "Saved" : "Save token"}
                </button>
                <a className="btn btn-quiet" href={newTokenSettingsUrl()} target="_blank" rel="noreferrer">
                  Create one on GitHub →
                </a>
              </div>
            </div>
          )}

          <div style={{ marginTop: 20, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
            <div className="label" style={{ marginBottom: 8 }}>
              Why this is safe to paste here
            </div>
            <p className="text-muted" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
              This dashboard is a static page with no backend — your token never leaves your browser except in
              direct calls to <code>api.github.com</code>. Create a <strong>fine-grained</strong> token (not a
              classic one) scoped to exactly one repository, <code className="mono">{OWNER}/{REPO}</code>, with{" "}
              <strong>Issues: Read and write</strong> and nothing else. That token cannot read your other repos,
              cannot touch billing or account settings, and cannot do anything to this repo beyond file, close,
              reopen, and comment on issues — which is exactly what filing, cancelling, and retrying a task needs.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
