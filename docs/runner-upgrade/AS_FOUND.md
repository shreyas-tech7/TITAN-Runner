# TITAN Runner — as found (before any change)

Base commit for this upgrade: `3396447` (`origin/main` tip, 2026-09-18T01:14Z, the
newest verified work — the only branch with a merge base to main that carries the
merged PRs #8–#12 plus 118 real pulses of state history). The older
`claude/runner-v2-build-w751g0` branch (open PR #5) has **no merge base** with
current `main` (history was rewritten underneath it) and was not used as a base.

Toolchain observed: Node v22.22.2, npm 10.9.7, 4 cores, 16 GB RAM. Root package has
zero runtime dependencies (`package-lock.json` is 262 bytes).

## Regression floor (Phase 0 numbers, measured on `3396447`)

| Check | Result |
|---|---|
| `npm test` (node:test, 18 files) | **95 pass / 0 fail / 0 skipped**, 586 ms suite, 972 ms wall |
| lint | none configured |
| typecheck | none at root; dashboard has `tsc` via Next but no `node_modules` installed here |
| build | none at root; dashboard `next build` not run (would need a ~300 MB install) |
| `worker/test` (7 tests) | not runnable without `worker/node_modules`; not run by CI either |
| `TITAN_DRY_RUN=1 node src/pulse.js` (idle) | exit 0, 67–74 ms process wall, `durationMs: 2` reported |
| dry pulse with one manual task, peak RSS | **61.7 MB** (VmHWM, sampled at 5 ms) |
| dry pulse writes into the **real** `state/` dir | yes — no state-dir seam exists |

Pre-existing failures: none in the root suite. Pre-existing red CI on merged PRs: the
`Denylist gate` step fails on every human PR that touches `.github/workflows/`,
`worker/`, or the other protected paths (PR #12's only check run concluded `failure`;
PR #9's description says the same) and the owner merges over it.

## What Runner is here

Runner = `src/pulse.js` + everything under `src/`. It is the task intake, planning,
routing, execution and delivery layer, run as a **GitHub Actions cron pulse** every
15 minutes. There is no long-running process anywhere in this repo.

## Runtime model

**(A) Ephemeral pulses**, with a half-built **(C) hybrid** bolted on the side:

- The pulse (`titan-pulse.yml` → `node src/pulse.js`) is the source of truth. Durable
  state is JSON under `state/`, committed by the workflow *after* the process exits.
- A Cloudflare Worker + D1 (`worker/`) mirrors the same `titan-task` issues into its
  **own second queue** (`subagents` table) and fires `repository_dispatch` →
  `spawn-subagent.yml` → `scripts/run-subagent-task.mjs`, which runs the issue body
  through the reviewer gate and one provider call. The docs call the double
  execution "redundant, and that's fine". Per docs the Worker code is **not deployed**
  (no Cloudflare secrets configured); the D1 database and schema exist live. Nothing
  reconciles the two queues; the Worker never writes `state/`.

Consequences of (A) that the current code does not handle: nothing survives a killed
job (no checkpoint before the end of the pulse), no lease, no zombie detection, no
time budget inside the process (only the workflow's 10-minute hard kill), and the
in-memory `running` status can never be observed by the next pulse.

## Entry points

| Entry | Trigger | What it runs |
|---|---|---|
| `src/pulse.js` | cron `*/15`, `workflow_dispatch` (`task-text`) | the whole pulse (below) |
| `scripts/run-subagent-task.mjs` | `repository_dispatch: spawn-subagent` from the Worker | gate + one `registry.chat` |
| `scripts/provider-selftest.mjs` | weekly + manual | live model discovery + 5-token probe per provider, writes `state/providers.json` |
| `scripts/weekly-rollup.mjs` | weekly | writes a digest, opens a `titan-digest` issue |
| `scripts/check-heartbeat.mjs` | daily (`deadman.yml`) | fails + opens `titan-alert` issue if heartbeat stale |
| `worker/src/index.js` | Worker cron every minute; HTTP routes | mirror issues → D1, dispatch, key intake, OSINT/geospatial/memory routes |

## One pulse, as found (`src/pulse.js#main`)

1. `ensureStateFiles()`; `primeProviderHealth()` stamps configured/not per provider.
2. Unless dry-run: `syncIssuesIntoTasks()` — every open issue labeled `titan-task`
   becomes a pending task, **no author check**. `reconcileIssueState()` — a pending
   task whose issue closed → `cancelled`; a terminal task whose issue is open and
   whose `updated_at` is newer than `completedAt` → reset to `pending` (this is how
   the dashboard's Retry works; **any comment by anyone** trips it).
3. `TITAN_MANUAL_TASK` env → a manual task.
4. Revisit `pr-open` tasks (self-improve PR CI status).
5. Claim first `TITAN_MAX_TASKS_PER_PULSE` (3) pending tasks (array order = FIFO;
   `priority` is stored but never used).
6. Per task: reviewer gate → `decompose` → `Scheduler.run` → `synthesize` → run record
   → issue comment (+ close on success) or self-improve PR.
7. Save capability registry, provider health, prune runs (>60), append pulse history
   (cap 60), write heartbeat, save tasks. Exit code 1 if the loop threw.

The workflow then runs the secret scan and commits `state/` with `git pull --rebase`
and push (conflict → skip this pulse's push).

## Task model and states (as found)

Persisted task (`state/tasks.json`, `version: 1`): `id`, `type` (`task` |
`self-improve`), `issueNumber`, `issueUrl`, `title`, `prompt`, `priority` (unused),
`routingHint`, `status`, `createdAt`, `claimedAt`, `startedAt`, `completedAt`, `runId`,
`prNumber`, `prUrl`, `error`.

Statuses the engine writes: `pending`, `running` (never reaches disk in practice),
`complete`, `failed`, `blocked`, `cancelled`, `pr-open` → **7**. Transitions are ad hoc
assignments spread across `pulse.js`, `issueSync.js`; there is no transition table.
The dashboard additionally types `claimed`, which nothing sets.

Sub-task (in-memory only, `orchestrator/scheduler.js`): `pending`, `queued`,
`running`, `complete`, `failed`, `blocked`, `cancelled`, `malformed_output` → 8 names,
of which `malformed_output` is never assigned by any code here (the `envelopeTier`
mechanism replaced it).

Missing outright: leases, checkpoints, dependencies between tasks, deadlines/TTL,
idempotency keys (the same issue can be re-filed twice and runs twice; a manual task
re-dispatched runs again), parent/child, pause, dead-letter, attempt counters at task
level, any retention for `tasks.json` (grows forever).

## Planning, routing, scheduling, execution, synthesis

- **Planning**: `decomposer.js` asks one adapter for a strict-JSON task graph (validated:
  aspects, complexity, ids, dangling deps, cycles, ≤8 tasks), one retry with the
  validation errors, then a single-task fallback. Dry-run returns a fixed sample graph.
- **Routing**: `router.js` scores every candidate model: category strength (+100) /
  weakness (−50), observed success (≤20), availability (0 if at cap), latency
  tiebreak, routing hint nudge. The reason string is recorded on the assignment.
- **Scheduling**: `scheduler.js` runs the graph topologically with real concurrency,
  Freebuff reserved for the most complex ready task, dependency outputs chained into
  the prompt (8k per dep / 24k total), per-attempt 120 s deadline, 3 attempts (same
  model twice, then next best), `blocked` cascade. Emits `run-state`/`task-state`
  events to `onEvent` — the pulse passes `() => {}`.
- **Execution**: three pools behind `AgentAdapter`: `freebuff` (no public API; offline
  fixture only), `opencode` (unverified contract), `phase2` (wraps the 5-provider
  `registry.js` failover). `BaseProvider.chat` has a 30 s deadline, semaphore of 4,
  `withRetry` ×3 with full jitter and Retry-After.
- **Synthesis**: `synthesizer.js` parses each output through the 3-tier envelope
  parser (tier 3 repair callback exists but the pulse never supplies one), merges files,
  flags path conflicts, builds a markdown summary.
- **Verification**: none. "Done" = every sub-task returned `ok`.

Bug found: `phase2Agent.js` carries its own `buildTaskPrompt()` copy that never got the
JSON-envelope instruction the base `_buildTaskPrompt` has, so phase2 workers are never
told the file-envelope contract (the header comment says to delete the copy once the
base method exists; it does).

## Providers and adapters

`groq`, `together`, `openrouter`, `gemini`, `huggingface` (registry, OpenAI-compatible
except Gemini), `omniroute` (opt-in gateway, tried first in auto mode), `opencode`
(agent pool), `freebuff` (disabled). Health store (`providers/health.js`) tracks status,
cooldowns (429 → backoff 5 min…60 min, 402/quota → 24 h, 404 → 10 min + drop model,
401/403 → `misconfigured` forever), EMA error rate, running-average latency, discovered
models. Model resolution: env pin → cached discovery → hardcoded default.

Live state on `main` today: all five providers `not_configured` except `openrouter`
(`configured: true`, status `error`, last error "OpenRouter returned no message
content", 3 consecutive failures). No task has ever completed live.

## Tools

None. There is no tool registry, no tool calls, no code execution, no web fetch, no
file operations from model output other than the self-improve file write.

## Safety gate and every side-effecting path

Reviewer gate (`src/reviewer/`): Layer 1 regex classification (safe/caution/
destructive), Layer 2 Groq judge for caution/destructive, fail-closed for destructive,
fail-open for caution. Default ON. With no Groq key, every caution action is allowed
with a logged gap (that is the live state today: `state/reviews/*.jsonl`).

| Side effect | Where | Gated? | Idempotent on re-run? |
|---|---|---|---|
| issue comment (blocked / failed / complete / internal error / PR opened) | `pulse.js` | task-level gate before orchestration | **no** (a killed pulse re-comments) |
| close issue on success | `pulse.js` | same | closing twice is harmless |
| self-improve branch + commit + push + draft PR | `selfImprove.js` | denylist + gate | no (new branch each time) |
| close a self-improve PR on CI failure | `selfImprove.js` | none (benign) | yes |
| `state/` writes | everywhere | scrub + CI scan | n/a |
| weekly digest issue | `weekly-rollup.mjs` | none | dedup by title |
| alert issue | `deadman.yml` | none | dedup by title |
| provider calls | providers | task-level gate | n/a |
| Worker: `PUT` repo secret, `repository_dispatch`, D1 writes | `worker/` | admin token | n/a |
| Worker callbacks from the subagent runner | `run-subagent-task.mjs` | gate before provider call | n/a |

## Security findings (as found; fixed first, see THREAT_MODEL.md)

1. **Intake is open to the world.** `syncIssuesIntoTasks` accepts every open
   `titan-task` issue. The issue template applies that label for any GitHub user. The
   Worker's `mirrorGithubIssues` has the same hole. Result: anyone can spend the
   owner's provider quota and make the bot post comments.
2. **Retry is attacker-triggerable.** Any comment on a finished task's still-open issue
   bumps `updated_at` and re-queues the task.
3. **Self-improve can write into `.git/`.** `normalizePath` strips `..` but not a
   leading `.git/`; a proposed `.git/hooks/post-checkout` is written to disk before
   `git add` fails, and the `finally` branch runs `git checkout` — code execution in
   the job that holds every provider key. Reachable only through a self-improve task
   (needs the `titan-self-improve` label, which a non-collaborator cannot add) plus
   a model that emits that path (prompt injection through the task text).
4. **Workflows**: third-party actions pinned to tags not SHAs; `ci.yml` interpolates
   `github.event.pull_request.base.ref` into a `run:` line; the CI denylist gate is
   red on every human PR touching protected paths, so red CI has become normal.
5. The dashboard "admin gate" is a client-side token check over data that is public
   anyway (`state/` on a public repo); it gates the Worker, not the data. Not a hole,
   but the docs overstate it.
6. `tasks.json` and issue comments carry the full task prompt; redaction is
   pattern-based only. This is documented and by design for a public repo.

## State: storage, writers, growth

| File | Writer(s) | Cap | Churn |
|---|---|---|---|
| `state/tasks.json` | pulse | none (every task ever) | every pulse (`updatedAt`) |
| `state/heartbeat.json` | pulse | 1 record | every pulse |
| `state/pulse-history.json` | pulse | 60 entries | every pulse |
| `state/providers.json` | pulse, selftest | per provider | every pulse (`updatedAt`) |
| `state/agents.json` | pulse | per model | on observation |
| `state/runs/<id>.json` | pulse | 60 files → digest | per task |
| `state/reviews/<day>.jsonl` | gate | 30 files | per gated action |
| `state/digests/*.md` | prune, weekly | none | weekly |

Writes are atomic (temp + rename). No schema validation, no version check beyond the
`version: 1` literal, no backup, no repair path (a corrupt file silently becomes the
default and is overwritten). Concurrent writers are serialized by the workflow
concurrency group; provider-selftest/keepalive commits race the pulse and are handled
by `git pull --rebase` (conflict → skip push). An idle pulse changes 4 files / 13 lines
and produces one commit every 15 minutes (96 commits/day of nothing). Pack size after
50 commits on this rewritten history: 791 KB.

## Logging and the dashboard contract

Logging: JSON lines to stdout/stderr (`lib/logger.js`), visible only in the Actions
log. No persisted event record. The scheduler's in-memory events are discarded.

The static dashboard (`dashboard/`, Next.js export) polls raw.githubusercontent.com:
`heartbeat.json` (20 s), `tasks.json` (20 s), `pulse-history.json` (30 s),
`providers.json` (60 s), `agents.json` (60 s), plus `runs/<id>.json` on demand.
Idle request rate ≈ 10 requests/minute per open tab, no conditional requests, no
backoff. The contract is the TypeScript in `dashboard/lib/types.ts`; there are no
schema files and nothing validates engine output against it. Dashboard write actions
(file / cancel / retry) use the visitor's own fine-grained PAT against the GitHub API;
the page itself carries no credential.

## Workflows: triggers, permissions, concurrency, secrets, injection

| Workflow | Trigger | Permissions | Concurrency | Secrets | Untrusted text → shell |
|---|---|---|---|---|---|
| `titan-pulse.yml` | cron 15 min, dispatch | contents/issues/pull-requests: write | `titan-pulse`, no cancel | all provider keys + GITHUB_TOKEN | none (`task-text` via env) |
| `ci.yml` | push main, PR | contents: read | none | none | `${{ github.event.pull_request.base.ref }}` inside `run:` |
| `pages-deploy.yml` | push main (dashboard/**), daily, dispatch | pages/id-token write | `pages`, cancel | none | none |
| `provider-selftest.yml` | weekly, dispatch | contents: write | own group | all provider keys | none |
| `keepalive.yml` | weekly | contents/issues: write | none | GITHUB_TOKEN | none |
| `deadman.yml` | daily | contents read, issues write | none | GITHUB_TOKEN | none |
| `spawn-subagent.yml` | repository_dispatch | contents: read | per task id | all provider keys + admin token | payload via env (ok); opt-in docker pull pinned by digest |
| `worker-deploy.yml` | push main (worker/**) | contents: read | own group | Cloudflare token | none |

All `uses:` are tag-pinned (`@v4`, `@v5`, `@v7`), not SHA-pinned. No
`pull_request_target`. Fork PRs get `contents: read` and no secrets. The job that holds
provider keys (`pulse`) also runs the self-improve `git` write path; nothing executes
model output as code today.

## Failures, rate limits, timeouts, budgets (as found)

- Provider: `withRetry` 3 attempts, full jitter 300 ms…8 s, Retry-After honored,
  30 s per-call deadline, 4 concurrent per provider; health cooldowns as above.
- Scheduler: 3 attempts per sub-task, 120 s per attempt, `TASK_TIMEOUT` error code.
- Pulse: no in-process time budget; the workflow kills at 10 min and then commits
  nothing. Max 3 tasks / 8 sub-tasks per pulse. No token or call budget. No quota
  tracking (only cooldowns after the fact). No circuit breaker beyond cooldown. No
  loop detection. No dead-letter: a task that fails is `failed` and stays; a dashboard
  retry re-runs it from scratch forever.
- Failure classes: implicit in error codes (`NOT_CONFIGURED`, `NO_PUBLIC_API`,
  `UNAUTHORIZED`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `TASK_TIMEOUT`, `NO_CANDIDATE`,
  `ALL_PROVIDERS_FAILED`, `CANCELLED`); no taxonomy, no per-class policy.

## Capability inventory (Before column)

| Capability | Count (counted from code) |
|---|---|
| Persisted task states | 7 |
| Sub-task states (in memory) | 8 named, 7 reachable |
| Legal-transition enforcement points | 0 |
| Recovery paths | 6 (provider retry, model retry, next-model, decomposer retry+fallback, health skip, dashboard retry) |
| Crash recovery / lease / checkpoint | 0 |
| Tools | 0 |
| Persisted event types | 0 (2 in-memory, discarded) |
| Control actions | 3 (cancel via close, retry via reopen, manual task via dispatch) + disable-workflow in the GitHub UI |
| Audited control actions | 0 |
| Policy engine / autonomy levels | 0 |
| Verification steps after a model says "done" | 0 |
| Schema files for the dashboard contract | 0 |
| Tests | 95 (root), 7 (worker, not run) |
| Providers | 5 + 1 opt-in gateway + 1 unverified pool + 1 disabled pool |
