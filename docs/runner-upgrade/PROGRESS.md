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

## Next

Wave 3: failure taxonomy + per-class retry policy, breaker/explain, structured
output repair loop, dead-letter, loop detection, budgets, quota ledger.
