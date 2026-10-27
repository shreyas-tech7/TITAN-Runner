"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import SafetyResearchPanel from "@/components/SafetyResearchPanel";
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
import TopTabs from "@/components/TopTabs";
import RunningTasksPanel from "@/components/RunningTasksPanel";
import AgentsPanel from "@/components/AgentsPanel";
import ThemeSwitch from "@/components/ThemeSwitch";
import OfflineNotice from "@/components/OfflineNotice";
import QuotaPanel from "@/components/QuotaPanel";
import LastPulsePanel from "@/components/LastPulsePanel";
import SetupChecklist from "@/components/SetupChecklist";
import VersionFooter from "@/components/VersionFooter";
import BriefCard from "@/components/BriefCard";
import SchedulesPanel from "@/components/SchedulesPanel";
import ActivityPanel from "@/components/ActivityPanel";
import CoreStage from "@/components/CoreStage";
import HudClock from "@/components/HudClock";
import SystemsDeck from "@/components/SystemsDeck";
import { THEMES, THEME_LABEL, applyTheme } from "@/lib/theme";
import { CORE_STATE_LABEL, coreState, engineSummary, parseDeckTab, taskSummary, type DeckTab } from "@/lib/core";
import { quotaRows, type QuotaRow, type QuotaState } from "@/lib/quota";

/** The current time, refreshed every 30 seconds. The quota windows are one UTC day and one minute wide. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

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
 * The Systems Deck panels that need the titan-runner-brain Worker's `/status` poll: God's Eye, the live Running
 * Tasks and co-processor roster, and the sub-agent cluster panels. Pulled into its own component (rather than
 * calling `useWorkerStatus` inline inside the AdminGate render-prop) so the hook has a real component instance to
 * attach to. Only the open deck tab mounts, so a closed deck does not poll the Worker.
 */
