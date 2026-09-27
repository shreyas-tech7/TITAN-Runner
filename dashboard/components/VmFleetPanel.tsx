"use client";

/**
 * VM Fleet panel — Railway free VMs (ssh railway.new). A third execution
 * surface alongside the pulse and the sub-agent cluster: each card is a real
 * disposable Linux box (2 vCPU / 2 GB RAM) with a live public preview URL,
 * provisioned for free with no account and no card. Read-mostly: the
 * "+ Provision a VM" field files a request via POST /vms/provision, the
 * 1-minute Worker tick fires the vm-agent workflow, and this panel polls
 * GET /vms to show the fleet. No invented state — a box that hasn't reported
 * live yet is honestly "provisioning", and the 60-minute build / 24-hour
 * claim windows are shown as live countdowns off the real deadlines.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { relative } from "@/lib/time";
import { fetchVms, provisionVm, WorkerApiError, type VmRow, type VmStatus } from "@/lib/workerApi";

const STATUS_META: Record<VmStatus, { label: string; dot: string; text: string }> = {
  requested: { label: "Requested", dot: "dot-idle", text: "text-muted" },
  provisioning: { label: "Provisioning", dot: "dot-warn dot-pulsing", text: "text-warning" },
  live: { label: "Live", dot: "dot-live dot-pulsing", text: "text-signal" },
  claimed: { label: "Claimed", dot: "dot-live", text: "text-signal" },
  expired: { label: "Expired", dot: "dot-idle", text: "text-quiet" },
  failed: { label: "Failed", dot: "dot-fail", text: "text-failure" },
};

/** A coarse remaining-time display for a deadline, or "expired". */
function untilDeadline(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return `${h}h ${m}m left`;
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s left`;
}

function VmCard({ vm, now }: { vm: VmRow; now: number }) {
  const meta = STATUS_META[vm.status] ?? STATUS_META.requested;
  const buildLeft = vm.status === "live" || vm.status === "provisioning" ? untilDeadline(vm.build_deadline, now) : null;
  const claimLeft = vm.status === "live" || vm.status === "claimed" ? untilDeadline(vm.claim_deadline, now) : null;
  const name = vm.preview_url ? vm.preview_url.replace(/^https?:\/\//, "").replace(/\.up\.railway\.app.*/, "") : vm.id.slice(0, 8);

  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <span className={`dot ${meta.dot}`} aria-hidden />
      <span className="row-title mono" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      <span className="chip mono">{(vm.vcpu ?? 2)}vCPU · {((vm.ram_mb ?? 2048) / 1024)}GB</span>
      <span className="chip">{vm.provider}</span>
      {buildLeft && <span className="chip mono" title="Time left in the 60-minute build window">build {buildLeft}</span>}
      {claimLeft && <span className="chip mono" title="Time left to claim this box and keep it">claim {claimLeft}</span>}
      <span className="row-quiet mono">{relative(vm.updated_at ?? vm.created_at)}</span>
      <span className={`badge ${meta.text}`}>{meta.label}</span>
      {vm.preview_url && vm.status !== "expired" && (
        <a className="mono text-signal" href={vm.preview_url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
          open preview →
        </a>
      )}
      {vm.claim_url && (vm.status === "live" || vm.status === "provisioning") && (
        <a className="mono text-warning" href={vm.claim_url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
          claim to keep →
        </a>
      )}
      {vm.run_url && (
        <a className="mono text-quiet" href={vm.run_url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
          run →
        </a>
      )}
      {(vm.brief || vm.result_summary) && (
        <div className="field-hint" style={{ width: "100%", marginTop: 2 }}>
          {vm.result_summary || vm.brief}
        </div>
      )}
    </div>
  );
}

export default function VmFleetPanel({ token }: { token: string }) {
  const [vms, setVms] = useState<VmRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [justRequestedId, setJustRequestedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchVms(token);
      if (mounted.current) {
        setVms(result.vms);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    }
  }, [token]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const poll = window.setInterval(() => void load(), 30_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [load]);

  async function handleProvision() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await provisionVm(token, brief.trim());
      setBrief("");
      setJustRequestedId(result.id);
      void load();
    } catch (err) {
      setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    } finally {
      setSubmitting(false);
    }
  }

  const liveCount = vms?.filter((v) => v.status === "live" || v.status === "claimed").length ?? 0;

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">
          VM fleet — Railway free VMs{vms ? ` (${liveCount} live / ${vms.length} recent)` : ""}
        </span>
        <span className="text-quiet" style={{ fontSize: 11 }}>
          ssh railway.new · 2 vCPU / 2 GB · no account, no card · 60m build, 24h to claim
        </span>
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label htmlFor="vm-brief">Provision a VM</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
          <textarea
            id="vm-brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="What should the box build? (optional — leave blank for a bare VM)"
            style={{ flex: 1, minWidth: 200, minHeight: 38 }}
          />
          <button className="btn btn-primary" onClick={handleProvision} disabled={submitting}>
            {submitting ? "Requesting…" : "Provision"}
          </button>
        </div>
        {error && <div className="field-error">{error}</div>}
        {justRequestedId && !error && (
          <div className="field-hint">
            Requested as <span className="mono">{justRequestedId}</span> — the next 1-minute Worker tick fires the
            vm-agent workflow, then the live preview URL appears here.
          </div>
        )}
      </div>

      {error && vms === null && <div className="empty">{error}</div>}
      {!error && vms === null && <div className="empty">Loading…</div>}
      {vms?.length === 0 && (
        <div className="empty">
          No VMs provisioned yet — provision one above, or run the vm-agent workflow from the Actions tab.
        </div>
      )}
      {vms && vms.length > 0 && (
        <div>
          {vms.map((vm) => (
            <VmCard key={vm.id} vm={vm} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
