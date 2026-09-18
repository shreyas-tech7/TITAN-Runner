# Runner upgrade — progress log

Updated at the end of every wave. If the session dies, resume from the last
"Next" block. Branch: `claude/bold-galileo-w6go1e`, base `3396447` (origin/main).

## Regression floor (before any change)

95/95 tests, idle dry pulse 67–74 ms, 62 MB peak RSS, no lint/typecheck/build at root.

## Wave 0 — orient + security (done)

- `fd28632` docs: AS_FOUND.md, THREAT_MODEL.md, DECISIONS.md.
- `5eeee5d` security: intake author authorization, `/titan` command grammar,
  authorized-only retry, self-improve write jail, denylist widened.
- `d8f687b` security(ci): SHA-pinned actions, env passthrough, precise denylist
  gate, PR diff secret scan, static workflow checker, Worker intake filter.
- Tests: 119/119 (+ 16 worker tests run by glob).

## Wave 1 — seams + harness + baseline (done)

- `b8ac708` seams: `runPulse(deps)`, `TITAN_STATE_DIR`, GitHub client factory,
  `src/fakes/` (scripted provider, in-memory GitHub, env wiring).
- `811a250` bench: `bench/harness.mjs`, `bench/scenarios.mjs` (21 scenarios),
  `bench/results/before.json` = 7 pass / 4 fail / 10 not supported.

## Wave 2 — durable foundation (done)

Built, wired end to end, tested:

- `src/lib/validate.js` mini schema validator; `src/state/schema.js` (tasks v2,
  heartbeat, control, event, checkpoint schemas; v1→v2 migration with defaults).
- `src/state/store.js`: validated reads, repair from `state/backup/`, quarantine,
  atomic unchanged-skipping writes, ownership merge on save, task archive retention.
- `src/observability/events.js`: append-only redacted JSONL under `state/events/`,
  seq continuity across processes, torn-line tolerance, compaction after 14 days.
- `src/task/lifecycle.js`: 11 statuses, one transition table, `transition()` the
  only writer of `status`, bounded history, `effectivePriority()`.
- `src/task/leases.js`: O_EXCL lease files with TTL; `src/task/reconcile.js`:
  zombies, wake-ups, dependency outcomes, approval/pause/PR TTLs, orphans.
- `src/engine/pulseBudget.js`, `src/engine/checkpointer.js` (git mode: commit
  state/ only, rebase-autostash, temp-index re-apply on conflict),
  `src/engine/sideEffects.js` (keyed ledger + GitHub marker check),
  `src/engine/orchestrate.js` (plan/execute/synthesize with per-step checkpoints,
  resume, drain), `src/engine/pulse.js` (the engine), `src/pulse.js` (CLI wrapper).
- `src/issueSync.js`: idempotency keys + duplicate cancellation, `dependsOn` /
  `deadline` / `ttlHours` from the task YAML, `/titan` commands applied and audited.
- Scheduler: `resumeFrom`, `shouldDrain`, `drained` run state.
- Workflow: `TITAN_CHECKPOINT=git`, `TITAN_PULSE_BUDGET_MS=420000`.
- Tests: 163/163. Harness on this engine (repeat 1): 16 pass / 1 fail
  (`fails-permanently`, wave 3) / 4 not supported (wave 3–4).

Known gaps carried forward: no failure taxonomy yet (a permanent 401 still burns
15 calls through failover), no verification, no tools, no dashboard contract
update, no CLI, docs not yet rewritten.

## Wave 3 — reliability (done)

Built, wired end to end, tested:

- `src/reliability/failures.js`: the failure taxonomy (11 classes), `classifyFailure`,
  `aggregateClass`, `PARKABLE`. Every retry/park/dead-letter decision keys off a class.
- `src/reliability/retryPolicy.js`: one policy per class (same-model retries, hop
  limit to distinct candidates, jittered backoff, Retry-After honoured up to a 10 s
  inline cap, park ladder 5 m → 3 h), `decideRetry`, `parkFor`.
- `src/reliability/outputRepair.js`: "200 is not done" — empty / refusal / broken
  envelope is `malformed_output`, repaired with a hint on the same model (bounded).
- `src/reliability/loopDetector.js`: content-free signatures; a failure recurring
  verbatim on the same model is `poisoned`.
- `src/reliability/quota.js`: `state/quota.json`, per-provider minute/day windows,
  15 % daily reserve for high/urgent work, env overrides; consulted by the registry
  before every call.
- Registry: breaker-aware (`health.breakerState/explain`), quota-aware, failover
  bounded to 3 providers per `auto` call and none for a named provider (the
  scheduler rotates candidates); one `routing.decision` event per call; aggregate
  failure class on the thrown error. Provider base: inline retry only on a
  statusless network fault, once — the policy is the single retry authority.
- Scheduler: `#runWithRetry` driven by the policy; parks a step; repair hint
  reaches the prompt through `AgentAdapter._buildTaskPrompt` (phase2's diverged
  local copy removed). Decomposer: a parkable planning failure parks the task
  instead of degrading the plan. Bug found and fixed on the way: the retry
  backoff timer was unref'd, so a pulse could exit mid-backoff with the task
  still `running`.
- Engine: `waiting(provider | quota)` with wake time and `parks` counter,
  dead-letter past `TITAN_MAX_PARKS` (6), poisoned → dead-letter, task budgets
  (`TITAN_TASK_MAX_MODEL_CALLS` 40, `_TOKENS` 200k, `_WALL_MS` 60 min) with usage
  accumulated in the checkpoint across pulses, pulse call ceiling
  (`TITAN_PULSE_MAX_MODEL_CALLS` 120) that drains and stops claiming. Model calls
  counted at the adapter (every pool), upstream calls at the registry.
- `src/lib/clock.js`: one clock; `TITAN_CLOCK_OFFSET_MS` honoured only with the
  fakes wired, so the harness can advance 15 minutes per pulse like the cron.
- Capabilities declared: failure-taxonomy, waiting-state, output-repair,
  quota-ledger, breakers, budgets, task-dependencies.
- Tests: 205/205 (+42). Harness (repeat 1, 22 scenarios incl. new `quota-ledger`):
  20 pass / 0 fail / 2 not supported (`looping-task`, `refusal` — wave 4).
  `fails-permanently` 15 → 4 upstream calls; `provider-outage` 48 → 9.

## Next

Wave 4: verify/remediate loop (deterministic checks then model judge on a
different model), tools registry with typed schemas + side-effect classes +
SSRF-guarded safe tools, policy engine + autonomy levels, capabilities
`verification` and `loop-detection`.
