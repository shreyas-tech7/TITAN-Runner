"use client";

/** Remove a key. The person types the provider id to confirm, because the secret in GitHub cannot be undone. */
import { useState } from "react";
import { useModal } from "@/components/useModal";
import { removeKey, type KeyRow } from "@/lib/keysApi";
import { WorkerApiError } from "@/lib/workerApi";

export default function RemoveKeyModal({
  token,
  row,
  onClose,
  onRemoved,
  onUnauthorized,
}: {
  token: string;
  row: KeyRow;
  onClose: () => void;
  onRemoved: () => void;
  onUnauthorized: () => void;
}) {
  const dialogRef = useModal(onClose);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      await removeKey(token, row.id);
      onRemoved();
      onClose();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
      setBusy(false);
    }
  }

  return (
    <div className="overlay-scrim" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="remove-key-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-head">
            <h2 className="modal-title" id="remove-key-title">Remove the {row.label} key</h2>
            <button className="btn btn-quiet" onClick={onClose} aria-label="Close this window">Close</button>
          </div>
          <p className="e-dim">
            This deletes the secret <span className="e-num">{row.secretName}</span> and the other secrets of this provider from the repo. The pulse and the sub-agents lose this provider at once. The key stays valid at the provider. Revoke it there if it leaked.
          </p>
          <div className="field">
            <label htmlFor="remove-key-confirm">Type <span className="e-num">{row.id}</span> to confirm</label>
            <input id="remove-key-confirm" type="text" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          {error ? <div className="field-error" role="alert">{error}</div> : null}
          <div className="modal-actions">
            <button className="btn btn-danger" onClick={handleRemove} disabled={typed !== row.id || busy}>
              {busy ? "Removing" : "Remove key"}
            </button>
            <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
