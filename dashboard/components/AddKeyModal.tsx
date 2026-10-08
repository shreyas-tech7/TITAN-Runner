"use client";

/**
 * "Add or replace" a key (Wave 12, K7). The person picks a provider, pastes the key, and clicks "Save and verify".
 * The Worker checks the key with the provider, seals it, and writes the GitHub secret. A runner then tests it, and this
 * window polls every 5 seconds for up to 3 minutes to show the result.
 *
 * The key lives in the password field and in nothing else. It is cleared after every result. It is never put in the
 * URL, in localStorage, in sessionStorage, or in a log. The one exception is the short time between a "did not answer"
 * result and the "Save anyway" click: the value waits in a ref, not in the page, and goes away when that step ends.
 */
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/kit";
import { useModal } from "@/components/useModal";
import { POLL_INTERVAL_MS, POLL_LIMIT_MS, nextPollAction, phaseMessage, proofOutcome, stepsFor, type FlowPhase, type StepStatus } from "@/lib/addKeyFlow";
import { fetchKeys, saveKey, type KeyRow, type SaveKeyBody } from "@/lib/keysApi";
import { formatProblem, hintWarning } from "@/lib/keyState";
import { PROVIDER_CATALOG, catalogProvider } from "@/lib/providers";
import { WorkerApiError } from "@/lib/workerApi";

const STEP_WORD: Record<StepStatus, string> = { pending: "Waiting", active: "In progress", done: "Done", failed: "Failed", skipped: "Skipped" };

const INPUT_LABEL: Record<string, string> = {
  label: "Label",
  baseUrl: "Base URL",
  model: "Model",
  chatPath: "Chat path",
  specialization: "Specialization",
};

