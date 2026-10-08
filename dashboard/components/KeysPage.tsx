"use client";

/**
 * The Keys page (Wave 12, K7). One row for each provider in the catalog. The state of a row is the truth: it comes from
 * the GitHub secret list, the provider check, and the runner proof, never from a flag that a form set.
 */
import { useCallback, useEffect, useState } from "react";
import AddKeyModal from "@/components/AddKeyModal";
import KeysTable from "@/components/KeysTable";
import RemoveKeyModal from "@/components/RemoveKeyModal";
import RunnerCallbacks from "@/components/RunnerCallbacks";
import { Badge, Panel } from "@/components/kit";
import { fetchKeyEvents, testKey, type KeyEvent, type KeyRow } from "@/lib/keysApi";
import { configuredCount, noCardProviders, provenCount } from "@/lib/keyState";
import { relative } from "@/lib/time";
import { useKeys } from "@/lib/useKeys";
import { OWNER, REPO } from "@/lib/githubApi";
import { WorkerApiError, isWorkerConfigured } from "@/lib/workerApi";

const ACTIONS_URL = `https://github.com/${OWNER}/${REPO}/actions`;

function PatBanner({ pat }: { pat: NonNullable<ReturnType<typeof useKeys>["data"]>["pat"] }) {
  if (!pat) return null;
  return (
    <div className="banner" role="alert">
      <span>
        <strong className="text-warning">The Worker cannot see the repo secrets.</strong> <span className="text-muted">{pat.hint}</span>{" "}
        <span className="e-num">Permission: {pat.permission}</span>
      </span>
      <a className="btn btn-quiet" href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">
        Edit the token
      </a>
    </div>
  );
}

function VaultCard({ fix }: { fix: string | null }) {
  return (
    <div className="banner" role="status">
      <span>
        <strong>The vault is not ready.</strong> <span className="text-muted">Chat and some connectors need it. {fix}</span>
      </span>
      <a className="btn btn-quiet" href={`${ACTIONS_URL}/workflows/vault-provision.yml`} target="_blank" rel="noopener noreferrer">
        Open the workflow
      </a>
    </div>
  );
}

