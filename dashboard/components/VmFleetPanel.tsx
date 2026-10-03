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
import { Badge, Panel, StatusDot, type Tone } from "@/components/kit";
import { fetchVms, provisionVm, WorkerApiError, type VmRow, type VmStatus } from "@/lib/workerApi";

const STATUS_META: Record<VmStatus, { label: string; tone: Tone; pulse: boolean }> = {
  requested: { label: "Requested", tone: "neutral", pulse: false },
  provisioning: { label: "Provisioning", tone: "warn", pulse: true },
  live: { label: "Live", tone: "ok", pulse: true },
  claimed: { label: "Claimed", tone: "ion", pulse: false },
  expired: { label: "Expired", tone: "neutral", pulse: false },
  failed: { label: "Failed", tone: "danger", pulse: false },
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
    <li className="e-item">
      <div className="e-item-head">
        <StatusDot tone={meta.tone} pulse={meta.pulse} label={meta.label} />
        <span className="e-item-title e-num">{name}</span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <div className="e-item-head">
        <Badge tone="ion">
          {vm.vcpu ?? 2} vCPU, {(vm.ram_mb ?? 2048) / 1024} GB
        </Badge>
        <Badge>{vm.provider}</Badge>
        {buildLeft && (
          <Badge tone="warn" title="Time left in the 60-minute build window">
            build {buildLeft}
          </Badge>
        )}
        {claimLeft && (
          <Badge tone="corona" title="Time left to claim this box and keep it">
            claim {claimLeft}
          </Badge>
        )}
        <span className="e-dim e-num">{relative(vm.updated_at ?? vm.created_at)}</span>
      </div>
      <div className="e-item-links">
        {vm.preview_url && vm.status !== "expired" && (
          <a href={vm.preview_url} target="_blank" rel="noreferrer">
            Open preview
          </a>
        )}
        {vm.claim_url && (vm.status === "live" || vm.status === "provisioning") && (
          <a className="e-link-warn" href={vm.claim_url} target="_blank" rel="noreferrer">
            Claim to keep
          </a>
        )}
        {vm.run_url && (
          <a href={vm.run_url} target="_blank" rel="noreferrer">
            View run
          </a>
        )}
      </div>
      {(vm.brief || vm.result_summary) && <div className="e-hint">{vm.result_summary || vm.brief}</div>}
    </li>
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
    <Panel
      title="VM fleet"
      eyebrow="Railway free VMs"
      tone="ion"
      actions={vms ? <Badge tone={liveCount > 0 ? "ok" : "neutral"}>{liveCount} live of {vms.length} recent</Badge> : null}
    >
      <p className="e-hint" style={{ marginTop: 0 }}>
        ssh railway.new gives a 2 vCPU, 2 GB box with no account and no card. 60 minutes to build, 24 hours to claim.
      </p>
      <div className="e-form">
        <label htmlFor="vm-brief">Provision a VM</label>
        <div className="e-form-row">
          <textarea id="vm-brief" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What should the box build? Leave blank for a bare VM." />
          <button className="btn btn-primary" onClick={handleProvision} disabled={submitting}>
            {submitting ? "Requesting…" : "Provision"}
          </button>
        </div>
        {error && <div className="e-error" role="alert">{error}</div>}
        {justRequestedId && !error && (
          <div className="e-hint">
            Requested as <span className="e-num">{justRequestedId}</span>. The next 1-minute Worker tick fires the vm-agent workflow, then the live preview URL appears here.
          </div>
        )}
      </div>

      {!error && vms === null && <p className="e-dim">Loading…</p>}
      {vms?.length === 0 && <p className="e-dim">No VMs provisioned yet. Provision one above, or run the vm-agent workflow from the Actions tab.</p>}
      {vms && vms.length > 0 && (
        <ul className="e-list" aria-label="Recent VMs">
          {vms.map((vm) => (
            <VmCard key={vm.id} vm={vm} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
