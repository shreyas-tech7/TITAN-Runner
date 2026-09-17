"use client";

/**
 * The provider-keys panel (build brief, section 4/5): one row per known
 * adapter showing configured/not from `provider_keys_meta`, and a form
 * that posts a raw key to the Worker's `POST /admin/keys` — which is the
 * only place that value ever exists outside GitHub's own encrypted secret
 * store (sealed-box encrypted in-Worker, never echoed back, never written
 * to D1 itself). This component never sees, stores, or logs the value
 * after the fetch call returns.
 */
import { useState } from "react";
import { relative } from "@/lib/time";
import {
  setProviderKey,
  diagnoseGithubPat,
  KNOWN_PROVIDERS,
  WorkerApiError,
  type ProviderKeyMetaRow,
} from "@/lib/workerApi";

export default function ProviderKeysPanel({
  token,
  providers,
  onChanged,
}: {
  token: string;
  providers: ProviderKeyMetaRow[];
  onChanged: () => void;
}) {
  const [provider, setProvider] = useState<string>(KNOWN_PROVIDERS[0]);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<{ ok: boolean; error?: string } | null>(null);

  const byProvider = new Map(providers.map((p) => [p.provider, p]));

  async function handleDiagnose() {
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      setDiagnosis(await diagnoseGithubPat(token));
    } catch (err) {
      setDiagnosis({ ok: false, error: err instanceof WorkerApiError ? err.message : "Could not reach the Worker." });
    } finally {
      setDiagnosing(false);
    }
  }

  async function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await setProviderKey(token, provider, trimmed);
      setValue("");
      setSavedFor(provider);
      window.setTimeout(() => setSavedFor(null), 2000);
      onChanged();
    } catch (err) {
      setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Provider keys</span>
      </div>

      <div>
        {KNOWN_PROVIDERS.map((id) => {
          const meta = byProvider.get(id);
          const configured = meta?.configured === 1;
          return (
            <div className="row" key={id}>
              <span className={`dot ${configured ? "dot-live" : "dot-idle"}`} aria-hidden />
              <span className="row-title mono">{id}</span>
              <span className={`badge ${configured ? "text-signal" : "text-quiet"}`}>
                {configured ? "Configured" : "Not configured"}
              </span>
              {meta?.updated_at && <span className="row-quiet mono">updated {relative(meta.updated_at)}</span>}
            </div>
          );
        })}
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn" onClick={handleDiagnose} disabled={diagnosing}>
            {diagnosing ? "Testing…" : "Test GitHub connection"}
          </button>
          {diagnosis && (
            <span className={diagnosis.ok ? "text-signal" : "text-quiet"}>
              {diagnosis.ok ? "✓ GITHUB_PAT works" : diagnosis.error}
            </span>
          )}
        </div>
        <div className="field-hint" style={{ marginTop: 4 }}>
          Confirms the Worker&apos;s GITHUB_PAT can reach GitHub&apos;s secrets API — check this before pasting a real
          key below.
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="provider-key-value">Set a key</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} style={{ maxWidth: 160 }}>
            {KNOWN_PROVIDERS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <input
            id="provider-key-value"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the API key…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!value.trim() || submitting}>
            {submitting ? "Saving…" : savedFor === provider ? "Saved" : "Save"}
          </button>
        </div>
        {error && <div className="field-error">{error}</div>}
        <div className="field-hint">
          Sealed-box encrypted in the Worker for GitHub&apos;s repository-secrets API and never stored anywhere else
          — not in D1, not in this browser, not echoed back in the response.
        </div>
      </div>
    </section>
  );
}
