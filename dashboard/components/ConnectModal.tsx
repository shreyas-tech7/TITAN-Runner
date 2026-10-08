"use client";

/**
 * Connect a tool (Wave 12, C4). The form is made from the manifest of the connector, so a new connector needs no code here.
 * The Worker tests the connection, encrypts the secrets in the vault, and answers. The values live in the form fields and in
 * nothing else. They are cleared after every result. The one exception is the short wait between "the test failed" and
 * "Save anyway": the values wait in a ref, not in the page, and go away when that step ends.
 */
import { useRef, useState } from "react";
import CopyButton from "@/components/CopyButton";
import { Badge } from "@/components/kit";
import { useModal } from "@/components/useModal";
import { beginOAuth, connectTool, type ConnectOutcome, type ConnectorView, type TestResult } from "@/lib/connectorsApi";
import { connectFields, connectProblems, isGoogleOAuth, redirectUriFor, testSends } from "@/lib/connectorsView";
import { WorkerApiError, workerUrl } from "@/lib/workerApi";

type Connected = Extract<ConnectOutcome, { kind: "connected" }>;
type Phase =
  | { name: "form" }
  | { name: "sending" }
  | { name: "confirm"; message: string; test: TestResult }
  | { name: "done"; outcome: Connected }
  | { name: "failed"; message: string; fix: string | null };

