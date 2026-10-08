"use client";

/**
 * The health addresses of the services that TITAN does not own (Wave 12, H1): the Render sub-servers, the Hugging Face
 * orchestrator, and the God's Eye View host. The Worker calls each address with a GET and a time limit of 6 seconds. It
 * accepts https only. An address holds no key, so the list is safe to keep in the Worker settings.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHealthUrls, saveHealthUrls, type HealthUrl } from "@/lib/healthApi";
import { WorkerApiError } from "@/lib/workerApi";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,29}$/;

export default function HealthUrlsEditor({ token, onUnauthorized, onSaved }: { token: string; onUnauthorized: () => void; onSaved?: () => void }) {
  const [urls, setUrls] = useState<HealthUrl[] | null>(null);
  const [max, setMax] = useState(8);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await fetchHealthUrls(token);
      if (alive.current) {
        setUrls(out.urls);
        setMax(out.max);
        setError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not read the addresses.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const update = (i: number, patch: Partial<HealthUrl>) => setUrls((prev) => (prev ?? []).map((u, j) => (j === i ? { ...u, ...patch } : u)));

  async function save() {
    const list = (urls ?? []).map((u) => ({ id: u.id.trim().toLowerCase(), label: u.label.trim(), url: u.url.trim() }));
    for (const u of list) {
      if (!ID_PATTERN.test(u.id)) return setError(`The id "${u.id}" must start with a letter and use only a to z, 0 to 9, a dash, or an underscore.`);
      if (!u.label) return setError("Each address needs a label.");
      if (!/^https:\/\//.test(u.url)) return setError(`The address for "${u.label}" must start with https://.`);
    }
    if (new Set(list.map((u) => u.id)).size !== list.length) return setError("Each id must be different.");
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await saveHealthUrls(token, list);
      setUrls(out.urls);
      setNotice("Saved. The Health Center uses the new list on its next check.");
      onSaved?.();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Could not save the addresses.");
    }
    setBusy(false);
  }

  return (
    <div>
      <p className="e-dim">Add the health address of each service that TITAN should watch. The address must use https. The Worker sends a GET and waits 6 seconds.</p>
      {urls === null && !error ? <p className="e-dim" role="status">Loading the addresses</p> : null}
      {(urls ?? []).map((u, i) => (
        <fieldset className="field health-url" key={i}>
          <legend>Service {i + 1}</legend>
          <label htmlFor={`hu-id-${i}`}>Id</label>
          <input id={`hu-id-${i}`} type="text" autoComplete="off" spellCheck={false} value={u.id} onChange={(e) => update(i, { id: e.target.value })} />
          <label htmlFor={`hu-label-${i}`}>Label</label>
          <input id={`hu-label-${i}`} type="text" autoComplete="off" maxLength={60} value={u.label} onChange={(e) => update(i, { label: e.target.value })} />
          <label htmlFor={`hu-url-${i}`}>Health address</label>
          <input id={`hu-url-${i}`} type="url" autoComplete="off" spellCheck={false} placeholder="https://example.onrender.com/healthz" value={u.url} onChange={(e) => update(i, { url: e.target.value })} />
          <button type="button" className="btn btn-quiet" onClick={() => setUrls((prev) => (prev ?? []).filter((_, j) => j !== i))}>Remove service {i + 1}</button>
        </fieldset>
      ))}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {notice ? <p className="e-hint" role="status">{notice}</p> : null}
      <div className="modal-actions">
        <button className="btn" disabled={urls === null || urls.length >= max} onClick={() => setUrls((prev) => [...(prev ?? []), { id: "", label: "", url: "" }])}>Add a service</button>
        <button className="btn btn-primary" disabled={urls === null || busy} onClick={() => void save()}>{busy ? "Saving" : "Save addresses"}</button>
      </div>
    </div>
  );
}