export default function AddKeyModal({
  token,
  rows,
  initialProvider,
  vaultReady,
  onClose,
  onChanged,
  onUnauthorized,
}: {
  token: string;
  rows: KeyRow[];
  initialProvider?: string;
  vaultReady: boolean;
  onClose: () => void;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const dialogRef = useModal(onClose);
  const [provider, setProvider] = useState(initialProvider && catalogProvider(initialProvider) ? initialProvider : PROVIDER_CATALOG[0].id);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [alsoForChat, setAlsoForChat] = useState(false);
  const [phase, setPhase] = useState<FlowPhase>({ name: "form" });
  const [formError, setFormError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  // The key waits here, and only here, between "did not answer" and "Save anyway". It is not in the page.
  const pending = useRef<{ body: SaveKeyBody } | null>(null);
  const startedAt = useRef(0);
  const entry = catalogProvider(provider);
  const row = rows.find((r) => r.id === provider);
  const busy = phase.name === "sending" || phase.name === "saved";
  const warning = hintWarning(provider, value);

  // Clear the extra fields when the provider changes.
  useEffect(() => {
    setExtras({});
    setAlsoForChat(false);
  }, [provider]);

  // Poll for the runner proof every 5 seconds, up to 3 minutes.
  useEffect(() => {
    if (phase.name !== "saved") return undefined;
    let stopped = false;
    const begin = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const keys = await fetchKeys(token);
        const result = proofOutcome(keys.providers.find((p) => p.id === provider), startedAt.current);
        if (stopped) return;
        if (result.outcome === "proven") {
          setPhase({ name: "proven" });
          onChanged();
          return;
        }
        if (result.outcome === "failed") {
          setPhase({ name: "proof_failed", reason: result.reason });
          onChanged();
          return;
        }
      } catch (err) {
        if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      }
      if (nextPollAction(Date.now() - begin) === "timeout") {
        if (!stopped) {
          setPhase({ name: "proof_timeout" });
          onChanged();
        }
      }
    };
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    const limit = window.setTimeout(() => void tick(), POLL_LIMIT_MS + 500);
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.clearTimeout(limit);
    };
  }, [phase.name, provider, token, onChanged, onUnauthorized]);

  function buildBody(extra: Partial<SaveKeyBody> = {}): SaveKeyBody {
    const body: SaveKeyBody = { provider, value: value.trim(), ...extra };
    for (const name of Object.keys(entry?.inputs ?? {})) {
      const text = (extras[name] ?? "").trim();
      if (text) (body as unknown as Record<string, string>)[name] = text;
    }
    if (alsoForChat) body.alsoForChat = true;
    return body;
  }

  async function submit(body: SaveKeyBody) {
    setPhase({ name: "sending" });
    startedAt.current = Date.now();
    let outcome;
    try {
      outcome = await saveKey(token, body);
    } catch (err) {
      setValue("");
      pending.current = null;
      if (err instanceof WorkerApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setPhase({ name: "failed", message: err instanceof WorkerApiError ? err.message : "Could not reach the Worker. Check your connection.", permission: null });
      return;
    }
    // Clear the input after every result.
    setValue("");
    switch (outcome.kind) {
      case "saved":
        pending.current = null;
        setRequestId(outcome.requestId);
        setPhase({ name: "saved", verified: outcome.verified });
        onChanged();
        break;
      case "rejected":
        pending.current = null;
        setPhase({ name: "rejected", reason: outcome.reason });
        break;
      case "needs_confirm":
        pending.current = { body };
        setPhase({ name: "confirm", reason: outcome.reason });
        break;
      default:
        pending.current = null;
        setPhase({ name: "failed", message: outcome.message, permission: outcome.permission });
    }
  }

  function handleSave() {
    const problem = formProblem();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    void submit(buildBody());
  }

  function formProblem(): string | null {
    const fmt = formatProblem(value);
    if (fmt) return fmt;
    for (const [name, spec] of Object.entries(entry?.inputs ?? {})) {
      if (spec.required && !(extras[name] ?? "").trim()) return `Fill in "${INPUT_LABEL[name] ?? name}".`;
    }
    return null;
  }

  function handleConfirm() {
    const held = pending.current;
    pending.current = null;
    if (held) void submit({ ...held.body, saveIfUnverified: true });
  }

  function handleCancelConfirm() {
    pending.current = null;
    setPhase({ name: "form" });
  }

  function handleClose() {
    pending.current = null;
    setValue("");
    onClose();
  }

  const showForm = phase.name === "form";
  const steps = stepsFor(phase);
  const message = phaseMessage(phase);

  return (
    <div className="overlay-scrim" onClick={handleClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-key-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-head">
            <h2 className="modal-title" id="add-key-title">{row?.secretPresent ? "Replace a key" : "Add a key"}</h2>
            <button className="btn btn-quiet" onClick={handleClose} aria-label="Close this window">Close</button>
          </div>

          {showForm ? (
            <>
              <div className="field">
                <label htmlFor="add-key-provider">Provider</label>
                <select id="add-key-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {PROVIDER_CATALOG.map((p) => {
                    const r = rows.find((x) => x.id === p.id);
                    return (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {r?.secretPresent ? " (replace)" : ""}
                      </option>
                    );
                  })}
                </select>
                {entry ? (
                  <div className="field-hint">
                    {entry.freeTierNote.text}{" "}
                    {entry.getKeyUrl ? (
                      <a href={entry.getKeyUrl} target="_blank" rel="noopener noreferrer">
                        Get a key
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {entry && !entry.verifiable ? <div className="field-hint">{entry.unverifiableReason}</div> : null}
                {entry?.note ? <div className="field-hint">{entry.note}</div> : null}
              </div>

              {Object.entries(entry?.inputs ?? {}).map(([name, spec]) => (
                <div className="field" key={`${provider}-${name}`}>
                  <label htmlFor={`add-key-${name}`}>
                    {INPUT_LABEL[name] ?? name}
                    {spec.required ? "" : " (optional)"}
                  </label>
                  <input
                    id={`add-key-${name}`}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={spec.default ?? ""}
                    value={extras[name] ?? ""}
                    onChange={(e) => setExtras((prev) => ({ ...prev, [name]: e.target.value }))}
                  />
                  {spec.help ? <div className="field-hint">{spec.help}</div> : null}
                </div>
              ))}

              <div className="field">
                <label htmlFor="add-key-value">Key</label>
                <div className="key-input-row">
                  <input
                    id="add-key-value"
                    type={reveal ? "text" : "password"}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder="Paste the key"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSave()}
                    aria-describedby="add-key-hint"
                  />
                  <button type="button" className="btn btn-quiet" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}>
                    {reveal ? "Hide" : "Show"}
                  </button>
                </div>
                <div id="add-key-hint" className="field-hint" aria-live="polite">
                  {warning ? `${warning} This is a hint. You can still save.` : "The key goes to the Worker over https. It is not kept in this browser."}
                </div>
                {formError ? <div className="field-error" role="alert">{formError}</div> : null}
              </div>

              {entry?.usedBy.includes("chat") ? (
                <label className="check-row" htmlFor="add-key-chat">
                  <input id="add-key-chat" type="checkbox" checked={alsoForChat} onChange={(e) => setAlsoForChat(e.target.checked)} disabled={!vaultReady} />
                  Also use this key for instant chat
                </label>
              ) : null}
              {entry?.usedBy.includes("chat") ? (
                <div className="field-hint">
                  {vaultReady ? "Chat needs an encrypted copy in the vault. It is off by default." : "The vault is not ready, so chat cannot use this key yet. See the setup card on the Keys page."}
                </div>
              ) : null}

              <div className="modal-actions">
                <button className="btn btn-primary" onClick={handleSave} disabled={!value.trim()}>
                  Save and verify
                </button>
                <button className="btn btn-quiet" onClick={handleClose}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <ol className="flow-steps" aria-label="Steps">
                {steps.map((s) => (
                  <li key={s.id} className={`flow-step flow-step-${s.status}`}>
                    <span className="flow-step-mark" aria-hidden="true">{s.status === "done" ? "✓" : s.status === "failed" ? "✕" : s.status === "active" ? "…" : s.status === "skipped" ? "–" : "○"}</span>
                    <span className="flow-step-label">{s.label}</span>
                    <Badge tone={s.status === "done" ? "ok" : s.status === "failed" ? "danger" : s.status === "active" ? "plasma" : "neutral"}>{STEP_WORD[s.status]}</Badge>
                  </li>
                ))}
              </ol>
              <p
                className={phase.name === "rejected" || phase.name === "failed" || phase.name === "proof_failed" ? "field-error" : "e-hint"}
                role={phase.name === "rejected" || phase.name === "failed" ? "alert" : "status"}
              >
                {phase.name === "rejected" ? <strong>The provider rejected this key. </strong> : null}
                {phase.name === "rejected" ? phase.reason + " Nothing was saved." : message}
                {phase.name === "failed" && phase.permission ? ` The GitHub token needs the permission "${phase.permission}".` : ""}
              </p>
              {requestId && (phase.name === "failed" || phase.name === "proof_failed") ? <p className="e-dim">Request id: <span className="e-num">{requestId}</span></p> : null}
              <div className="modal-actions">
                {phase.name === "confirm" ? (
                  <>
                    <button className="btn btn-primary" onClick={handleConfirm}>Save anyway</button>
                    <button className="btn btn-quiet" onClick={handleCancelConfirm}>Go back</button>
                  </>
                ) : (
                  <>
                    {phase.name === "rejected" || phase.name === "failed" ? (
                      <button className="btn" onClick={() => setPhase({ name: "form" })}>Try again</button>
                    ) : null}
                    <button className="btn btn-quiet" onClick={handleClose} disabled={phase.name === "sending"}>
                      {busy ? "Close, the test keeps going" : "Done"}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
