"use client";

/**
 * TITAN as an MCP server (Wave 12, M1, M2, M4). A tool such as Claude Code connects to the Worker route /mcp with a token.
 * A token has scopes, so it can do only what a person allowed. The Worker keeps a hash of the token. It shows the token one
 * time, in the answer to "Make token". This panel shows it one time too, and then drops it from the page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import CopyButton from "@/components/CopyButton";
import { Badge } from "@/components/kit";
import { createMcpToken, fetchMcpTokens, revokeMcpToken, type McpToken } from "@/lib/connectorsApi";
import { SCOPE_HELP, SENSITIVE_SCOPES, claudeCodeCommand, describeExpiry } from "@/lib/connectorsView";
import { relative } from "@/lib/time";
import { WorkerApiError, workerUrl } from "@/lib/workerApi";

const EXPIRY_CHOICES = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "", label: "Does not expire" },
];
const DEFAULT_SCOPES = ["status:read", "connectors:read"];

export function ClaudeCard() {
  const command = claudeCodeCommand(workerUrl());
  return (
    <section className="guide" aria-label="Use TITAN from Claude">
      <h3 className="guide-title">Use TITAN from Claude</h3>
      <ol className="guide-list">
        <li>Make a token below. Copy it when TITAN shows it.</li>
        <li>Run this command in a terminal. Replace <span className="e-num">&lt;YOUR_MCP_TOKEN&gt;</span> with the token.</li>
        <li>Start Claude Code and ask it to run <span className="e-num">titan_status</span>.</li>
      </ol>
      <pre className="result-box" tabIndex={0} aria-label="Claude Code command">{command}</pre>
      <CopyButton text={command} what="the Claude Code command" label="Copy command" />
      <p className="e-dim">This command holds a placeholder. TITAN never puts a real token in it.</p>
      <p className="e-hint"><strong>The Claude app. </strong>The Claude app adds a remote server as a custom connector, and it signs in with OAuth. TITAN does not support that sign in yet. Use Claude Code for now.</p>
    </section>
  );
}

export default function McpPanel({ token, scopes: allScopes, onUnauthorized }: { token: string; scopes?: string[]; onUnauthorized: () => void }) {
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [known, setKnown] = useState<string[]>(allScopes ?? []);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [chosen, setChosen] = useState<string[]>(DEFAULT_SCOPES);
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await fetchMcpTokens(token);
      if (alive.current) {
        setTokens(out.tokens);
        setKnown(out.scopes);
        setError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not read the tokens.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function make() {
    if (!label.trim()) return setProblem("Give the token a label, such as the name of the tool.");
    if (chosen.length === 0) return setProblem("Choose at least one scope.");
    setProblem(null);
    setBusy(true);
    try {
      const out = await createMcpToken(token, { label: label.trim(), scopes: chosen, ...(expiry ? { expiresInDays: Number(expiry) } : {}) });
      setFresh({ label: out.label, token: out.token });
      setLabel("");
      await load();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setProblem(err instanceof Error ? err.message : "Could not make the token.");
    }
    setBusy(false);
  }

  async function revoke(id: string) {
    try {
      await revokeMcpToken(token, id);
      setRevoking(null);
      await load();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Could not revoke the token.");
    }
  }

  const toggle = (scope: string) => setChosen((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));

  return (
    <>
      <ClaudeCard />

      {fresh ? (
        <div className="guide" role="status" aria-label="New token">
          <h3 className="guide-title">Token for {fresh.label}</h3>
          <p className="e-hint"><strong>Copy this token now. </strong>TITAN shows it one time only. It keeps a hash, not the token.</p>
          <p className="e-num" style={{ overflowWrap: "anywhere" }} data-testid="new-mcp-token">{fresh.token}</p>
          <CopyButton text={fresh.token} what="the token" label="Copy token" />
          <button className="btn btn-quiet" onClick={() => setFresh(null)}>I copied it. Hide it.</button>
        </div>
      ) : null}

      <section aria-label="Make a token">
        <h3 className="guide-title">Make a token</h3>
        <div className="field">
          <label htmlFor="mcp-label">Label</label>
          <input id="mcp-label" type="text" maxLength={60} autoComplete="off" placeholder="Claude Code on my laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <fieldset className="field scope-set">
          <legend>Scopes</legend>
          {known.map((s) => (
            <label className="check-row" key={s} htmlFor={`scope-${s}`}>
              <input id={`scope-${s}`} type="checkbox" checked={chosen.includes(s)} onChange={() => toggle(s)} />
              <span>
                <span className="e-num">{s}</span> {SENSITIVE_SCOPES.includes(s) ? <Badge tone="warn">Broad</Badge> : null}
                <span className="e-dim"> {SCOPE_HELP[s] ?? ""}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="mcp-expiry">Expires</label>
          <select id="mcp-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        {problem ? <p className="field-error" role="alert">{problem}</p> : null}
        <button className="btn btn-primary" disabled={busy} onClick={() => void make()}>{busy ? "Making" : "Make token"}</button>
      </section>

      <section aria-label="Tokens">
        <h3 className="guide-title" style={{ marginTop: 20 }}>Tokens</h3>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {tokens === null && !error ? <p className="e-dim" role="status">Loading the tokens</p> : null}
        {tokens !== null && tokens.length === 0 ? <p className="e-dim">No token yet. A tool cannot reach /mcp without one.</p> : null}
        {tokens && tokens.length > 0 ? (
          <table className="keys-table">
            <caption className="sr-only">MCP tokens</caption>
            <thead>
              <tr><th scope="col">Label</th><th scope="col">Scopes</th><th scope="col">Made</th><th scope="col">Last used</th><th scope="col">Expires</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} data-token={t.id}>
                  <td data-label="Label"><strong>{t.label}</strong>{t.clientId ? <div className="e-dim">Client {t.clientId}</div> : null}</td>
                  <td data-label="Scopes">{t.scopes.map((s) => (<Badge key={s} tone={SENSITIVE_SCOPES.includes(s) ? "warn" : "neutral"}>{s}</Badge>))}</td>
                  <td data-label="Made" className="e-num">{relative(t.createdAt)}</td>
                  <td data-label="Last used" className="e-num">{t.lastUsedAt ? relative(t.lastUsedAt) : "never"}</td>
                  <td data-label="Expires">{describeExpiry(t.expiresAt, t.revokedAt)}</td>
                  <td data-label="Actions" className="keys-actions">
                    {t.revokedAt ? (
                      <span className="e-dim">Revoked</span>
                    ) : revoking === t.id ? (
                      <>
                        <button className="btn btn-danger" onClick={() => void revoke(t.id)}>Yes, revoke</button>
                        <button className="btn btn-quiet" onClick={() => setRevoking(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn btn-quiet" onClick={() => setRevoking(t.id)}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}
