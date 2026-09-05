# Architecture

A map of how TITAN-Runner is put together, so a change in one file is made
with a clear picture of what else it touches. For the *why* behind each
structural choice (public-repo-for-free, repo-as-database, the denylist
leash), see `docs/adr/` and the design notes in `docs/RUNTIME.md`.

## One pulse, end to end

```
GitHub issue (titan-task)
        │  dashboard: static Next.js export polls raw.githubusercontent.com + api.github.com
        ▼
  issueSync.js ──► state/tasks.json ──► pulse.js
                                          │
   pulse.js: primeHealth → sync/reconcile → claim (priority/TTL)
       → Reviewer Gate → decompose → Scheduler (router + retry + deadline)
       → synthesize → verify (A1) → writeRunRecord → comment/close → prune → heartbeat
                                          │
   providers: groq / together / openrouter / gemini / huggingface (+ opencode, freebuff=no-API)
   agents: AgentAdapter → freebuffAgent / opencodeAgent / phase2Agent
   state: tasks.json, agents.json, providers.json, heartbeat.json,
          pulse-history.json, runs/*.json, digests/*.md, reviews/*.jsonl
   workflows: titan-pulse, provider-selftest, keepalive, deadman, pages-deploy, ci
```

1. **Intake** (`src/issueSync.js`) — pulls open `titan-task` issues, parses
   the machine-readable YAML fence (`lib/taskYaml.js`), redacts, screens for
   injection intent, and appends new tasks to `state/tasks.json`.
2. **Claim** (`src/issueSync.js#selectClaims`) — priority (high→normal→low),
   then FIFO; optional TTL expires stale pending tasks.
3. **Reviewer Gate** (`src/reviewer/`) — Layer-1 deterministic policy plus an
   optional Layer-2 model verdict; can block a task before any work.
4. **Decompose** (`src/orchestrator/decomposer.js`) — one prompt → a validated,
   acyclic task graph (retry once on validation failure, then a single-task
   fallback).
5. **Schedule** (`src/orchestrator/scheduler.js` + `router.js`) — topological
   dispatch across the three pools, Freebuff reserved for the highest-
   complexity ready task, same-model-then-next-model retry, per-task deadline.
6. **Synthesize** (`src/orchestrator/synthesizer.js`) — merges every completed
   task's parsed output into one file tree + markdown summary.
7. **Verify** (`src/orchestrator/verifier.js`, roadmap A1) — a separate cheap
   pass judges the merged files against the master prompt. Never blocks.
8. **Persist & respond** (`src/pulse.js`) — writes the scrubbed run record to
   `state/runs/`, comments on and (on success) closes the issue, prunes old
   runs and old finished tasks into `state/digests/`, and records the
   heartbeat.

## The state model (the repo IS the database)

| File | Meaning | Writer |
|------|---------|--------|
| `tasks.json` | the live queue + recent finished tasks (bounded, E2) | pulse |
| `agents.json` | capability registry cache (seed table + observed stats) | pulse |
| `providers.json` | per-provider health/cooldown/model discovery | pulse + selftest |
| `heartbeat.json` | last pulse outcome + failure counter (dead-man's switch input) | pulse |
| `pulse-history.json` | rolling 60-entry timeline strip for the dashboard | pulse |
| `runs/*.json` | one record per orchestration run (capped, rolled into digests) | pulse |
| `digests/*.md` | compacted summaries of pruned runs and archived tasks | pulse |
| `reviews/*.jsonl` | every Reviewer Gate verdict, appended | pulse |

Writes go through write-to-temp-then-rename (`state/io.js#writeJsonAtomic`);
every string is scrubbed before it lands (`lib/secretScrub.js`); the workflow
commits whatever changed after the process exits, and a `GITHUB_TOKEN` push
never re-triggers the pulse (loop protection).

## Layers and their contracts

- **AgentAdapter** (`src/agents/AgentAdapter.js`) — the one interface every
  pool implements: `execute` / `listModels` / `probeCapabilities`, with the
  concurrency gate, timing, never-throw, and redaction cross-cutting concerns.
- **Provider registry** (`src/providers/`) — five free-tier chat providers
  behind `BaseProvider` + fixed failover order; `providers/health.js` tracks
  cooldowns so a dead/exhausted provider is skipped, not retried.
- **Pure vs. effectful split** — `decomposer/scheduler/synthesizer/router/
  verifier/outputParser` are pure (or dependency-injected) and unit-tested in
  isolation; `pulse.js`, `issueSync.js`, `state/*`, `github.js` own the I/O.

## Safety perimeter

`SECURITY.md` is the full map. In short: redaction + state scrubbing + the
Reviewer Gate + CI secret scan + the denylist leash + loop protection. The
denylisted paths are load-bearing and maintainer-mediated by design.
