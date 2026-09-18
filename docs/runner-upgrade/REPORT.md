# TITAN Runner upgrade — report

Branch `claude/bold-galileo-w6go1e`, cut from `origin/main` at `3396447`.
Twelve commits, one draft pull request, nothing merged, no live system
touched. Every number below is taken from a file in this branch
(`bench/results/before.json`, `bench/results/after.json`, the test runner)
and none was edited by hand.

## 1. Before

Runner was a single 15-minute GitHub Actions cron job (`src/pulse.js`) that
read `state/tasks.json`, claimed up to three pending tasks, ran them through
a reviewer gate, decomposed each into steps, dispatched the steps to five
free-tier providers with in-process retries, merged the outputs, posted a
comment, and committed `state/`. Measured on the base commit (Phase 0
floor): 95/95 tests, an idle dry pulse in 67–74 ms, 61.7 MB peak RSS.

What it could not do, measured by the harness on the baseline engine
(`before.json`, 21 scenarios, 7 pass / 4 fail / 10 not supported):

- A task killed mid-run restarted from zero and re-posted its comment
  (`kill-between-steps`, `kill-after-side-effect`: 1 duplicate comment).
- Two pulses at once ran the same task twice (`overlapping-pulses`).
- A provider that rejected a key with 401 was retried through three retry
  layers: 16 model calls for one doomed step (`fails-permanently`); a
  two-pulse outage cost 47 calls (`provider-outage`); an exhausted quota 16.
- A refusal, an empty answer, or broken JSON was accepted as "done".
- No task ever waited: it either finished or failed. No dependencies, no
  deadlines, no idempotency, no leases, no checkpoints, no events on disk,
  no tools, no policy, no verification, no control plane, no schemas.
- Security: a `titan-task` label was treated as authorization, so anyone
  could make the bot spend quota and post comments; a "retry" was any
  reopen; self-improve could write `.git/hooks/*` into the job that holds
  the keys; actions were pinned by tag; one workflow interpolated an event
  field into a shell line. (Fixed first, in their own commits.)

## 2. After

The same job, now an engine (`src/engine/pulse.js`, `runPulse(deps)`) with a
durable task model, one retry authority, a policy-gated autonomy loop, and
an operator's control plane. Harness on the final engine commit
(`after.json`, repeat 5, with tests): **23 scenarios, 23 pass, 0 fail, 0
not supported**; corpus completion 0.556 → 1.0; fault recovery 0.091 → 1.0;
model calls across the corpus 132 → 73 while running two more scenarios.
Tests 95 → 269, all passing. Docs, a CLI, schema files, a runbook.

Capability inventory (AS_FOUND "Before" column → now):

| Capability | Before | After |
|---|---|---|
| Persisted task states | 7 | 11 (`pending, running, waiting, paused, complete, failed, blocked, cancelled, expired, dead-lettered, pr-open`) |
| Legal-transition enforcement points | 0 | 1 table, one writer (`transition()`), every change an event |
| Recovery paths | 6 | 12 (retry-same, hop-next, output repair, park + wake, checkpoint resume, lease reclaim, dependency wake, breaker skip, quota skip, side-effect replay, backup repair, remediation) |
| Crash recovery | none | leases (O_EXCL, TTL) + checkpoints at every step boundary + git checkpointer |
| Tools | 0 | 5 (typed, jailed, policy-gated; SSRF-guarded fetch) |
| Persisted event types | 0 | 49 (append-only, redacted, audited) |
| Control actions | 3, unaudited | 11 workflow actions + 7 issue commands, all audited and attributed |
| Policy engine / autonomy levels | 0 | 4 levels + approvals + safe mode + kill switch |
| Verification after "done" | 0 | 8 deterministic checks + independent judge + bounded remediation |
| Schema files | 0 | 6, exported and drift-tested; dashboard held in lockstep |
| Tests | 95 | 269 in 52 files |

## 3. Features Added