function WorkerScopedPanels({
  view,
  token,
  onUnauthorized,
  tasks,
  providers,
  agents,
  quota,
}: {
  view: "gods-eye" | "coprocessors" | "schedules";
  token: string;
  onUnauthorized: () => void;
  tasks: TaskRecord[];
  providers: Record<string, ProviderHealthRecord> | undefined;
  agents: AgentsState | undefined;
  quota: QuotaRow[];
}) {
  const workerStatus = useWorkerStatus(token);
  const subagents = workerStatus.data?.subagents ?? [];

  if (view === "gods-eye") return <GodsEyeSection token={token} providers={providers} agents={agents} />;

  if (view === "coprocessors") {
    return (
      <>
        <div className="bento-grid">
          <RunningTasksPanel tasks={tasks} subagents={subagents} workerConfigured={isWorkerConfigured()} />
          <AgentsPanel providers={providers} agents={agents} subagents={subagents} quota={quota} />
        </div>
        <ProviderHealthStrip providers={providers} />
      </>
    );
  }

  return (
    <>
      <div className="bento-grid">
        <SchedulesPanel token={token} onUnauthorized={onUnauthorized} />
        <ActivityPanel token={token} onUnauthorized={onUnauthorized} />
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
  const quota = usePolledJson<QuotaState>("state/quota.json", 60_000);

  const [query, setQuery] = useState(() => readUrlParam("q"));
  const [selectedTaskId, setSelectedTaskId] = useState(() => readUrlParam("task"));
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [optimistic, setOptimistic] = useState(() => listOptimisticTasks());
  const [streaming, setStreaming] = useState(false);
  const [deckOpen, setDeckOpen] = useState(false);
  const [deckTab, setDeckTab] = useState<DeckTab>("overview");

  // A link such as /?deck=brief opens the Systems Deck on that tab. The query filter and a chosen task also live in the deck.
  useEffect(() => {
    const fromUrl = parseDeckTab(readUrlParam("deck"));
    if (fromUrl) {
      setDeckTab(fromUrl);
      setDeckOpen(true);
    } else if (readUrlParam("q") || readUrlParam("task")) {
      setDeckOpen(true);
    }
  }, []);

  const openDeck = useCallback((tab: DeckTab) => {
    setDeckTab(tab);
    setDeckOpen(true);
  }, []);

  const focusQueueFilter = useCallback(() => {
    setDeckTab("overview");
    setDeckOpen(true);
    window.setTimeout(() => document.getElementById("queue-filter")?.focus(), 60);
  }, []);

  // A link from the Health Center, such as /?settings=health, opens Settings. The parameter goes away at once.
  useEffect(() => {
    if (readUrlParam("settings")) {
      setSettingsOpen(true);
      writeUrlParams({ settings: "" });
    }
  }, []);

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
        focusQueueFilter();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusQueueFilter]);

  const quotaNow = useMinuteClock();
  const quotaByProvider = useMemo(() => quotaRows(quota.data, quotaNow), [quota.data, quotaNow]);

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
        run: focusQueueFilter,
      },
      { id: "deck-brief", label: "Open the Daily Brief", run: () => openDeck("brief") },
      { id: "deck-coprocessors", label: "Open the co-processors", run: () => openDeck("coprocessors") },
      { id: "deck-gods-eye", label: "Open God's Eye", run: () => openDeck("gods-eye") },
      { id: "deck-toggle", label: "Show or hide the Systems Deck", run: () => setDeckOpen((v) => !v) },
      {
        id: "open-actions",
        label: "Open Actions",
        run: () => window.open(`https://github.com/${OWNER}/${REPO}/actions`, "_blank"),
      },
      { id: "open-repo", label: "Open repo", run: () => window.open(`https://github.com/${OWNER}/${REPO}`, "_blank") },
      { id: "toggle-settings", label: "Settings", run: () => setSettingsOpen(true) },
      { id: "open-chat", label: "Open Instant Chat", run: () => window.location.assign(`${BASE_PATH}/chat/`) },
      { id: "add-key", label: "Add a key", run: () => window.location.assign(`${BASE_PATH}/keys/`) },
      { id: "connect-tool", label: "Connect a tool", run: () => window.location.assign(`${BASE_PATH}/connectors/?focus=search`) },
      { id: "test-connectors", label: "Test all connectors", run: () => window.location.assign(`${BASE_PATH}/connectors/?testAll=1`) },
      { id: "open-health", label: "Open the Health Center", run: () => window.location.assign(`${BASE_PATH}/health/`) },
      { id: "open-approvals", label: "Open approvals", run: () => window.location.assign(`${BASE_PATH}/connectors/?tab=approvals`) },
      ...THEMES.map((t) => ({ id: `theme-${t}`, label: `Theme: ${THEME_LABEL[t]}`, run: () => applyTheme(t) })),
    ];
    const taskCommands: Command[] = allTasks.slice(-30).map((t) => ({
      id: `task-${t.id}`,
      label: `Jump to: ${t.title || t.id}`,
      run: () => setSelectedTaskId(t.id),
    }));
    return [...base, ...taskCommands];
  }, [allTasks, focusQueueFilter, openDeck]);

  const pulseAgeMinutes = useMemo(() => {
    const at = heartbeat.data?.lastPulseAt;
    const ms = at ? Date.now() - Date.parse(at) : NaN;
    return Number.isFinite(ms) ? Math.round(ms / 60_000) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heartbeat.data?.lastPulseAt, quotaNow]);
  const core = coreState({ streaming, pulseAgeMinutes, providers: providers.data?.providers });

  const anyFetching = heartbeat.lastFetchedAt || tasks.lastFetchedAt;
  const refreshAll = () => {
    heartbeat.refresh();
    tasks.refresh();
    providers.refresh();
    pulseHistory.refresh();
    quota.refresh();
  };

  return (
    <AdminGate>
      {(adminToken, lockDashboard) => (
    <div className="shell shell-core">
      <a className="sr-only" href="#main">
        Skip to main content
      </a>
      <header className="hud-bar">
        <div className="hud-id">
          <h1 className="brand">TITAN Core</h1>
          <div className={`hud-status hud-status-${core}`}>
            <span className="hud-status-dot" aria-hidden="true" />
            <span className="mono">
              {CORE_STATE_LABEL[core]} · {engineSummary(providers.data?.providers)}
            </span>
          </div>
          <HudClock />
        </div>
        <div className="topbar-actions">
          <StalenessBanner lastPulseAt={heartbeat.data?.lastPulseAt ?? null} token={ adminToken } />
          <LastFetchedIndicator lastFetchedAt={anyFetching ?? null} onRefresh={refreshAll} />
          <button className="btn btn-quiet" onClick={() => setPaletteOpen(true)}>
            <span className="kbd">⌘K</span>
          </button>
          <ThemeSwitch />
          <button className="btn btn-quiet" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button className="btn btn-primary" onClick={() => setNewTaskOpen(true)}>
            + New task
          </button>
        </div>
      </header>

      <TopTabs active="dashboard" />

      <main id="main">
      <OfflineNotice />

      <CoreStage state={core} tasks={allTasks} token={adminToken} onUnauthorized={lockDashboard} onStreamingChange={setStreaming} />

      <SetupChecklist token={adminToken} onUnauthorized={lockDashboard} />

      <SystemsDeck
        open={deckOpen}
        active={deckTab}
        onToggle={() => setDeckOpen((v) => !v)}
        onSelect={openDeck}
        summary={`${taskSummary(allTasks)} Pulse ${pulseAgeMinutes === null ? "unknown" : `${pulseAgeMinutes} min ago`}.`}
      >
        {deckTab === "overview" ? (
          <>
            <div className="vitals-grid">
              <CommandClock />
              <WeatherPanel />
            </div>

            <PulseBand heartbeat={heartbeat.data} pulses={pulseHistory.data?.pulses ?? []} loading={heartbeat.loading} error={heartbeat.error} />

            <div className="e-pair">
              <LastPulsePanel heartbeat={heartbeat} history={pulseHistory} />
              <QuotaPanel quota={quota} />
            </div>

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

            <SafetyResearchPanel />

            <PrPanel />
          </>
        ) : null}
        {deckTab === "brief" ? <BriefCard token={adminToken} onUnauthorized={lockDashboard} /> : null}
        {deckTab === "coprocessors" || deckTab === "gods-eye" || deckTab === "schedules" ? (
          <WorkerScopedPanels
            key={deckTab}
            view={deckTab}
            token={adminToken}
            onUnauthorized={lockDashboard}
            tasks={allTasks}
            providers={providers.data?.providers}
            agents={agents.data ?? undefined}
            quota={quotaByProvider}
          />
        ) : null}
      </SystemsDeck>

      </main>

      <footer>
      <p className="footer-note">
        Static export polling <code>state/*.json</code> — first from <code>raw.githubusercontent.com</code>{" "}
        (cache-busted on every request) for freshness, falling back to the copy baked in at the last dashboard
        build. TITAN-Runner is a <strong>PUBLIC</strong> repository: everything a pulse commits under{" "}
        <code>state/</code>, everything posted to an issue, and any task you file here is world-readable, forever
        — see the repo README before filing a task with anything sensitive in it. Press <span className="kbd">⌘K</span> for
        the command palette, <span className="kbd">n</span> for a new task, <span className="kbd">/</span> to filter.
      </p>
      <VersionFooter />
      </footer>

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
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} adminToken={ adminToken } onUnauthorized={lockDashboard} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
      )}
    </AdminGate>
  );
}
