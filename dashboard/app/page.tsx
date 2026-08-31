"use client";

import { usePolledJson } from "@/lib/usePolledJson";
import type { AgentsState, HeartbeatState, TaskStatus, TasksState } from "@/lib/types";

const OWNER = process.env.NEXT_PUBLIC_GITHUB_OWNER || "shreyas-tech7";
const REPO = process.env.NEXT_PUBLIC_GITHUB_REPO || "TITAN-Runner";
const VAULT_REPO_OWNER = "shreyas-tech7";
const VAULT_ISSUE_LABEL = "titan-task";

const STATUS_META: Record<TaskStatus, { label: string; dot: string; text: string }> = {
  pending: { label: "Pending", dot: "bg-mist", text: "text-mist" },
  claimed: { label: "Claimed", dot: "bg-mist", text: "text-mist" },
  running: { label: "Running", dot: "bg-arc", text: "text-arc" },
  complete: { label: "Complete", dot: "bg-gold", text: "text-gold" },
  failed: { label: "Failed", dot: "bg-crimson", text: "text-crimson" },
  blocked: { label: "Blocked", dot: "bg-crimson", text: "text-crimson" },
  "pr-open": { label: "PR open", dot: "bg-arc", text: "text-arc" },
};

function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function newTaskUrl(): string {
  const params = new URLSearchParams({
    labels: VAULT_ISSUE_LABEL,
    title: "",
    body: "Describe the task for TITAN-Runner to pick up on its next pulse.\n\n",
  });
  return `https://github.com/${VAULT_REPO_OWNER}/${REPO}/issues/new?${params.toString()}`;
}

export default function DashboardPage() {
  const heartbeat = usePolledJson<HeartbeatState>("state/heartbeat.json", 20_000);
  const tasks = usePolledJson<TasksState>("state/tasks.json", 20_000);
  const agents = usePolledJson<AgentsState>("state/agents.json", 60_000);

  const hb = heartbeat.data;
  const taskList = tasks.data?.tasks ?? [];
  const active = taskList.filter((t) => !["complete", "failed", "blocked"].includes(t.status));
  const recent = [...taskList].reverse().slice(0, 20);

  const agentRows = Object.values(agents.data ?? {});

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="type-display">TITAN-Runner</h1>
          <div className="sub type-data">
            {OWNER}/{REPO} — free GitHub Actions pulse, no server, no card
          </div>
        </div>
        <a className="new-task-button" href={newTaskUrl()} target="_blank" rel="noreferrer">
          + New task
        </a>
      </div>

      <div className="panel">
        <div className="panel-title type-display">Pulse status</div>
        <div className="panel-body">
          {heartbeat.loading && !hb ? (
            <div className="empty">Loading…</div>
          ) : hb ? (
            <div className="grid">
              <div className="stat">
                <div className="label">Last pulse</div>
                <div className="value type-data">{relative(hb.lastPulseAt)}</div>
              </div>
              <div className="stat">
                <div className="label">Status</div>
                <div className="value">
                  <span className={`badge ${hb.lastPulseStatus === "ok" ? "text-gold" : "text-crimson"}`}>
                    <span className={`dot ${hb.lastPulseStatus === "ok" ? "bg-gold" : "bg-crimson"} pulse-live`} />
                    {hb.lastPulseStatus ?? "unknown"}
                  </span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Duration</div>
                <div className="value type-data">
                  {hb.lastPulseDurationMs != null ? `${(hb.lastPulseDurationMs / 1000).toFixed(1)}s` : "—"}
                </div>
              </div>
              <div className="stat">
                <div className="label">Cadence</div>
                <div className="value type-data">every {hb.cadenceMinutes}m</div>
              </div>
              <div className="stat">
                <div className="label">Total pulses</div>
                <div className="value type-data">{hb.totalPulses}</div>
              </div>
              <div className="stat">
                <div className="label">Consecutive failures</div>
                <div className="value type-data" style={hb.consecutivePulseFailures > 0 ? { color: "var(--color-crimson)" } : undefined}>
                  {hb.consecutivePulseFailures}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty">No heartbeat yet — the first pulse hasn&apos;t run.</div>
          )}
          {heartbeat.error && !hb ? <div className="empty text-crimson">Could not load heartbeat: {heartbeat.error}</div> : null}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title type-display">Task queue ({active.length} active)</div>
        <div className="panel-body">
          {active.length === 0 ? (
            <div className="empty">Nothing queued or in progress. File a task via &quot;+ New task&quot; above.</div>
          ) : (
            active.map((t) => (
              <div className="task-row" key={t.id}>
                <span className={`dot ${STATUS_META[t.status]?.dot ?? "bg-mist"}`} />
                <span className="title">{t.title || t.id}</span>
                {t.issueUrl ? (
                  <a className="type-data text-mist" href={t.issueUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10 }}>
                    #{t.issueNumber}
                  </a>
                ) : null}
                <span className={`badge ${STATUS_META[t.status]?.text ?? "text-mist"}`}>{STATUS_META[t.status]?.label ?? t.status}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title type-display">Recent run history</div>
        <div className="panel-body">
          {recent.length === 0 ? (
            <div className="empty">No runs yet.</div>
          ) : (
            recent.map((t) => (
              <div className="task-row" key={t.id}>
                <span className={`dot ${STATUS_META[t.status]?.dot ?? "bg-mist"}`} />
                <span className="title">{t.title || t.id}</span>
                <span className="type-data text-mist" style={{ fontSize: 10 }}>
                  {relative(t.completedAt ?? t.createdAt)}
                </span>
                <span className={`badge ${STATUS_META[t.status]?.text ?? "text-mist"}`}>{STATUS_META[t.status]?.label ?? t.status}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title type-display">Providers &amp; sub-agents</div>
        <div className="panel-body">
          {agentRows.length === 0 ? (
            <div className="empty">No capability data yet — populated after the first pulse.</div>
          ) : (
            agentRows.map((r) => (
              <div className="task-row" key={r.modelId}>
                <span className="dot bg-arc" />
                <span className="title type-data">{r.modelId}</span>
                <span className="type-data text-mist" style={{ fontSize: 10 }}>
                  {r.pool} · {r.latencyClass} · {Object.keys(r.observed).length} categor{Object.keys(r.observed).length === 1 ? "y" : "ies"} observed
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <p className="footer-note">
        This dashboard is a static export polling <code>state/*.json</code> committed by each pulse — first from{" "}
        <code>raw.githubusercontent.com</code> for freshness, falling back to the copy baked in at the last dashboard
        build. TITAN-Runner is a PUBLIC repository: everything a pulse commits under <code>state/</code> and everything
        posted to an issue is world-readable, forever, by design — see the repo README before filing a task with
        anything sensitive in it. Actions minutes are unlimited on this public repo, so there is no minute budget to
        track here; see <code>docs/RUNTIME.md</code> for the measured per-pulse duration instead.
      </p>
    </div>
  );
}