- **Task model**: statuses above; wait reasons (`backoff, dependency,
  approval, budget, quota, pulse-budget, provider`); priorities incl.
  `urgent` with effective priority (age, deadline, dependents); `dependsOn`,
  `deadline`, `ttlHours`, per-task `autonomy` (stricter-only) from the issue
  YAML; idempotency keys (a duplicate submission is cancelled with one
  comment); pause/resume/cancel/retry/priority/approve/deny as `/titan`
  comments from authorized users.
- **Planning and execution loop**: plan → execute → synthesize → verify →
  remediate, checkpointed at every boundary and resumable by any later
  pulse; a parkable planning failure parks instead of degrading the plan.
- **Tools**: `repo_read_file`, `repo_list_files`, `repo_search` (read jail),
  `workspace_write` (per-task workspace under `state/`, never the checkout),
  `http_fetch` (https, operator allowlist, DNS-resolved public addresses
  only, no redirects, 64 KB). One call per model turn, transcript in the
  prompt, loop detection (3 identical calls / 6 rounds), approval parking.
- **Policy engine**: `dry-run | propose | approval | autonomous`, safe mode,
  kill switch, recorded approvals and denials; every side effect decided
  and audited; delivery and self-improve PRs gated the same way.
- **Verification**: steps complete, code steps produced files, nothing
  blank, no placeholders, no secret-shaped content, JSON parses, JS parses
  (`node --check`); then a judge model that produced no part of the run
  (plan included); "unjudged" recorded honestly; one targeted remediation
  with the feedback in the prompt; verification on the issue comment.
- **Control plane**: `titan-control.yml` (write-access users, `github.actor`
  recorded) and `titan control` for kill-switch / drain / safe-mode /
  autonomy / task actions; `/titan` issue commands.
- **CLI** `bin/titan.js`: `pulse`, `simulate`, `explain`, `replay`,
  `queue|analytics|providers`, `control`, `doctor`, `bench`.
- **Docs**: RUNTIME (rewritten), CONFIG, DATA_CONTRACT, RUNBOOK, README;
  `docs/runner-upgrade/` (AS_FOUND, THREAT_MODEL, STRATEGY, DECISIONS D-1…D-35,
  PROGRESS, ROLLOUT, this report).

## 4. Architecture Improvements

- One engine function with injected dependencies (GitHub client, pools,
  reviewer, clock, state directory) — the CLI, the workflow, the tests, and
  the harness all run the same code; the fakes sit *under* the real
  provider stack (a real `Phase2Agent` over a real `Registry` of real
  `BaseProvider` subclasses), so retries, breakers, and failover are always
  the real code.
- One place for each decision: a transition table for status
  (`task/lifecycle.js`), a failure taxonomy (`reliability/failures.js`), a
  policy per class (`reliability/retryPolicy.js`), a policy engine for side
  effects (`policy/engine.js`), one clock (`lib/clock.js`), one validated
  store (`state/store.js`), one side-effect ledger, one tool registry.
- Versioned state with migration (v1 → v2), backup/quarantine repair,
  ownership-aware merge on concurrent writes, retention (runs, tasks,
  events), and a git checkpointer that commits `state/` only, re-applies
  onto the remote's version, and never rewrites history.
- Every workflow SHA-pinned, least-privilege, untrusted text only via env;
  a static workflow linter, a diff secret scanner, and a schema-drift check
  in CI.

## 5. Reliability Improvements

- Leases + reconciliation: a dead pulse's task is reclaimed, not stuck;
  overlapping pulses cannot double-run (`overlapping-pulses`, four-process
  lease race test).
- Checkpoints + side-effect ledger with GitHub marker checks: a crash after
  any step re-runs nothing that finished and never re-posts a comment
  (`crash-matrix`: SIGKILL after the plan and after each of four steps;
  `kill-after-side-effect`).
- Failure taxonomy (11 classes) + per-class policy: a permanent 401 is
  never retried on the same provider; a 5xx hops once then parks; a 429
  honours Retry-After up to 10 s inline, otherwise parks; a quota error
  parks as `quota`; the park ladder (5 m → 3 h) and a park ceiling
  dead-letter a task that never recovers. The provider base no longer
  stacks its own 3× retry underneath (D-15).
