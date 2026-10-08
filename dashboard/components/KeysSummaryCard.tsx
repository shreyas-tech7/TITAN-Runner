"use client";

/** A small card for the home page. It shows how many keys are set and proven, and links to the Keys page. */
import Link from "next/link";
import { Badge, Panel } from "@/components/kit";
import { configuredCount, provenCount } from "@/lib/keyState";
import { useKeys } from "@/lib/useKeys";
import { isWorkerConfigured } from "@/lib/workerApi";

export default function KeysSummaryCard({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const keys = useKeys(isWorkerConfigured() ? token : null, 120_000);
  if (keys.unauthorized) onUnauthorized();
  const rows = keys.data?.providers ?? [];
  const set = configuredCount(rows);
  const proven = provenCount(rows);
  return (
    <Panel
      title="Keys"
      eyebrow="Providers"
      tone="plasma"
      actions={<Link className="btn btn-primary" href="/keys">{set === 0 ? "Add your first key" : "Open the Keys page"}</Link>}
    >
      {!isWorkerConfigured() ? (
        <p className="e-dim">The Worker is not set for this build.</p>
      ) : keys.loading && !keys.data ? (
        <p className="e-dim" role="status">Loading the keys</p>
      ) : keys.error && !keys.data ? (
        <p className="field-error" role="alert">{keys.error}</p>
      ) : (
        <>
          <p>
            <Badge tone={set > 0 ? "ok" : "warn"}>{set} set</Badge> <Badge tone={proven > 0 ? "ok" : "neutral"}>{proven} proven</Badge>
          </p>
          {set === 0 ? <p className="e-dim">No key is set. Add your first key in about one minute.</p> : proven === 0 ? <p className="e-dim">No key is proven yet. Open the Keys page and click Test now.</p> : null}
          {keys.data?.misnamedSecrets.length ? <p className="e-hint">A secret has a spelling slip. Open the Keys page to fix it.</p> : null}
        </>
      )}
    </Panel>
  );
}
