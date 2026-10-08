"use client";

/**
 * The Connectors page (Wave 12, C4). The Worker is the broker: it keeps the secrets of every connection in the vault, and it
 * makes every outbound call. This page shows the catalog from the manifests, lets a person connect, test, and disconnect a
 * tool, and holds the Approvals, MCP, and Notifications tabs. The browser never calls a tool directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ApprovalsPanel from "@/components/ApprovalsPanel";
import ConnectModal from "@/components/ConnectModal";
import ConnectionDrawer from "@/components/ConnectionDrawer";
import McpPanel from "@/components/McpPanel";
import NotifyPanel from "@/components/NotifyPanel";
import VaultCard from "@/components/VaultCard";
import { Badge, Panel } from "@/components/kit";
import { fetchApprovals, fetchCatalog, testConnectionNow, type CatalogResponse, type ConnectorView } from "@/lib/connectorsApi";
import { CATEGORY_LABEL, cardView, categoriesOf, connectedCount, filterConnectors, testableConnections } from "@/lib/connectorsView";
import { relative } from "@/lib/time";
import { WorkerApiError, isWorkerConfigured } from "@/lib/workerApi";

type Tab = "tools" | "approvals" | "mcp" | "notify";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "tools", label: "Tools" },
  { id: "approvals", label: "Approvals" },
  { id: "mcp", label: "MCP" },
  { id: "notify", label: "Notifications" },
];

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "You did not approve the access, so the tool is not connected.",
  invalid_state: "The sign in took too long or came from another window. Start it again.",
  failed: "The sign in did not finish. Start it again.",
};

interface TestRow {
  label: string;
  ok: boolean | null;
  ms: number;
  text: string;
}

function readParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

function Icon({ text }: { text: string }) {
  return <span className="connector-icon" aria-hidden="true">{text.slice(0, 2).toUpperCase()}</span>;
}

export default function ConnectorsPage({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const t = readParams().get("tab");
    return TABS.some((x) => x.id === t) ? (t as Tab) : "tools";
  });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [open, setOpen] = useState<{ connectorId: string; connectionId: string } | null>(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [results, setResults] = useState<TestRow[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const alive = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const handled = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchCatalog(token);
      if (alive.current) {
        setCatalog(next);
        setError(null);
      }
      fetchApprovals(token, "pending").then((a) => alive.current && setWaiting(a.approvals.length)).catch(() => null);
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not read the connectors.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [load]);

  const connectors = catalog?.connectors ?? [];
  const vaultReady = catalog?.vault.ready ?? false;
  const shown = useMemo(() => filterConnectors(connectors, { query, category }, vaultReady), [connectors, query, category, vaultReady]);

  const runTestAll = useCallback(async () => {
    if (!catalog) return;
    setTesting(true);
    setResults([]);
    setTab("tools");
    const byId = new Map(catalog.connectors.map((c) => [c.id, c]));
    // A connector that sends a message when tested is left out. A test must never post by surprise.
    const targets = testableConnections(catalog.connectors).filter((c) => byId.get(c.connectorId)?.testMode !== "onClick");
    const rows: TestRow[] = [];
    for (const conn of targets) {
      try {
        const out = await testConnectionNow(token, conn.id);
        rows.push({ label: conn.label, ok: out.ok, ms: out.ms, text: out.ok === true ? "Passed" : out.ok === false ? out.error ?? "Failed" : out.message ?? "Not tested" });
      } catch (err) {
        if (err instanceof WorkerApiError && err.status === 401) {
          onUnauthorized();
          return;
        }
        rows.push({ label: conn.label, ok: false, ms: 0, text: err instanceof Error ? err.message : "Failed" });
      }
      if (alive.current) setResults([...rows]);
    }
    if (alive.current) {
      setTesting(false);
      if (rows.length === 0) setResults([]);
    }
    await load();
  }, [catalog, token, onUnauthorized, load]);

  // Read the address once the catalog is here: the return from an OAuth sign in, "Test all", and "Connect a tool".
  useEffect(() => {
    if (!catalog || handled.current) return;
    handled.current = true;
    const p = readParams();
    const done = p.get("connected");
    const failed = p.get("oauth_error");
    if (done) {
      const name = catalog.connectors.find((c) => c.id === done)?.name ?? done;
      setBanner({ tone: "ok", text: `${name} is connected.` });
    } else if (failed) {
      setBanner({ tone: "error", text: OAUTH_ERRORS[failed] ?? OAUTH_ERRORS.failed });
    }
    if (p.get("focus") === "search") searchRef.current?.focus();
    const want = p.get("connect");
    if (want && catalog.connectors.some((c) => c.id === want)) setConnecting(want);
    if (done || failed || p.has("testAll") || p.has("focus") || p.has("connect")) {
      const url = new URL(window.location.href);
      for (const k of ["connected", "oauth_error", "testAll", "focus", "connect"]) url.searchParams.delete(k);
      window.history.replaceState({}, "", url.toString());
    }
    if (p.has("testAll")) void runTestAll();
  }, [catalog, runTestAll]);

  function selectTab(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "tools") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState({}, "", url.toString());
  }

  if (!isWorkerConfigured()) {
    return (
      <Panel title="Connectors" eyebrow="Tools" tone="ion">
        <p className="e-dim">The Worker is not set for this build, so the dashboard cannot manage connectors. Set the repo variable <span className="e-num">TITAN_WORKER_URL</span> and rebuild the Pages site. See docs/RUNTIME.md.</p>
      </Panel>
    );
  }
  if (!catalog && !error) {
    return (
      <Panel title="Connectors" eyebrow="Tools" tone="ion">
        <p className="e-dim" role="status">Loading the connectors</p>
      </Panel>
    );
  }
  if (!catalog) {
    return (
      <Panel title="Connectors" eyebrow="Tools" tone="ion" actions={<button className="btn" onClick={() => void load()}>Try again</button>}>
        <p className="field-error" role="alert">{error}</p>
        <p className="e-dim">Check that the Worker runs and that this build knows its address. If the Worker says the token is wrong, lock the dashboard and enter the token again.</p>
      </Panel>
    );
  }

  const connector = (id: string): ConnectorView | undefined => connectors.find((c) => c.id === id);
  const drawerConnector = open ? connector(open.connectorId) : undefined;
  const connectingConnector = connecting ? connector(connecting) : undefined;

  return (
    <>
      <Panel
        title="Connectors"
        eyebrow="Tools"
        tone="ion"
        actions={
          <>
            <Badge tone="neutral">{connectedCount(connectors)} connected</Badge>
            {waiting > 0 ? <Badge tone="corona">{waiting} waiting</Badge> : null}
            <button className="btn" onClick={() => void runTestAll()} disabled={testing}>{testing ? "Testing" : "Test all"}</button>
            <button className="btn" onClick={() => void load()}>Refresh</button>
          </>
        }
      >
        {!catalog.vault.ready ? <VaultCard fix={catalog.vault.fix} /> : null}
        {banner ? (
          <div className="banner" role={banner.tone === "error" ? "alert" : "status"}>
            <span>{banner.text}</span>
            <button className="btn btn-quiet" onClick={() => setBanner(null)}>Dismiss</button>
          </div>
        ) : null}

        <div className="segmented" role="group" aria-label="Connector views">
          {TABS.map((t) => (
            <button key={t.id} id={`tab-${t.id}`} aria-pressed={tab === t.id} onClick={() => selectTab(t.id)}>
              {t.label}
              {t.id === "approvals" && waiting > 0 ? ` (${waiting})` : ""}
            </button>
          ))}
        </div>

        {tab === "tools" ? (
          <div id="panel-tools" aria-labelledby="tab-tools" role="region">
            <details className="how-it-works">
              <summary>How connectors work</summary>
              <p className="e-dim">A connector links TITAN to another tool. You paste a key or a link one time. The Worker encrypts it in the vault. The browser never sees it again.</p>
              <p className="e-dim">Each action has a risk. A read action only reads. A write action changes data, so a sub-agent needs your approval first. A destructive action needs a typed confirm, and only you can run it.</p>
              <p className="e-dim">Each action also has a data class. Personal data, such as mail and calendar, never goes to a public log or to a sub-agent.</p>
            </details>

            {results !== null ? (
              <section aria-label="Test results" className="guide" role="status">
                <h3 className="guide-title">Test results</h3>
                {results.length === 0 && !testing ? <p className="e-dim">No connection can be tested yet.</p> : null}
                <ul className="e-list">
                  {results.map((r) => (
                    <li className="e-item" key={r.label}>
                      <div className="e-item-head">
                        <Badge tone={r.ok === true ? "ok" : r.ok === false ? "danger" : "neutral"}>{r.ok === true ? "Passed" : r.ok === false ? "Failed" : "Not tested"}</Badge>
                        <span className="e-item-title">{r.label}</span>
                        <span className="e-dim e-num">{r.ms} ms</span>
                      </div>
                      {r.ok !== true ? <div className="e-dim">{r.text}</div> : null}
                    </li>
                  ))}
                </ul>
                <p className="e-dim">A connector that sends a message when tested is left out. Open it and choose Send test.</p>
              </section>
            ) : null}

            <div className="field">
              <label htmlFor="connector-search">Search connectors</label>
              <input id="connector-search" ref={searchRef} type="search" autoComplete="off" placeholder="Search by name or topic" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="chip-row" role="group" aria-label="Category">
              {["all", ...categoriesOf(connectors)].map((c) => (
                <button key={c} className="chip-button" aria-pressed={category === c} onClick={() => setCategory(c)}>
                  {c === "all" ? "All" : CATEGORY_LABEL[c] ?? c}
                </button>
              ))}
            </div>

            {shown.length === 0 ? <p className="empty">No connector matches. Clear the search or choose All.</p> : null}
            <ul className="connector-grid" aria-label="Connectors">
              {shown.map((c) => {
                const view = cardView(c, vaultReady);
                const attention = c.connections.find((x) => x.status !== "connected") ?? c.connections[0];
                return (
                  <li className="connector-card" key={c.id} data-connector={c.id} data-state={view.state}>
                    <div className="connector-card-head">
                      <Icon text={c.icon || c.name} />
                      <div>
                        <h3 className="connector-name">{c.name}</h3>
                        <span className="e-dim">{CATEGORY_LABEL[c.category] ?? c.category}</span>
                      </div>
                    </div>
                    <p className="e-dim connector-text">{c.description}</p>
                    <p>
                      <Badge tone={view.tone}>{view.label}</Badge>
                      {view.count > 0 ? <span className="e-dim"> {view.count} connection{view.count === 1 ? "" : "s"}</span> : null}
                    </p>
                    <p className="e-dim connector-meta">
                      {view.state === "none" || view.state === "setup" ? view.detail : `Last test ${relative(view.lastTestAt)}`}
                    </p>
                    <div className="connector-actions">
                      {c.connections.length > 0 ? (
                        <>
                          <button className="btn btn-primary" aria-label={`Open ${c.name}`} onClick={() => setOpen({ connectorId: c.id, connectionId: attention.id })}>Open</button>
                          <button className="btn btn-quiet" aria-label={`Connect another ${c.name}`} onClick={() => setConnecting(c.id)}>Add another</button>
                        </>
                      ) : (
                        <button className="btn btn-primary" aria-label={`Connect ${c.name}`} onClick={() => setConnecting(c.id)} disabled={view.state === "setup"}>Connect</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {tab === "approvals" ? (
          <div id="panel-approvals" aria-labelledby="tab-approvals" role="region">
            <ApprovalsPanel token={token} onUnauthorized={onUnauthorized} onChanged={() => void load()} />
          </div>
        ) : null}
        {tab === "mcp" ? (
          <div id="panel-mcp" aria-labelledby="tab-mcp" role="region">
            <McpPanel token={token} onUnauthorized={onUnauthorized} />
          </div>
        ) : null}
        {tab === "notify" ? (
          <div id="panel-notify" aria-labelledby="tab-notify" role="region">
            <NotifyPanel token={token} onUnauthorized={onUnauthorized} />
          </div>
        ) : null}
      </Panel>

      {connectingConnector ? (
        <ConnectModal
          token={token}
          connector={connectingConnector}
          vaultReady={vaultReady}
          onClose={() => setConnecting(null)}
          onChanged={() => void load()}
          onOpenDetails={(connectionId) => setOpen({ connectorId: connectingConnector.id, connectionId })}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {open && drawerConnector ? (
        <ConnectionDrawer
          token={token}
          connector={drawerConnector}
          connectionId={open.connectionId}
          onSelect={(connectionId) => setOpen({ connectorId: open.connectorId, connectionId })}
          onAddAnother={() => setConnecting(open.connectorId)}
          onClose={() => setOpen(null)}
          onChanged={() => void load()}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