- Output repair (empty / refusal / broken envelope re-prompted with a hint),
  loop detection (poisoned), budgets per task (calls, tokens, active time)
  and per pulse (time, calls) — every runaway ends in `dead-lettered` with
  a code.
- Breakers derived from provider health with `explain()`, and a quota ledger
  that skips a spent provider *before* it 429s (`quota-ledger` scenario).
- Verification refuses to accept a refusal or a code step with no code as
  "done"; remediation is bounded; a run that still fails is failed with the
  reason on the issue, never quietly marked complete.
- Found and fixed along the way: an unref'd backoff timer let a pulse exit
  mid-retry with its task still running; the event schema rejected the
  engine's own hyphenated event names; the command parser accepted
  trailing tokens.

## 6. Performance Improvements

Measured with synthetic 2–8 ms model latency, so these are Runner-overhead
numbers, not model-speed numbers:

- Model calls for the fault corpus fell where it mattered:
  `fails-permanently` 16 → 4, `provider-outage` 47 → 8, `quota-exhausted`
  16 → 4, `kill-between-steps` 9 → 6, `duplicate-submission` 4 → 2. Total
  across the corpus 132 → 73 with two more scenarios.
- An idle pulse makes zero model calls and writes only what changed: views
  are rewritten only when their content (not their timestamp) changes;
  unchanged state files are skipped; a quota ledger is saved only when
  dirty.
- Costs that went *up*, on purpose, and are reported as such: a single-step
  task's first pulse 114 → 188 ms (verification's `node --check` child
  process and the judge call are real work per task); an idle pulse
  75 → 97 ms and 4.2 → 10.6 KB of changed state (the event log and the
  richer heartbeat are the record; see Remaining Opportunities); peak RSS
  62.9 → 66.8 MB, enforced under 200 MB by `memory-ceiling.test.js`.

## 7. Observability Improvements

- Append-only redacted event log (`state/events/<date>.jsonl`, 49 types,
  continuous `seq`, `audit: true` on gate verdicts, policy decisions,
  control actions, side effects, suppressions), compacted to counts after
  14 days.
- Derived views every pulse (`state/views/queue.json`, `analytics.json`,
  `providers.json`): queue by status and wait reason, next wake, approvals
  pending, dead-letters; success rate, retries by class, parks, loops,
  verification pass rate and judge coverage, calls per task and per pulse,
  pulse p50/p95; breaker state per provider with a human line and quota use.
- `titan explain <taskId>` (what it waits on, how to unblock it, budget
  usage, gate, checkpoint, recent trail) and `titan replay <taskId>`.
- Versioned data contract as files (`schemas/`), a drift test, and the
  dashboard's types/status metadata/YAML builder held to the engine's
  lists by test.

## 8. Tests

269 tests in 52 files, all zero-network, run serially with a 512 MB heap
cap. New since the base (95): authorization, commands, path jail, workflow
lint, lifecycle, leases (incl. a four-process race), reconcile, state store
and migration, events, pulse budget, checkpointer (bare git remote),
side effects, failures, retry policy, output repair, loop detector, quota,
registry policy, clock, policy engine, tools (jail, SSRF, approval, ledger
replay, timeout), verification, control dispatch and CLI, views and
explain, contract, CLI, engine end-to-end (happy, resume, zombie, kill
switch, drain, duplicate, dependencies, commands, reliability, autonomy),
crash matrix (real SIGKILL at every boundary), chaos (8 seeds × 3 pulses of
random faults with invariants), security corpus, memory ceiling. The
benchmark harness (23 scenarios) is the integration suite the report
numbers come from.

## 9. Metrics

| Metric | before.json (`b8ac708`, after the security wave) | after.json (`3000beb`) |
|---|---|---|
| Scenarios pass / fail / not supported | 7 / 4 / 10 of 21 | 23 / 0 / 0 of 23 |
| Corpus completion rate | 0.556 | 1.0 |
| Fault recovery rate | 0.091 | 1.0 |
| Model calls, whole corpus | 132 | 73 |
| Duplicate side effects (per-issue metric) | 2 (two real duplicate comments) | 2 (the `tool-approval` scenario's two approval-request comments plus its result, counted by the same per-issue metric; every scenario's own duplicate check passes) |
| Idle pulse wall, median | 74.8 ms | 96.8 ms |
| Idle pulse changed state bytes, median | 4,224 | 10,558 |
| Single-step first pulse wall, median | 114 ms | 187.6 ms |
| Peak RSS, max | 62.9 MB | 66.8 MB |
| Tests | 119 / 119 | 269 / 269 |
| Phase 0 floor (base `3396447`) | 95 / 95 tests, idle 67–74 ms, 61.7 MB | — |

