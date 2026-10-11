"use client";

/**
 * The details of one connection (Wave 12, C4): its state, its test, its actions with the risk and the data class, a "Try it"
 * form for read actions, the Telegram pairing, the inbound hook, the remote MCP tools, and the call log. A call log row holds
 * metadata only. The Worker never logs a payload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import CopyButton from "@/components/CopyButton";
import { Badge } from "@/components/kit";
import SchemaForm from "@/components/SchemaForm";
import { useModal } from "@/components/useModal";
import {
  beginOAuth, disconnectConnection, fetchConnection, renameConnection, rotateHook, runAction, setActionPolicy, setToolRisk, telegramPair, telegramUnpair, testConnectionNow,
  type ActionOutcome, type CallRow, type ConnectionDetail, type ConnectorAction, type ConnectorView, type PolicyMode, type Risk, type TestResult,
} from "@/lib/connectorsApi";
import { CATEGORY_LABEL, CONNECTION_STATUS_META, DATA_CLASS_META, POLICY_LABEL, RISK_META, testSends } from "@/lib/connectorsView";
import { relative } from "@/lib/time";
import { WorkerApiError } from "@/lib/workerApi";

const RESULT_LIMIT = 6000;

function ActionBadges({ action, risk }: { action: ConnectorAction; risk: Risk }) {
  return (
    <>
      <Badge tone={RISK_META[risk].tone} title={RISK_META[risk].help}>{RISK_META[risk].label}</Badge>
      <Badge tone={DATA_CLASS_META[action.dataClass].tone} title={DATA_CLASS_META[action.dataClass].help}>{DATA_CLASS_META[action.dataClass].label}</Badge>
    </>
  );
}

function ResultBox({ outcome, personal }: { outcome: ActionOutcome; personal: boolean }) {
  if (outcome.kind === "pending") return <p className="e-hint" role="status">The call waits for your approval. Open the Approvals tab.</p>;
  if (outcome.kind === "error") return <p className="field-error" role="alert">{outcome.message}{outcome.status ? ` (HTTP ${outcome.status})` : ""}</p>;
  const text = JSON.stringify(outcome.data, null, 2) ?? "";
  return (
    <div role="status">
      <p className="e-dim">
        Done{outcome.ms !== undefined ? ` in ${outcome.ms} ms` : ""}.{outcome.truncated ? " The Worker cut the answer." : ""}
        {personal ? " This is personal data. TITAN does not keep it." : ""}
      </p>
      <pre className="result-box" tabIndex={0} aria-label="Result of the action">{text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n…` : text}</pre>
    </div>
  );
}

function ActionRow({
  token, connectionId, action, risk, mode, onMode, onUnauthorized,
}: {
  token: string; connectionId: string; action: ConnectorAction; risk: Risk; mode: PolicyMode; onMode: (mode: PolicyMode) => void; onUnauthorized: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const modes: PolicyMode[] = risk === "destructive" ? ["ask", "deny"] : ["auto", "ask", "deny"];
  const tryable = risk === "read";

  async function run(input: Record<string, unknown>) {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await runAction(token, connectionId, action.id, input));
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setOutcome({ kind: "error", message: err instanceof Error ? err.message : "The call failed." });
    }
    setBusy(false);
  }

  return (
    <li className="e-item" data-action={action.id}>
      <div className="e-item-head">
        <span className="e-item-title">{action.title}</span>
        <ActionBadges action={action} risk={risk} />
      </div>
      {action.description ? <div className="e-dim">{action.description}</div> : null}
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`mode-${connectionId}-${action.id}`}>When a sub-agent or a tool asks</label>
        <select id={`mode-${connectionId}-${action.id}`} value={mode} onChange={(e) => onMode(e.target.value as PolicyMode)}>
          {modes.map((m) => (
            <option key={m} value={m}>{POLICY_LABEL[m]}</option>
          ))}
        </select>
      </div>
      {tryable ? (
        <details className="try-it">
          <summary>Try it</summary>
          <SchemaForm schema={action.input} submitLabel="Run" busy={busy} onSubmit={(input) => void run(input)} />
          {outcome ? <ResultBox outcome={outcome} personal={action.dataClass === "personal"} /> : null}
        </details>
      ) : (
        <div className="e-dim">{risk === "destructive" ? "Only you can run this action, from a tool that asks for a typed confirm." : "A write action runs from a sub-agent, a tool, or the notification router. It may wait for your approval."}</div>
      )}
    </li>
  );
}

function TelegramSection({ token, detail, onChanged, onUnauthorized }: { token: string; detail: ConnectionDetail; onChanged: () => void; onUnauthorized: () => void }) {
  const [pair, setPair] = useState<{ code: string; instruction: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paired = detail.connection.ownerPaired;

  // While a code is open, look for the pairing every 3 seconds.
  useEffect(() => {
    if (!pair || paired) return undefined;
    const id = window.setInterval(onChanged, 3000);
    return () => window.clearInterval(id);
  }, [pair, paired, onChanged]);

  useEffect(() => {
    if (paired) setPair(null);
  }, [paired]);

  async function start() {
    setError(null);
    try {
      setPair(await telegramPair(token, detail.connection.id));
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Could not make a code.");
    }
  }

  async function stop() {
    setError(null);
    try {
      await telegramUnpair(token, detail.connection.id);
      onChanged();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Could not unpair.");
    }
  }

  return (
    <section className="drawer-section" aria-label="Telegram pairing">
      <h3 className="guide-title">Telegram chat</h3>
      <p>
        {paired ? <Badge tone="ok">Paired with your chat</Badge> : <Badge tone="warn">Not paired</Badge>}{" "}
        <span className="e-dim">The bot answers your chat only. It stays silent in every other chat.</span>
      </p>
      {!paired && !pair ? <button className="btn btn-primary" onClick={() => void start()}>Pair my chat</button> : null}
      {pair && !paired ? (
        <div className="guide" role="status">
          <p className="e-hint">{pair.instruction}</p>
          <p className="e-num">Code: <strong>{pair.code}</strong> <CopyButton text={`/pair ${pair.code}`} what="the pair command" label="Copy command" /></p>
          <p className="e-dim">The code works one time and ends in 10 minutes. This box updates when the pairing is done.</p>
        </div>
      ) : null}
      {paired ? <button className="btn" onClick={() => void stop()}>Unpair</button> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </section>
  );
}

function HookSection({ token, detail, onChanged, onUnauthorized }: { token: string; detail: ConnectionDetail; onChanged: () => void; onUnauthorized: () => void }) {
  const hook = detail.hook;
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!hook) return null;

  async function renew() {
    setError(null);
    try {
      const out = await rotateHook(token, detail.connection.id);
      setFresh(out.hookSecret);
      onChanged();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Could not make a new secret.");
    }
  }

  return (
    <section className="drawer-section" aria-label="Inbound webhook">
      <h3 className="guide-title">Inbound webhook</h3>
      <p className="e-num" style={{ overflowWrap: "anywhere" }}>{hook.hookUrl}</p>
      <CopyButton text={hook.hookUrl} what="the address" />
      <p className="e-dim">
        Check mode <Badge tone={hook.mode === "static" ? "warn" : "neutral"}>{hook.mode}</Badge>
        {hook.mode === "static" ? " This mode is weaker. Anyone who holds the secret can send a call." : ""} · {hook.calls} call{hook.calls === 1 ? "" : "s"} · last {relative(hook.lastEventAt)}
      </p>
      <p className="e-dim">Target: {hook.target === "task" ? "Each call queues a task." : "Each call becomes an event for the notification router."}</p>
      {fresh ? (
        <div className="guide" role="status">
          <p className="e-hint"><strong>Copy the new secret now. </strong>TITAN shows it one time only. The old secret stopped working.</p>
          <p className="e-num" style={{ overflowWrap: "anywhere" }}>{fresh}</p>
          <CopyButton text={fresh} what="the secret" />
        </div>
      ) : (
        <button className="btn" onClick={() => void renew()}>Make a new secret</button>
      )}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {hook.events.length > 0 ? (
        <ul className="e-list" aria-label="Recent hook calls">
          {hook.events.slice(0, 8).map((e, i) => (
            <li className="e-item" key={`${e.at}-${i}`}>
              <div className="e-item-head">
                <Badge tone={e.outcome === "ok" || e.outcome === "queued" || e.outcome === "event" ? "ok" : "warn"}>{e.outcome}</Badge>
                <span className="e-item-title">{e.title ?? "No title"}</span>
                <span className="e-dim e-num">{relative(e.at)} · {e.bytes} bytes</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="e-dim">No call yet.</p>
      )}
    </section>
  );
}

function McpToolsSection({ token, detail, onChanged, onUnauthorized }: { token: string; detail: ConnectionDetail; onChanged: () => void; onUnauthorized: () => void }) {
  const tools = detail.tools ?? [];
  const [error, setError] = useState<string | null>(null);
  async function change(name: string, risk: Risk) {
    setError(null);
    try {
      await setToolRisk(token, detail.connection.id, name, risk);
      onChanged();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Could not change the risk.");
    }
  }
  return (
    <section className="drawer-section" aria-label="Remote tools">
      <h3 className="guide-title">Remote tools</h3>
      <p className="e-dim">Each tool starts as a write action, so each call needs your approval. Set a tool to Read only if it changes nothing.</p>
      {tools.length === 0 ? <p className="e-dim">The server lists no tools.</p> : null}
      <ul className="e-list">
        {tools.map((t) => (
          <li className="e-item" key={t.name}>
            <div className="e-item-head">
              <span className="e-item-title e-num">{t.name}</span>
              <label className="sr-only" htmlFor={`risk-${t.name}`}>Risk of {t.name}</label>
              <select id={`risk-${t.name}`} value={t.risk} onChange={(e) => void change(t.name, e.target.value as Risk)}>
                {(["read", "write", "destructive"] as Risk[]).map((r) => (
                  <option key={r} value={r}>{RISK_META[r].label}</option>
                ))}
              </select>
            </div>
            {t.description ? <div className="e-dim">{t.description}</div> : null}
          </li>
        ))}
      </ul>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </section>
  );
}

function CallsTable({ calls }: { calls: CallRow[] }) {
  if (calls.length === 0) return <p className="e-dim">No call yet. Each call appears here with its result. The log never holds a payload.</p>;
  return (
    <table className="keys-table calls-table">
      <caption className="sr-only">Recent calls</caption>
      <thead>
        <tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Caller</th><th scope="col">Result</th></tr>
      </thead>
      <tbody>
        {calls.map((c, i) => (
          <tr key={`${c.at}-${i}`}>
            <td data-label="When" className="e-num">{relative(c.at)}</td>
            <td data-label="Action">{c.actionId}</td>
            <td data-label="Caller">{c.caller}</td>
            <td data-label="Result">
              <Badge tone={c.outcome === "ok" ? "ok" : c.outcome === "pending_approval" ? "corona" : "warn"}>{c.outcome.replace(/_/g, " ")}</Badge>
              <span className="e-dim e-num"> {c.httpStatus ? `HTTP ${c.httpStatus}` : ""} {c.ms !== null ? `${c.ms} ms` : ""}</span>
              {c.error ? <div className="e-dim">{c.error}</div> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ConnectionDrawer({
  token,
  connector,
  connectionId,
  onSelect,
  onAddAnother,
  onClose,
  onChanged,
  onUnauthorized,
}: {
  token: string;
  connector: ConnectorView;
  connectionId: string;
  onSelect: (connectionId: string) => void;
  onAddAnother: () => void;
  onClose: () => void;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const dialogRef = useModal(onClose);
  const [detail, setDetail] = useState<ConnectionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"disconnect" | "send" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await fetchConnection(token, connectionId);
      if (alive.current) {
        setDetail(next);
        setLoadError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setLoadError(err instanceof Error ? err.message : "Could not read the connection.");
    }
  }, [token, connectionId, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    setDetail(null);
    setTest(null);
    setNotice(null);
    setConfirm(null);
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  async function guarded(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setNotice(err instanceof Error ? err.message : "The request failed.");
    }
    setBusy(null);
  }

  const conn = detail?.connection;
  const status = conn ? CONNECTION_STATUS_META[conn.status] : null;
  const sends = testSends(connector);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabIndex={-1}>
        <div className="modal-head">
          <h2 className="modal-title" id="drawer-title">{connector.name}</h2>
          <button className="btn btn-quiet" onClick={onClose} aria-label="Close the details">Close</button>
        </div>
        <p className="e-dim">
          {CATEGORY_LABEL[connector.category] ?? connector.category} · {connector.apiVersion || `version ${connector.version}`} ·{" "}
          <a href={connector.docsUrl} target="_blank" rel="noopener noreferrer">Docs</a>
        </p>

        {connector.connections.length > 1 ? (
          <div className="field">
            <label htmlFor="drawer-connection">Connection</label>
            <select id="drawer-connection" value={connectionId} onChange={(e) => onSelect(e.target.value)}>
              {connector.connections.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
        ) : null}
        <button className="btn btn-quiet" onClick={onAddAnother}>Add another connection</button>

        {loadError ? <p className="field-error" role="alert">{loadError}</p> : null}
        {!detail && !loadError ? <p className="e-dim" role="status">Loading the details</p> : null}

        {detail && conn && status ? (
          <>
            <section className="drawer-section" aria-label="State">
              <p>
                <Badge tone={status.tone}>{status.label}</Badge>{" "}
                <strong>{conn.label}</strong>
              </p>
              <p className="e-dim">
                Last test {relative(conn.lastTestAt)}
                {conn.lastTestMs !== null ? ` · ${conn.lastTestMs} ms` : ""}
                {conn.lastTestOk === false ? " · failed" : conn.lastTestOk ? " · passed" : ""}
              </p>
              {conn.lastError ? <p className="field-error" role="alert">{conn.lastError}</p> : null}
              {Object.keys(conn.config).length > 0 ? (
                <dl className="e-facts">
                  {Object.entries(conn.config).map(([k, v]) => (
                    <div className="e-fact" key={k}><dt>{k}</dt><dd className="e-num">{v}</dd></div>
                  ))}
                </dl>
              ) : null}
              <p className="e-dim">Stored secrets: {conn.secretNames.length > 0 ? conn.secretNames.join(", ") : "none"}. TITAN never shows their values.</p>

              <div className="modal-actions">
                {conn.status === "needs_authorization" || conn.status === "needs_reconnect" ? (
                  <button
                    className="btn btn-primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void guarded("oauth", async () => {
                        const { authorizeUrl } = await beginOAuth(token, connector.id, conn.id);
                        window.location.assign(authorizeUrl);
                      })
                    }
                  >
                    {conn.status === "needs_reconnect" ? "Sign in again" : "Approve access"}
                  </button>
                ) : null}
                {sends ? (
                  confirm === "send" ? (
                    <>
                      <button className="btn btn-primary" disabled={busy !== null} onClick={() => void guarded("test", async () => { setConfirm(null); setTest(await testConnectionNow(token, conn.id, true)); refresh(); })}>Yes, send a test message</button>
                      <button className="btn btn-quiet" onClick={() => setConfirm(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn" onClick={() => setConfirm("send")}>Send test</button>
                  )
                ) : (
                  <button className="btn" disabled={busy !== null} onClick={() => void guarded("test", async () => { setTest(await testConnectionNow(token, conn.id)); refresh(); })}>
                    {busy === "test" ? "Testing" : "Test now"}
                  </button>
                )}
                <button className="btn btn-quiet" onClick={() => setRenaming(renaming === null ? conn.label : null)}>Rename</button>
                {confirm === "disconnect" ? (
                  <>
                    <button className="btn btn-danger" disabled={busy !== null} onClick={() => void guarded("disconnect", async () => { const out = await disconnectConnection(token, conn.id); onChanged(); if (out.warnings?.length) setNotice(out.warnings.join(" ")); onClose(); })}>Yes, disconnect</button>
                    <button className="btn btn-quiet" onClick={() => setConfirm(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="btn btn-quiet" onClick={() => setConfirm("disconnect")}>Disconnect</button>
                )}
              </div>
              {confirm === "disconnect" ? <p className="e-hint">TITAN deletes the stored secrets{connector.id === "telegram" ? " and removes the webhook at Telegram" : ""}. This cannot be undone.</p> : null}
              {renaming !== null ? (
                <div className="field">
                  <label htmlFor="rename-input">New name</label>
                  <div className="key-input-row">
                    <input id="rename-input" type="text" maxLength={60} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
                    <button className="btn btn-primary" disabled={!renaming.trim() || busy !== null} onClick={() => void guarded("rename", async () => { await renameConnection(token, conn.id, renaming.trim()); setRenaming(null); refresh(); })}>Save</button>
                  </div>
                </div>
              ) : null}
              {test ? (
                <p className={test.ok === false ? "field-error" : "e-hint"} role={test.ok === false ? "alert" : "status"}>
                  {test.ok === true ? `The test passed in ${test.ms} ms.` : test.ok === false ? `The test failed. ${test.error ?? ""}` : test.message ?? "No test ran."}
                </p>
              ) : null}
              {notice ? <p className="field-error" role="alert">{notice}</p> : null}
            </section>

            {connector.id === "telegram" ? <TelegramSection token={token} detail={detail} onChanged={refresh} onUnauthorized={onUnauthorized} /> : null}
            {connector.id === "webhook_in" ? <HookSection token={token} detail={detail} onChanged={refresh} onUnauthorized={onUnauthorized} /> : null}
            {connector.id === "mcp_remote" ? <McpToolsSection token={token} detail={detail} onChanged={refresh} onUnauthorized={onUnauthorized} /> : null}

            <section className="drawer-section" aria-label="Actions">
              <h3 className="guide-title">Actions</h3>
              <ul className="e-list">
                {detail.connector.actions.map((a) => (
                  <ActionRow
                    key={a.id}
                    token={token}
                    connectionId={conn.id}
                    action={a}
                    risk={a.risk}
                    mode={conn.policies[a.id] ?? (a.risk === "read" ? "auto" : "ask")}
                    onMode={(mode) => void guarded("policy", async () => { await setActionPolicy(token, conn.id, a.id, mode); refresh(); })}
                    onUnauthorized={onUnauthorized}
                  />
                ))}
              </ul>
            </section>

            <section className="drawer-section" aria-label="Call log">
              <h3 className="guide-title">Call log</h3>
              <CallsTable calls={detail.calls} />
            </section>
          </>
        ) : null}
      </div>
    </>
  );
}
