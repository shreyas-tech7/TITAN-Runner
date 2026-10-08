"use client";

/**
 * The setup checklist (Wave 12, H3). It shows on the home page until every item is green. Each item links to its fix. The
 * ring shows how many items are done. An item is green only when the Worker checked it: the page never marks one by itself.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Panel } from "@/components/kit";
import { fetchSetup, type SetupResponse } from "@/lib/healthApi";
import { fixHref, isExternalHref, nextSetupItem, ringGeometry } from "@/lib/healthView";
import { WorkerApiError, isWorkerConfigured } from "@/lib/workerApi";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function Ring({ done, total }: { done: number; total: number }) {
  const g = ringGeometry(done, total);
  return (
    <svg className="setup-ring" width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={`${done} of ${total} setup steps done`}>
      <circle cx="28" cy="28" r="22" fill="none" strokeWidth="5" className="setup-ring-track" />
      <circle cx="28" cy="28" r="22" fill="none" strokeWidth="5" strokeLinecap="round" className="setup-ring-fill" strokeDasharray={`${g.dash} ${g.gap}`} transform="rotate(-90 28 28)" />
      <text x="28" y="32" textAnchor="middle" className="setup-ring-text">{g.percent}%</text>
    </svg>
  );
}

export default function SetupChecklist({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await fetchSetup(token);
      if (alive.current) {
        setSetup(out);
        setError(null);
      }
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not read the setup state.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    if (!isWorkerConfigured()) return undefined;
    alive.current = true;
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [load]);

  if (!isWorkerConfigured()) return null;
  if (error && !setup) {
    return (
      <Panel title="Setup" eyebrow="Get started" tone="corona" actions={<button className="btn" onClick={() => void load()}>Try again</button>}>
        <p className="field-error" role="alert">{error}</p>
      </Panel>
    );
  }
  if (!setup || setup.complete) return null;
  const next = nextSetupItem(setup.items);

  return (
    <Panel title="Setup" eyebrow="Get started" tone="corona" actions={<Badge tone="neutral">{setup.done} of {setup.total} done</Badge>}>
      <div className="setup-body">
        <Ring done={setup.done} total={setup.total} />
        <div>
          <p className="e-dim">{next ? `Next: ${next.label}.` : "All steps are done."} This list goes away when every step is green.</p>
        </div>
      </div>
      <ul className="e-list" aria-label="Setup steps">
        {setup.items.map((i) => (
          <li className="e-item" key={i.id} data-setup={i.id} data-done={i.done}>
            <div className="e-item-head">
              <Badge tone={i.done ? "ok" : "warn"}>{i.done ? "Done" : "To do"}</Badge>
              <span className="e-item-title">{i.label}</span>
              {!i.done && i.link ? (
                <a href={fixHref(i.link.href, BASE)} {...(isExternalHref(i.link.href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{i.link.text}</a>
              ) : null}
            </div>
            <div className="e-dim">{i.detail}</div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