## 10. Remaining Opportunities

- The dashboard was brought into lockstep (types, status metadata, YAML
  builder, three components, state copy) but not built: no dependency
  install in this run. A `next build` is the first thing to run after
  merge.
- No live smoke test: no provider key exists here. The provider self-test
  workflow and the first real pulse are the live verification.
- The two self-improve revisit notifications post directly, not through
  the checkpointed ledger (a crash between the comment and the save could
  repeat one comment).
- Idle churn: the event log and the heartbeat still change every pulse
  (~10 KB); batching idle heartbeats (commit every Nth idle pulse) would cut
  git growth further.
- Judge coverage needs at least two configured providers; with one, every
  run is "unjudged" (recorded, and `TITAN_VERIFY_STRICT=1` can fail it).
- `http_fetch` checks DNS itself; a host that changes its answer between
  the check and the platform's connect is only bounded by the allowlist.
- The Cloudflare Worker queue is untouched and undeployed (D-6).
- Tools are read/search/workspace/fetch only; there is deliberately no code
  execution. A sandboxed test runner would be the next capability.
- Analytics' active-time percentiles need `activeMs` on completion events,
  which is recorded now but had no history before this branch.
- The `spans-pulses` corpus script was changed so its code steps produce
  files (D-28); everything else in `before.json`'s corpus is unchanged.

## 11. Verification and Honesty

- Everything measured here ran against the fakes with `TITAN_NETWORK=off`;
  no real provider, no real GitHub API, no live state, no repo setting was
  touched. The fake latency is synthetic, so timings are Runner overhead.
- `before.json` was recorded on `b8ac708` (seams, zero behavior change,
  after the security commits), with 119 tests; the Phase 0 floor on the base
  commit is 95 tests. `after.json` was recorded on `3000beb`. Neither file
  was edited by hand.
- Wall time and state bytes per pulse went up, for the reasons in §6 and
  §9; I chose not to hide that behind the call-count wins.
- The dashboard's TypeScript is checked by inspection and by the contract
  test, not by a compiler.
- One harness metric (`duplicateSideEffectsTotal`) is per-issue and reads 2
  after the approval flow legitimately posts three distinct comments;
  the per-scenario checks are the accurate signal.
- Two things claimed in earlier commit messages were corrected by the
  recorded JSON: the bench commit said "8 pass, 3 fail"; the file says 7 / 4.
- Exploit-level detail of the pre-existing security findings was kept out
  of committed files; the fixes and their tests are in.

## 12. My Checklist

1. Read the PR; do not merge until the dashboard builds
   (`cd dashboard && npm install && npm run build`) — the runner side is
   green, the dashboard side is unverified by a compiler.
2. Set the repository variable `TITAN_TASK_AUTHORS` if anyone besides you
   and collaborators should be able to file tasks (empty = only you and
   GitHub-verified collaborators).
3. Leave `TITAN_EGRESS_ALLOWLIST` empty unless a task should be able to
   fetch; then list exact hosts.
4. After merge, dispatch *TITAN Control* → `autonomy propose` for the first
   days: the runner will do the work and ask before posting anything.
   `titan-control.yml` becomes dispatchable once it exists on `main`.
5. Run *Provider self-test* once keys are set; then watch the first pulse
   with `node bin/titan.js doctor` and `state/views/*.json`.
6. Enable GitHub Pages (pre-existing checkpoint) if you want the dashboard.
7. Keep the Cloudflare Worker undeployed unless you take on D-6 separately.
8. If any secret was ever pasted into a task or comment, rotate it; the
   scrubbers are a backstop, not a promise.