function EventsList({ events }: { events: KeyEvent[] }) {
  if (events.length === 0) return <p className="e-dim">No key events yet. Each save, test, and remove appears here.</p>;
  return (
    <ul className="e-list" aria-label="Key events">
      {events.map((e) => (
        <li className="e-item" key={e.id}>
          <div className="e-item-head">
            <Badge tone={e.action.includes("fail") || e.action.includes("rejected") ? "danger" : "neutral"}>{e.action.replace(/_/g, " ")}</Badge>
            <span className="e-item-title">{e.provider ?? "all"}</span>
            <span className="e-dim e-num">{relative(e.at)}</span>
          </div>
          <div className="e-row-sub e-num">
            {e.fingerprint ? <span>fingerprint {e.fingerprint}</span> : null}
            {e.old_fingerprint ? <span>old {e.old_fingerprint}</span> : null}
            {e.result ? <span>{e.result}</span> : null}
            <span>by {e.actor}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function KeysPage({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const keys = useKeys(token);
  const [adding, setAdding] = useState<{ provider?: string } | null>(null);
  const [removing, setRemoving] = useState<KeyRow | null>(null);
  const [events, setEvents] = useState<KeyEvent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (keys.unauthorized) onUnauthorized();
  }, [keys.unauthorized, onUnauthorized]);

  const loadEvents = useCallback(async () => {
    try {
      setEvents(await fetchKeyEvents(token, 20));
    } catch {
      // The list is a convenience. A failure here is not worth a banner.
    }
  }, [token]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents, keys.data?.generatedAt]);

  async function handleTest(row: KeyRow) {
    setNotice(null);
    try {
      await testKey(token, row.id);
      setNotice(`The runner test for ${row.label} started. The row updates when the result arrives.`);
      keys.fastFor(180_000);
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setNotice(err instanceof Error ? err.message : "The test could not start.");
    }
  }

  if (!isWorkerConfigured()) {
    return (
      <Panel title="Keys" eyebrow="Providers" tone="plasma">
        <p className="e-dim">The Worker is not set for this build, so the dashboard cannot manage keys. Set the repo variable <span className="e-num">TITAN_WORKER_URL</span> and rebuild the Pages site. See docs/RUNTIME.md.</p>
      </Panel>
    );
  }
  if (keys.loading && !keys.data) {
    return (
      <Panel title="Keys" eyebrow="Providers" tone="plasma">
        <p className="e-dim" role="status">Loading the keys</p>
      </Panel>
    );
  }
  if (keys.error && !keys.data) {
    return (
      <Panel title="Keys" eyebrow="Providers" tone="plasma" actions={<button className="btn" onClick={keys.refresh}>Try again</button>}>
        <p className="field-error" role="alert">{keys.error}</p>
        <p className="e-dim">Check that the Worker runs and that this build knows its address. If the Worker says the token is wrong, lock the dashboard and enter the token again.</p>
      </Panel>
    );
  }

  const data = keys.data!;
  const rows = data.providers;
  const none = configuredCount(rows) === 0;

  return (
    <>
      <Panel
        title="Keys"
        eyebrow="Providers"
        tone="plasma"
        actions={
          <>
            <Badge tone="neutral">{configuredCount(rows)} set</Badge>
            <Badge tone={provenCount(rows) > 0 ? "ok" : "neutral"}>{provenCount(rows)} proven</Badge>
            <button className="btn btn-primary" onClick={() => setAdding({})}>Add a key</button>
            <button className="btn" onClick={keys.refresh}>Refresh</button>
          </>
        }
      >
        <PatBanner pat={data.pat} />
        {!data.vault.ready ? <VaultCard fix={data.vault.fix} /> : null}
        {data.misnamedSecrets.map((m) => (
          <div className="banner" role="status" key={m.found}>
            <span>
              <strong>A secret has a spelling slip.</strong>{" "}
              <span className="text-muted">
                The repo has <span className="e-num">{m.found}</span>. The name that TITAN reads is <span className="e-num">{m.suggest}</span>. Save the key again on this page. Then delete the old secret on GitHub.
              </span>
            </span>
            <button className="btn btn-quiet" onClick={() => setAdding({ provider: m.provider })}>Add the {m.provider} key</button>
          </div>
        ))}
        {notice ? <p className="e-hint" role="status">{notice}</p> : null}

        {none ? (
          <div className="guide" role="note">
            <h3 className="guide-title">Add your first key in about one minute</h3>
            <p className="e-dim">These providers give a free key and need no card:</p>
            <ul className="guide-list">
              {noCardProviders(rows).map((p) => (
                <li key={p.id}>
                  <button className="btn btn-quiet" onClick={() => setAdding({ provider: p.id })}>{p.label}</button>{" "}
                  <a href={p.getKeyUrl} target="_blank" rel="noopener noreferrer">Get a free key</a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <KeysTable rows={rows} onAdd={(id) => setAdding({ provider: id })} onTest={(row) => void handleTest(row)} onRemove={setRemoving} />
        <p className="e-dim">
          {data.repo} · read {relative(data.generatedAt)} · request <span className="e-num">{data.requestId}</span>
        </p>
      </Panel>

      <Panel title="Key events" eyebrow="Audit" tone="ion">
        <EventsList events={events} />
      </Panel>

      <Panel title="Runner callbacks" eyebrow="Reliability" tone="ion">
        <RunnerCallbacks token={token} onUnauthorized={onUnauthorized} />
      </Panel>

      {adding ? (
        <AddKeyModal
          token={token}
          rows={rows}
          initialProvider={adding.provider}
          vaultReady={data.vault.ready}
          onClose={() => setAdding(null)}
          onChanged={() => {
            keys.refresh();
            void loadEvents();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {removing ? (
        <RemoveKeyModal
          token={token}
          row={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            keys.refresh();
            void loadEvents();
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
