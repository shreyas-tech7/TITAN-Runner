"use client";

import { useEffect, useMemo, useState } from "react";
import { usePolledJson } from "@/lib/usePolledJson";
import { useWorkerStatus } from "@/lib/useWorkerStatus";
import { isWorkerConfigured } from "@/lib/workerApi";
import type { HeartbeatState, TasksState, ProvidersState, PulseHistoryState, TaskRecord, AgentsState, ProviderHealthRecord } from "@/lib/types";
import { listOptimisticTasks, reconcileOptimisticTasks } from "@/lib/optimisticTasks";
import { OWNER, REPO } from "@/lib/githubApi";
import StalenessBanner from "@/components/StalenessBanner";
import PulseBand from "@/components/PulseBand";
import TaskQueueSection from "@/components/TaskQueueSection";
import RunHistorySection from "@/components/RunHistorySection";
import ProviderHealthStrip from "@/components/ProviderHealthStrip";
import PrPanel from "@/components/PrPanel";
import TaskDetailDrawer from "@/components/TaskDetailDrawer";
import NewTaskModal from "@/components/NewTaskModal";
import SettingsPanel from "@/components/SettingsPanel";
import CommandPalette, { type Command } from "@/components/CommandPalette";
import LastFetchedIndicator from "@/components/LastFetchedIndicator";
import AdminGate from "@/components/AdminGate";
import ClusterPanels from "@/components/ClusterPanels";
import CommandClock from "@/components/CommandClock";
import WeatherPanel from "@/components/WeatherPanel";
import GodsEyeSection from "@/components/GodsEyeSection";
import RunningTasksPanel from "@/components/RunningTasksPanel";
import AgentsPanel from "@/components/AgentsPanel";

function readUrlParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function writeUrlParams(params: Record<string, string>) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", url.toString());
}

/**
 * Everything that needs the titan-runner-brain Worker's `/status` poll —
 * God's Eye, the live Running Tasks / Agents roster, and the existing
 * sub-agent cluster panels. Pulled into its own component (rather than
 * calling `useWorkerStatus` inline inside the AdminGate render-prop) so the
 * hook has a real component instance to attach to: the render-prop is
 * invoked conditionally by AdminGate itself, and a hook can't live there
 * directly without breaking React's rules of hooks the moment the
 * dashboard is locked again.
 */
function WorkerScopedPanels({
  token,
  onUnauthorized,
  tasks,
  providers,
  agents,
}: {
  token: string;
  onUnauthorized: () => void;
  tasks: TaskRecord[];
  providers: Record<string, ProviderHealthRecord> | undefined;
  agents: AgentsState | undefined;
}) {
  const workerStatus = useWorkerStatus(token);
  const subagents = workerStatus.data?.subagents ?? [];

  return (
    <>
      <GodsEyeSection token={token} providers={providers} agents={agents} />

      <div className="bento-grid">
        <RunningTasksPanel tasks={tasks} subagents={subagents} workerConfigured={isWorkerConfigured()} />
        <AgentsPanel providers={providers} agents={agents} subagents={subagents} />
      </div>

      <ClusterPanels token={token} status={workerStatus} onUnauthorized={onUnauthorized} />
    </>
  );
}