export default function ConnectModal({
  token,
  connector,
  vaultReady,
  onClose,
  onChanged,
  onOpenDetails,
  onUnauthorized,
}: {
  token: string;
  connector: ConnectorView;
  vaultReady: boolean;
  onClose: () => void;
  onChanged: () => void;
  onOpenDetails: (connectionId: string) => void;
  onUnauthorized: () => void;
}) {
  const dialogRef = useModal(onClose);
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [oauthError, setOauthError] = useState<string | null>(null);
  // The values wait here, and only here, between "the test failed" and "Save anyway".
  const held = useRef<{ label: string; fields: Record<string, string> } | null>(null);
  const needsVault = connector.auth.kind !== "none";
  const redirectUri = redirectUriFor(connector.id, workerUrl());
  const learnUrl = connector.getKeyUrl || connector.docsUrl;

  async function submit(body: { label: string; fields: Record<string, string> }, saveIfUnverified = false) {
    setPhase({ name: "sending" });
    let outcome: ConnectOutcome;
    try {
      outcome = await connectTool(token, connector.id, { label: body.label || undefined, fields: body.fields, saveIfUnverified });
    } catch (err) {
      setValues({});
      held.current = null;
      if (err instanceof WorkerApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setPhase({ name: "failed", message: err instanceof WorkerApiError ? err.message : "Could not reach the Worker. Check your connection.", fix: null });
      return;
    }
    setValues({});
    switch (outcome.kind) {
      case "connected":
        held.current = null;
        setPhase({ name: "done", outcome });
        onChanged();
        break;
      case "test_failed":
        held.current = body;
        setPhase({ name: "confirm", message: outcome.message, test: outcome.test });
        break;
      default:
        held.current = null;
        setPhase({ name: "failed", message: outcome.errors[0] ?? outcome.message, fix: outcome.fix });
    }
  }

  function handleSave() {
    const found = connectProblems(connector, values);
    if (found.length > 0) {
      setProblems(Object.fromEntries(found.map((p) => [p.name, p.message])));
      return;
    }
    setProblems({});
    void submit({ label: label.trim(), fields: connectFields(connector, values) });
  }

  function handleSaveAnyway() {
    const body = held.current;
    held.current = null;
    if (body) void submit(body, true);
  }

  function handleClose() {
    held.current = null;
    setValues({});
    onClose();
  }

  async function handleApprove(connectionId: string) {
    setOauthError(null);
    try {
      const { authorizeUrl } = await beginOAuth(token, connector.id, connectionId);
      // Same tab, so the admin token in this tab is still here when the Worker sends the person back.
      window.location.assign(authorizeUrl);
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setOauthError(err instanceof Error ? err.message : "Could not start the sign in.");
    }
  }

  const titleId = "connect-title";
  return (
    <div className="overlay-scrim" onClick={handleClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-head">
            <h2 className="modal-title" id={titleId}>Connect {connector.name}</h2>
            <button className="btn btn-quiet" onClick={handleClose} aria-label="Close this window">Close</button>
          </div>

          {phase.name === "form" || phase.name === "sending" ? (
            <>
              <p className="e-dim">{connector.description}</p>
              {connector.auth.setupNote ? <p className="e-hint">{connector.auth.setupNote}</p> : null}
              {needsVault && !vaultReady ? (
                <p className="field-error" role="alert">The vault is not ready, so TITAN cannot store a secret yet. Close this window and follow the setup card.</p>
              ) : null}
              {learnUrl && connector.auth.fields.length > 0 ? (
                <p>
                  <a href={learnUrl} target="_blank" rel="noopener noreferrer">Where do I get this?</a>
                </p>
              ) : null}

              {connector.auth.kind === "oauth2_pkce" ? (
                <div className="guide" role="note">
                  <h3 className="guide-title">Register this redirect address</h3>
                  <p className="e-dim">Add this exact address to the OAuth client at the provider. Then paste the client ID and the client secret below.</p>
                  <p className="e-num" style={{ overflowWrap: "anywhere" }}>{redirectUri}</p>
                  <CopyButton text={redirectUri} what="the redirect address" />
                  {isGoogleOAuth(connector.id) ? (
                    <p className="e-hint">
                      While your Google app has the status Testing, Google ends a sign in after 7 days. TITAN then shows "Needs a new sign in". Choose Sign in again. To avoid this, move the app to In production at Google.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="field">
                <label htmlFor="connect-label">Name (optional)</label>
                <input id="connect-label" type="text" autoComplete="off" maxLength={60} placeholder={connector.name} value={label} onChange={(e) => setLabel(e.target.value)} />
                <div className="field-hint">A name tells two connections of the same tool apart.</div>
              </div>

              {connector.auth.fields.map((f) => {
                const id = `connect-${f.name}`;
                const shown = !f.secret || reveal[f.name];
                return (
                  <div className="field" key={f.name}>
                    <label htmlFor={id}>
                      {f.label}
                      {f.optional || f.default ? " (optional)" : ""}
                    </label>
                    <div className="key-input-row">
                      <input
                        id={id}
                        type={shown ? "text" : "password"}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder={f.placeholder || f.default}
                        value={values[f.name] ?? ""}
                        aria-describedby={`${id}-hint`}
                        onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && phase.name === "form" && handleSave()}
                      />
                      {f.secret ? (
                        <button type="button" className="btn btn-quiet" aria-pressed={Boolean(reveal[f.name])} onClick={() => setReveal((prev) => ({ ...prev, [f.name]: !prev[f.name] }))}>
                          {reveal[f.name] ? "Hide" : "Show"}
                        </button>
                      ) : null}
                    </div>
                    <div id={`${id}-hint`} className="field-hint">
                      {f.help}
                      {f.secret ? " TITAN encrypts it. It is never shown again." : ""}
                    </div>
                    {problems[f.name] ? <div className="field-error" role="alert">{problems[f.name]}</div> : null}
                  </div>
                );
              })}
              {connector.auth.fields.length === 0 ? <p className="e-dim">This tool needs no key. Choose Connect to add it.</p> : null}

              <div className="modal-actions">
                <button className="btn btn-primary" onClick={handleSave} disabled={phase.name === "sending" || (needsVault && !vaultReady)}>
                  {phase.name === "sending" ? "Connecting" : "Connect and test"}
                </button>
                <button className="btn btn-quiet" onClick={handleClose}>Cancel</button>
              </div>
            </>
          ) : null}

          {phase.name === "confirm" ? (
            <>
              <p className="field-error" role="alert"><strong>The test failed. </strong>{phase.message}</p>
              <p className="e-dim">Nothing is saved yet. You can fix the values and try again. You can also save the connection anyway and fix it later.</p>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={handleSaveAnyway}>Save anyway</button>
                <button className="btn btn-quiet" onClick={() => setPhase({ name: "form" })}>Go back</button>
              </div>
            </>
          ) : null}

          {phase.name === "failed" ? (
            <>
              <p className="field-error" role="alert"><strong>The tool was not connected. </strong>{phase.message}</p>
              {phase.fix ? <p className="e-hint">{phase.fix}</p> : null}
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={() => setPhase({ name: "form" })}>Go back</button>
                <button className="btn btn-quiet" onClick={handleClose}>Close</button>
              </div>
            </>
          ) : null}

          {phase.name === "done" ? <DonePanel outcome={phase.outcome} connector={connector} oauthError={oauthError} onApprove={() => void handleApprove(phase.outcome.connection.id)} onDetails={() => { onOpenDetails(phase.outcome.connection.id); onClose(); }} onClose={handleClose} /> : null}
        </div>
      </div>
    </div>
  );
}

function DonePanel({ outcome, connector, oauthError, onApprove, onDetails, onClose }: { outcome: Connected; connector: ConnectorView; oauthError: string | null; onApprove: () => void; onDetails: () => void; onClose: () => void }) {
  const { test, hook, bot, tools, needsAuthorization } = outcome;
  return (
    <>
      <div role="status" aria-live="polite">
        {needsAuthorization ? (
          <p className="e-hint"><strong>Saved. </strong>The last step is the sign in at the provider. Choose Approve access.</p>
        ) : test.ok === true ? (
          <p className="e-hint"><strong>Connected. </strong>The test passed in <span className="e-num">{test.ms} ms</span>.</p>
        ) : test.ok === null ? (
          <p className="e-hint"><strong>Saved. </strong>{test.message ?? "No test ran."}{testSends(connector) ? " Use Send test in the details to check it." : ""}</p>
        ) : (
          <p className="field-error"><strong>Saved, not verified. </strong>{test.error ?? "The test failed."}</p>
        )}
      </div>
      {hook ? (
        <div className="guide" role="note">
          <h3 className="guide-title">Your inbound address</h3>
          <p className="e-num" style={{ overflowWrap: "anywhere" }}>{hook.hookUrl}</p>
          <CopyButton text={hook.hookUrl} what="the address" />
          <h3 className="guide-title" style={{ marginTop: 12 }}>Your secret</h3>
          <p className="e-hint"><strong>Copy this secret now. </strong>TITAN shows it one time only. If you lose it, make a new one in the details.</p>
          <p className="e-num" style={{ overflowWrap: "anywhere" }}>{hook.hookSecret}</p>
          <CopyButton text={hook.hookSecret} what="the secret" />
          <p className="e-dim">Check mode: <Badge tone="neutral">{hook.mode}</Badge></p>
        </div>
      ) : null}
      {bot ? <p className="e-hint">{bot.username ? `The bot is @${bot.username}. ` : ""}{bot.webhookSet ? "TITAN set the webhook. " : ""}Open the details and choose Pair my chat.</p> : null}
      {tools ? <p className="e-hint">TITAN found {tools.length} tool{tools.length === 1 ? "" : "s"}. Each tool starts as a write action, so each call needs your approval. Change this in the details.</p> : null}
      {oauthError ? <p className="field-error" role="alert">{oauthError}</p> : null}
      <div className="modal-actions">
        {needsAuthorization ? <button className="btn btn-primary" onClick={onApprove}>Approve access</button> : null}
        <button className={needsAuthorization ? "btn" : "btn btn-primary"} onClick={onDetails}>Open details</button>
        <button className="btn btn-quiet" onClick={onClose}>Close</button>
      </div>
    </>
  );
}
