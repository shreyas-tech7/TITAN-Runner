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

## Wave 4 — autonomy loop: tools, policy, verification (done)

Built, wired end to end, tested:

- `src/policy/engine.js`: one pure decision per side effect (allow / approve /
  deny, with a reason and an approval key) from the effective autonomy level
  (dry-run < propose < approval < autonomous; stricter of control file and
  task), safe mode, the kill switch, and recorded `/titan approve|deny <key>`
  decisions. Audited as `policy.decision` events. Sits beside the Reviewer
  Gate (unchanged).
- `src/tools/registry.js`: typed tool definitions (schema-validated args, side
  effect class, risk, timeout, idempotency); `invoke()` = schema → gate's
  deterministic layer → policy → ledger replay → timeout → capped, redacted
  output; every call is a `tool.call` event. `src/tools/builtin.js`:
  `repo_read_file`, `repo_list_files`, `repo_search` (read jail: no `.git/`,
  `node_modules/`, credential names, traversal, symlink escape),
  `workspace_write` (the task's workspace under `state/`, never the checkout),
  `http_fetch` (`src/tools/ssrf.js`: https only, operator allowlist
  `TITAN_EGRESS_ALLOWLIST`, DNS-resolved public addresses only, no redirects,
  64 KB cap). `src/tools/callParser.js`: one fenced `{tool,args}` block per turn.
- Scheduler tool rounds: the same model is re-prompted with each result;
  the same call three times or more than six calls per step is a loop
  (`poisoned`, dead-lettered); a call that needs approval parks the task on
  `waiting(approval)` and the engine posts one request comment.
- `src/verify/checks.js` (steps complete, code steps produced files, files
  non-empty, no placeholders, no secrets, JSON parses, `node --check` on JS;
  conflicts warn), `src/verify/judge.js` (independent provider — none that
  planned or produced a step; strict JSON verdict), `src/verify/verify.js`
  (checks first, judge only when they pass; "unjudged" recorded honestly).
- `engine/orchestrate.js`: execute → synthesize → verify → remediate loop,
  bounded by `TITAN_MAX_REMEDIATIONS` (1); only the steps at fault and their
  dependents re-run, with the feedback in the prompt; a verdict already in the
  checkpoint is reused on a resume (no double judging).
- Engine: delivery and self-improve PRs are policy-gated (approval park,
  suppression under dry-run/safe mode with audit, human denial → cancelled);
  verification outcome and judge on the issue comment; `VERIFICATION_FAILED`
  is an honest terminal failure. `AgentAdapter._buildTaskPrompt` carries the
  tool catalogue, the transcript, and remediation feedback.
- Capabilities declared: verification, tools, loop-detection, policy-engine,
  approvals. Bench: judge rule added to every scenario script; `spans-pulses`
  code steps answer with a file (D-28).
- Tests: 231/231 (+26). Harness (repeat 1, 22 scenarios): 22 pass / 0 fail /
  0 not supported. First-pulse wall time rose from ~70 ms to ~150–230 ms in
  the fakes: the verifier's `node --check` child process and the judge call
  are real work now done per task (a real pulse spends seconds per model
  call, so this is invisible there).

## Wave 5 — control plane, views, data contract, dashboard lockstep (done)

- `src/control/dispatch.js` + `src/control/cli.js` + `.github/workflows/titan-control.yml`:
  kill-switch / drain / safe-mode on|off, autonomy <level>, and the task
  actions (cancel, pause, resume, retry, priority, approve, deny) — dispatched
  by a user with write access, attributed to `github.actor`, applied through
  the validated store, audited as `control.action` events, committed by the
  workflow. Inputs reach the script only through the environment.
- `src/observability/views.js`: `state/views/queue.json`, `analytics.json`,
  `providers.json` rebuilt every pulse (never read back by the engine).
  `src/observability/explain.js`: `explainTask` (what it waits on, how to
  unblock it, facts, recent trail) and `replayTask` (ordered event trail).
- Data contract: `SCHEMA_FILES` in `src/state/schema.js` exported to
  `schemas/*.schema.json` by `scripts/export-schemas.mjs`; `test/contract.test.js`
  fails on drift and checks the dashboard's `TaskStatus` / `WaitReason` /
  `TaskPriority` / `AutonomyLevel` unions, `STATUS_META`, `TaskRecord` fields,
  and the YAML builder's field names against the engine, textually.
- Dashboard: `lib/types.ts` (11 statuses, v2 fields, ControlState, QueueView,
  AnalyticsView), `lib/statusMeta.ts` (+ WAIT_REASON_LABEL), `lib/taskYaml.ts`
  (urgent, dependsOn/deadline/ttlHours), the queue section, running panel,
  and detail drawer render the new states; `copy-state.mjs` copies views.
  Not built in this run (no dependency install) — D-31.
- Bench: `beforePulse` hook (a human acting between pulses) and the
  `tool-approval` scenario (approval autonomy: tool write asks, then delivery
  asks; both approved; write lands in `state/workspaces/`).
- Tests: 244/244 (+13). Harness (repeat 1, 23 scenarios): 23 pass.

## Wave 6 — CLI and docs (done)

- `bin/titan.js` (`npm run simulate`, `npm run doctor`, `npm run bench`):
  `pulse`, `simulate` (fakes, no network, clock advanced per pulse),
  `explain`, `replay`, `queue|analytics|providers`, `control`, `doctor`
  (state validity, schema sync, keys, gate, allowlist, last pulse), `bench`.
  `--json` prints one line of JSON as the last line of output.
- Docs: `docs/RUNTIME.md` (pulse walkthrough, state table, policy engine,
  control plane rewritten for the v2 engine), `docs/CONFIG.md` (every
  `TITAN_*` variable with its default), `docs/DATA_CONTRACT.md` (every file,
  schema, version, writer, reader; versioning rules), `docs/RUNBOOK.md`
  (stop / brake / stuck task / provider / state / reproduce), README
  (security, commands, layout), `docs/runner-upgrade/STRATEGY.md`.
- Workflows: CI checks `schemas/` sync; the pulse passes
  `TITAN_EGRESS_ALLOWLIST` from a repo variable; `.env.example` extended.
- Tests: 246/246 (+2).

## Wave 7 — adversarial tests, after.json, review (done)

- `test/crash-matrix.test.js`: a real pulse process SIGKILLed right after
  the plan and after each of four steps (child processes, fake latency
  40–50 ms, kill 20 ms after the reply); the next pulse reclaims the zombie,
  plans once, runs every step exactly once, comments once, closes once.
- `test/chaos.test.js`: eight seeds × three pulses of random provider faults
  (5xx, 429, 402, 401, malformed, truncated, empty, refusal, statusless,
  dropped connection, failing judge); invariants: schema-valid state, no
  task left running, no orphan lease, no checkpoint on a terminal task,
  ≤ 1 completion comment and close per issue, continuous event seq, every
  event schema-valid, calls bounded.
- `test/security-corpus.test.js`: YAML cannot set internal fields; a secret
  in an issue reaches no state file, event, or comment; `/titan` grammar
  (first line only, exact bounded plain tokens — tightened here); an
  unauthorized author with a valid block, the self-improve label, and an
  approval comment causes zero calls and zero posts; hostile tool
  arguments; tripwires (no eval, no shell in tools/engine, the only direct
  GitHub mutations are the two revisit notifications, gate before policy
  before tool run, no OIDC outside Pages, control workflow contents-only).
- `test/migration.test.js`: the repository's own committed `state/` loads
  with no repair; every legacy status migrates; unknown fields survive;
  an invalid control file is repaired from backup or defaulted.
- `test/memory-ceiling.test.js`: a six-step pulse process peaks under 200 MB
  RSS (measured ~66 MB) with a 256 MB heap cap.
- Found and fixed by these tests: the event schema rejected hyphenated
  type names (`side-effect.fired`), so the contract had never matched the
  log; the command parser tolerated trailing tokens. Idle pulses no longer
  rewrite the three views for a timestamp.
- Tests: 269/269 (+23). `bench/results/after.json` recorded on the final
  engine commit (repeat 5, with tests) — numbers in REPORT.md.

## Final

- `bench/results/after.json` (commit `3000beb`, repeat 5, with tests):
  23 pass / 0 fail / 0 not supported; corpus completion 1.0; fault recovery
  1.0; 73 model calls; 269/269 tests. Full comparison in REPORT.md §9.
- Report: `docs/runner-upgrade/REPORT.md`. Rollout: `ROLLOUT.md`.
- Next: none in this run. The owner's checklist is REPORT.md §12.