export default function DashboardPage() {
  const heartbeat = usePolledJson<HeartbeatState>("state/heartbeat.json", 20_000);
  const tasks = usePolledJson<TasksState>("state/tasks.json", 20_000);
  const providers = usePolledJson<ProvidersState>("state/providers.json", 60_000);
  const pulseHistory = usePolledJson<PulseHistoryState>("state/pulse-history.json", 30_000);
  const agents = usePolledJson<AgentsState>("state/agents.json", 60_000);

  const [query, setQuery] = useState(() => readUrlParam("q"));
  const [selectedTaskId, setSelectedTaskId] = useState(() => readUrlParam("task"));
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [optimistic, setOptimistic] = useState(() => listOptimisticTasks());

  useEffect(() => writeUrlParams({ q: query }), [query]);
  useEffect(() => writeUrlParams({ task: selectedTaskId }), [selectedTaskId]);

  // Reconcile the optimistic (locally-filed, not-yet-confirmed) queue every
  // time real state arrives — task instructions, section 1: nothing stays
  // marked optimistic longer than it takes the real state file to confirm it.
  useEffect(() => {
    if (!tasks.data) return;
    reconcileOptimisticTasks(tasks.data.tasks);
    setOptimistic(listOptimisticTasks());
  }, [tasks.data]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (typing) return;
      if (e.key === "n") {
        e.preventDefault();
        setNewTaskOpen(true);
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("queue-filter")?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const allTasks = tasks.data?.tasks ?? [];
  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allTasks;
    return allTasks.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  }, [allTasks, query]);

  const selectedTask: TaskRecord | undefined = allTasks.find((t) => t.id === selectedTaskId);

  const commands: Command[] = useMemo(() => {
    const base: Command[] = [
      { id: "new-task", label: "New task", hint: "n", run: () => setNewTaskOpen(true) },
      {
        id: "jump-filter",
        label: "Filter the queue",
        hint: "/",
        run: () => document.getElementById("queue-filter")?.focus(),
      },
      {
        id: "open-actions",
        label: "Open Actions",
        run: () => window.open(`https://github.com/${OWNER}/${REPO}/actions`, "_blank"),
      },
      { id: "open-repo", label: "Open repo", run: () => window.open(`https://github.com/${OWNER}/${REPO}`, "_blank") },
      { id: "toggle-settings", label: "Settings", run: () => setSettingsOpen(true) },
    ];
    const taskCommands: Command[] = allTasks.slice(-30).map((t) => ({
      id: `task-${t.id}`,
      label: `Jump to: ${t.title || t.id}`,
      run: () => setSelectedTaskId(t.id),
    }));
    return [...base, ...taskCommands];
  }, [allTasks]);

  const anyFetching = heartbeat.lastFetchedAt || tasks.lastFetchedAt;
  const refreshAll = () => {
    heartbeat.refresh();
    tasks.refresh();
    providers.refresh();
    pulseHistory.refresh();
  };

  return (
    <AdminGate>
      {(adminToken, lockDashboard) => (
    <div className="shell">
      <div className="topbar">
        <div>
          <h1 className="brand">TITAN-Runner</h1>
          <div className="brand-sub">
            {OWNER}/{REPO} — free GitHub Actions pulse, no server, no card
          </div>
        </div>
        <div className="topbar-actions">
          <LastFetchedIndicator lastFetchedAt={anyFetching ?? null} onRefresh={refreshAll} />
          <button className="btn btn-quiet" onClick={() => setPaletteOpen(true)}>
            <span className="kbd">⌘K</span>
          </button>
          <button className="btn btn-quiet" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button className="btn btn-primary" onClick={() => setNewTaskOpen(true)}>
            + New task
          </button>
        </div>
      </div>

      <StalenessBanner lastPulseAt={heartbeat.data?.lastPulseAt ?? null} />

      <div className="vitals-grid">
        <CommandClock />
        <WeatherPanel />
      </div>

      <PulseBand heartbeat={heartbeat.data} pulses={pulseHistory.data?.pulses ?? []} loading={heartbeat.loading} />

      <WorkerScopedPanels token={adminToken} onUnauthorized={lockDashboard} tasks={allTasks} providers={providers.data?.providers} agents={agents.data ?? undefined} />

      <div className="field" style={{ maxWidth: 320, marginBottom: 8 }}>
        <input
          id="queue-filter"
          placeholder="Filter by title or id… ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter tasks"
        />
      </div>

      <TaskQueueSection
        tasks={filteredTasks}
        optimisticTasks={optimistic}
        onSelectTask={setSelectedTaskId}
        onNeedToken={() => setSettingsOpen(true)}
      />

      <RunHistorySection tasks={filteredTasks} onSelectTask={setSelectedTaskId} />

      <ProviderHealthStrip providers={providers.data?.providers} />

      <PrPanel />

      <p className="footer-note">
        Static export polling <code>state/*.json</code> — first from <code>raw.githubusercontent.com</code>{" "}
        (cache-busted on every request) for freshness, falling back to the copy baked in at the last dashboard
        build. TITAN-Runner is a <strong>PUBLIC</strong> repository: everything a pulse commits under{" "}
        <code>state/</code>, everything posted to an issue, and any task you file here is world-readable, forever
        — see the repo README before filing a task with anything sensitive in it. Press <span className="kbd">⌘K</span> for
        the command palette, <span className="kbd">n</span> for a new task, <span className="kbd">/</span> to filter.
      </p>

      {selectedTask && <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTaskId("")} />}
      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onFiled={() => {
            setOptimistic(listOptimisticTasks());
            setNewTaskOpen(false);
          }}
          onOpenSettings={() => {
            setNewTaskOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
      )}
    </AdminGate>
  );
}
