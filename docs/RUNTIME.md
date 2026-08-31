# TITAN-Runner runtime

How the pulse works, where state lives, how to add a task, how to read the
dashboard, how to kill a runaway agent, how the 60-day rule is handled, and
the minute-budget math. Companion to the README; read that first for the
one-paragraph version and the security warning.

## Why this exists

The original TITAN backend (the private `shreyas-tech7/TITAN` repo) is an
always-on Express server with a SQLite-backed orchestrator, meant to run on
a desktop, a VM, or a hosted platform like Render — something has to keep
a process running 24/7. This repo is the free-forever alternative: nothing
runs continuously. A GitHub Actions workflow wakes up on a cron, does a
bounded amount of work against a task queue, writes its results to files,
and exits. There is no server to patch, no hosting bill, no process to
babysit.

## The two-repo split, and why

GitHub Actions is free and **unlimited** on public repositories. Private
repos get a 2,000-minutes/month budget (free tier), which a pulse running
every 15 minutes (2,880 pulses/month) would exhaust in days even at a
minute each. So:

- **This repo (`TITAN-Runner`, public)** holds the orchestrator, provider
  adapters, the reviewer gate, the dashboard, and all committed state.
  Zero vault content, zero personal data — see "What was and wasn't ported"
  below.
- **`shreyas-tech7/TITAN` (private)** stays the Obsidian vault and the
  always-on desktop/Render deployment described in its own
  `docs/RUNTIME.md`. Nothing in this repo reads from or writes to that
  repo or its vault. They are independent; use whichever fits a given
  piece of work.

## What was and wasn't ported, and why

Audited before anything crossed the boundary. Ported essentially unchanged
(pure logic, no vault path, no personal data, no hardcoded secret):
`taxonomy.js`, `router.js`, `decomposer.js`, `scheduler.js`,
`synthesizer.js`, `envelopeParser.js`, `outputParser.js`,
`capabilityRegistry.js`, the three agent adapters (`AgentAdapter.js`,
`freebuffAgent.js`, `opencodeAgent.js`), and `utils/redact.js` /
`utils/retry.js` / `utils/jsonRepair.js`. The five free-tier provider
adapters (Groq/Together/OpenRouter/Gemini/HuggingFace) were ported and
trimmed: the original `BaseProvider`'s per-provider circuit breaker, sliding
quota tracker, and 60-second health-check cache were dropped as complexity
a pulse calling each provider a handful of times every 15 minutes does not
need — retry-with-full-jitter and a hard per-call deadline were kept, since
those matter even at low volume. The Reviewer Gate (`policy.js`, the
destructive-action pattern list; `prompts.js`, the model persona) ported
unchanged; `reviewer.js`/`store.js`/`systemState.js` were adapted to write
JSONL under `state/reviews/` instead of a SQLite-adjacent path and to drop
the dashboard SSE event emission this repo has no live process to receive.

Never touched, and never will be: the private repo's vault folders
(`00 Home/` … `99 System/`), `backend/config.js`'s vault/auth/host
resolution, the Gmail/weather/GitHub-PAT integrations, the Express server
and its SQLite database, and the desktop/Windows-specific voice and
active-window features. None of that is orchestration logic — all of it
either reads the vault directly or assumes a co-located, always-on process.

Nothing was **removed** from the private repo. This is a duplication of
the reusable algorithm, not a migration-with-deletion — `shreyas-tech7/TITAN`
still needs its own copy of the orchestrator for its always-on assistant
(the Render/Vercel deployment in that repo's own `docs/RUNTIME.md`). See
that repo's own PR for the documentation-only cross-reference this decision
produced there.

## The pulse

`.github/workflows/titan-pulse.yml`, on `cron: "*/15 * * * *"` (GitHub's
minimum interval is 5 minutes; schedules are best-effort and can slip under
platform load — 15 minutes is frequent enough that a filed task never waits
long, and gives enough slack that an occasional delayed tick is a non-event).
`concurrency: { group: titan-pulse, cancel-in-progress: false }` means a
pulse that is still running when the next one is due queues behind it
rather than running concurrently — two pulses racing the same `state/`
snapshot could each overwrite the other's commit. `timeout-minutes: 10` is
a much tighter ceiling than the platform's own 6-hour hard kill: a pulse
still running after 10 minutes is stuck, not doing more work, and should
fail loudly (the dead-man's-switch workflow is what notices).

One pulse, in order:

1. Check out the repo (`fetch-depth: 0`, so `git diff`/branch operations in
   the self-improve flow have real history to work with).
2. `node src/pulse.js` — see below for what this does.
3. `scripts/check-secrets-in-state.mjs` — re-scans everything under
   `state/` for anything key-shaped before it's allowed to be committed.
4. `git add state/ && git commit && git push` (only if something changed).
   **Pushed with the workflow's own default `GITHUB_TOKEN`, not a personal
   access token** — this is the loop-protection property the task brief
   asked for: a `GITHUB_TOKEN`-authored push does not re-trigger other
   workflows, so the pulse committing its own state can never trigger
   itself again. Do not "fix" this by switching to a PAT.

`src/pulse.js` itself never touches git — it only reads and writes files
under `state/`, which is what makes the local dry-run (`npm run pulse:dry`)
and the test suite exercise the exact same code path CI does, with the git
commit/push left to the workflow shell steps around it.

### What one pulse actually does

1. `ensureStateFiles()` — seed `state/*.json` if this is a fresh checkout.
2. Sync GitHub issues labeled `titan-task` into the task queue
   (`src/issueSync.js`) — skips anything already tracked by issue number.
3. If `workflow_dispatch` supplied a `task-text` input, add it as a
   one-off manual task (not tied to any issue, so nothing to comment on or
   close).
4. Revisit any task awaiting a self-improvement PR's CI result
   (`src/selfImprove.js#checkSelfImprovePrStatus`) — closes the PR and
   marks the task failed if CI concluded failure; marks it complete and
   closes the issue if the PR was merged; otherwise leaves it for the next
   pulse.
5. Claim up to `TITAN_MAX_TASKS_PER_PULSE` (default 3) pending tasks.
6. For each claimed task: run it past the Reviewer Gate, then
   decompose -> schedule -> synthesize across the three agent pools
   (`freebuff`, `opencode`, `phase2` — the last wrapping the five free-tier
   HTTP providers). A `self-improve`-typed task's synthesis result (the
   proposed files) goes to `src/selfImprove.js` instead of an issue
   comment — see "Self-improvement" below.
7. Write a scrubbed run record to `state/runs/<runId>.json`, comment the
   outcome on the originating issue, and close it on success.
8. Persist the capability registry (`state/agents.json`), prune old run
   records (`state/runs/` capped at 60 files — older ones are rolled into
   `state/digests/<date>-rollup.md` and deleted, never silently lost), and
   write `state/heartbeat.json`.

## State — the repo IS the database

A GitHub Actions runner is a clean, stateless VM that is wiped on exit.
Nothing survives between pulses except what got committed. So:

| File / directory | What it holds |
|---|---|
| `state/tasks.json` | The queue: every task ever seen, its status, its issue link, its run id. |
| `state/agents.json` | The capability registry — which model is good at what, plus rolling observed success rate/latency per category. Same file `capabilityRegistry.js` always wrote to; just committed here instead of gitignored. |
| `state/heartbeat.json` | Last pulse time/status/duration, consecutive-failure count, total pulses — what the dead-man's-switch and the dashboard both read. |
| `state/runs/<runId>.json` | One record per completed orchestration run: the task graph, per-subtask assignment/attempts/output preview, the merged file list, the markdown summary. Capped at 60 files. |
| `state/digests/*.md` | Rolled-up summaries of pruned runs, plus the weekly keep-alive commit's own rollup. |
| `state/reviews/*.jsonl` | Reviewer Gate verdicts, one JSONL file per day. |

Every value under `state/` passes through `src/lib/secretScrub.js` before
it's written — a value-only redaction (see below for why it's deliberately
*not* the same function used for log lines).

### Why redaction has two different shapes in this codebase

`src/lib/redact.js`'s `redact()` blanks whole fields by name (`prompt`,
`output`, `content`, …) — correct for a log line, which must never carry
prompt/completion text at all. `state/`'s whole purpose is the opposite: a
task's prompt and a model's output ARE the deliverable this repo exists to
store and post back to the filer. `src/lib/secretScrub.js`'s
`scrubForState()` instead walks every string value and applies only
`redactString()`'s pattern scan (credential-shaped substrings, email
addresses) — content survives, secrets don't. Using `redact()` on state by
mistake was a real bug caught during this build (a task's own prompt came
back as literal `"[REDACTED]"` in `state/tasks.json`) — see the git history
if curious.

## The dashboard

Static Next.js export (`dashboard/`, `output: 'export'`) published to
GitHub Pages by its own workflow, `.github/workflows/pages-deploy.yml` —
deliberately separate from the pulse so a dashboard rebuild never sits on
the critical path of task dispatch (even though Actions minutes are free
either way on this public repo).

**Real-time is gone, replaced honestly.** The private TITAN dashboard's
live orchestrator view holds an SSE connection open against its own
backend process. There is no backend process here to hold that connection
open — a static export has no server behind it at all. `lib/usePolledJson.ts`
polls instead: first `raw.githubusercontent.com/<owner>/<repo>/main/state/*.json`
(always current, works from any origin, with a 4-second timeout so a
stalled connection can't block the fallback), falling back to the
same-origin copy baked into the page at the last build
(`dashboard/scripts/copy-state.mjs`, gitignored — a build artifact, not a
second copy of the source of truth). Default poll interval: 20 seconds for
the queue/heartbeat, 60 seconds for the capability table. This means the
dashboard can lag a live pulse by up to ~20 seconds, and can lag a
dashboard rebuild by up to a day (see the trigger list below) if
`raw.githubusercontent.com` is ever unreachable for a viewer — an honest
trade for "no server," not a hidden limitation.

Shows: current pulse status and last run time (`state/heartbeat.json`),
live task queue with per-task status (`state/tasks.json`), recent run
history, and the capability table (which model handled what, and its
rolling observed success rate — `state/agents.json`). Does **not** show a
"remaining Actions minutes" figure: Actions minutes are unlimited on a
public repository, so there is nothing to budget — see "Minute budget
math" below for the number that matters instead (measured pulse duration).

Rebuild triggers: a push to `main` touching `dashboard/**`, a manual run,
and a daily safety-net rebuild (`cron: "0 6 * * *"`) in case the runtime
polling above is ever unavailable for a viewer. **Deliberately not**
triggered on every pulse's `state/` commit — that would mean a rebuild
every ~15 minutes, which the runtime polling makes unnecessary.

## Task intake

**GitHub Issues are the queue.** File one with the `titan-task` label (the
issue template pre-fills this); the dashboard's "+ New task" button is a
pre-filled `github.com/.../issues/new` link — no token in the browser, no
serverless function, nothing else to maintain. Add the
`titan-self-improve` label to route it to the self-improvement flow
instead of an ordinary answer.

**Or fire one immediately**: Actions tab -> "TITAN Pulse" -> "Run workflow"
-> fill in "Task text". This does not wait for the cron and does not need
an issue at all (the resulting task has no `issueUrl`, so there's nothing
to comment on or close — check `state/tasks.json` or the next pulse's run
record for the result).

## Self-improvement, with a leash

A `titan-self-improve`-labeled task's synthesis result (the files the
model proposed) goes to `src/selfImprove.js` instead of an issue comment:

1. **Denylist check first, before anything else runs.** If any proposed
   path matches `src/denylist.js` (`.github/workflows/`, `src/reviewer/`,
   the secret-handling code, the denylist itself), the proposal is refused
   outright — no branch, no commit, no PR.
2. **Reviewer Gate**, same gate every ordinary task goes through, run
   against the proposed change as a `destructive`-capable action. A block
   ends it here.
3. Only then: create a branch, write the proposed files (**exactly** those
   files — never a broader `git add -A`, so the pulse's own uncommitted
   `state/` changes from earlier in the same run never leak into a code
   PR), commit, push, and open a **draft** PR against `main` via the
   GitHub API.
4. **Never merged automatically, ever.** `.github/workflows/ci.yml` runs
   the full test suite plus the denylist gate (a second, independent check
   — it protects every PR, not just ones that went through step 1) on that
   PR like any other. A later pulse revisits any PR it opened
   (`checkSelfImprovePrStatus`): closes it and records the failure on the
   originating task if CI concluded failure; marks the task complete and
   closes the issue if a human merged it; otherwise leaves it for next
   time. A human always makes the merge decision.

State files and run logs push directly to `main` (step 3 of the pulse,
above). Code never does — this is the one-sentence version of the whole
leash.

## The Reviewer Gate

`src/reviewer/` — unchanged from the original TITAN's design: Layer 1 is a
deterministic pattern match against destructive shell/git/SQL/filesystem
operations (`policy.js`, zero network, zero cost); Layer 2, for anything
not obviously safe, asks a free-tier model (Groq) to judge intent and
returns a verdict with a reason. **Default ON in this repo** (the private
backend defaults it off) — every pulse here writes to a public,
world-readable store, so the safety net stays on unless a maintainer
deliberately disables it (`TITAN_REVIEWER=0`). Fail-closed for a
Layer-1-`destructive` action if Layer 2 can't be reached (blocks rather
than guesses); fail-open for a merely-`caution` one (allows, but the gap is
logged to `state/reviews/`).

## Keeping it alive

GitHub auto-disables a scheduled workflow after **60 days with no commit
activity on the repo at all** — not just on that workflow. Two safety nets:

- `.github/workflows/keepalive.yml`, weekly (`cron: "0 12 * * 1"`): writes
  and commits a real summary of the week's pulses and runs
  (`scripts/weekly-rollup.mjs`) — useful in its own right, not a junk
  empty commit that exists only to reset the 60-day clock. In practice the
  pulse's own state commits (whenever there's a task in the queue) already
  keep the repo active; this is the backstop for a week where the queue
  was genuinely empty.
- `.github/workflows/deadman.yml`, daily: `scripts/check-heartbeat.mjs`
  fails if `state/heartbeat.json`'s `lastPulseAt` is more than 24 hours
  old, or if there have been 8+ consecutive pulse failures. On failure it
  opens (or leaves open, without duplicating) a `titan-alert`-labeled
  issue describing what tripped. This runs on its **own** schedule,
  independent of the pulse — if the pulse's cron silently stopped firing,
  something other than the pulse has to be the one to notice.

## Killing a runaway agent

- **Stop it immediately**: Actions tab -> "TITAN Pulse" -> cancel the
  in-progress run. `concurrency: cancel-in-progress: false` means this
  never races a second pulse — cancelling the current one just lets the
  next scheduled tick start clean.
- **Stop it from running again**: Actions tab -> "TITAN Pulse" -> "..." ->
  "Disable workflow". Nothing else in this repo will re-enable it.
- **A runaway self-improvement PR**: close it by hand on GitHub (or let CI
  fail it — see "Self-improvement" above); it was never going to merge
  itself regardless.
- **A single bad task**: close its GitHub issue directly, or edit
  `state/tasks.json` to remove/mark it and push — the next pulse reads
  whatever is actually committed.
- **Nuclear option**: disable both `titan-pulse.yml` and `keepalive.yml`.
  `deadman.yml` will then (correctly) start filing alert issues once 24
  hours pass with no heartbeat — that is it working as designed, not a
  bug; re-enable the pulse or disable `deadman.yml` too if the silence is
  deliberate.

## Minute-budget math

**Actions minutes are unlimited on a public repository** — this is the
entire reason this repo exists as a second, public repo rather than a new
workflow in the private one. There is no monthly ceiling to budget against,
which is a real simplification from the private repo's Render/Vercel
migration doc (which had to reason carefully about a 2,000-minute private
allotment). What still matters, and what this section reports instead:

- **Measured dry-run duration**: a full pulse (issue-sync skipped in
  dry-run, one manual task claimed, decomposed into 6 subtasks, scheduled
  across the three offline-fixture pools, synthesized) completed in
  **~90-210ms** end to end, measured directly via `npm run pulse:dry` and
  the `pulse-integration.test.js` suite in this session. This proves the
  pipeline's own logic is fast and has no accidental blocking calls; it is
  **not** representative of a real, live pulse.
- **What a real pulse actually costs**: every subtask is a real HTTP round
  trip to a free-tier provider. **This could not be measured in this
  build session** — no provider API keys were available in the sandbox
  this was built in, so every live-mode code path was exercised only via
  its dry-run/offline branch (verified correct, never verified against a
  real upstream). A reasonable estimate: a single free-tier chat
  completion typically returns in 1-5 seconds; a graph of up to 8 subtasks
  (this repo's default `TITAN_MAX_SUBTASKS_PER_RUN`), some running in
  parallel across the three pools, claiming up to 3 tasks per pulse
  (`TITAN_MAX_TASKS_PER_PULSE`), should land well under a minute in the
  common case and comfortably inside the 10-minute job timeout even in a
  slow one. **The first live pulse against real secrets is the actual
  measurement** — check its Actions run duration directly once one exists.
- **Actions itself has per-job/per-workflow limits regardless of plan**: a
  single job is hard-killed at 6 hours (this pulse times out itself at 10
  minutes, well inside that), and the platform's own concurrent-jobs cap
  for a personal account is generous enough that a 15-minute solo cron
  never approaches it.

## Human checkpoints not resolved in this build

- **The GitHub App installation this build session used could not create
  a new repository** (`mcp__github__create_repository` returned
  `403 Resource not accessible by integration`; confirmed via `get_me`/
  `list_repos` that this session's GitHub access is scoped to exactly
  `shreyas-tech7/TITAN`). Everything in this document describes code that
  was built and verified locally — decomposition, scheduling, synthesis,
  the reviewer gate, secret scrubbing, the full test suite, and a real
  `next build` static export, all run for real in this session — but
  nothing here has yet run inside an actual `shreyas-tech7/TITAN-Runner`
  repository, because that repository does not yet exist. See the final
  report for the exact steps to create it and push this code.
- Provider API keys (Groq, Together, HuggingFace, OpenRouter, Gemini,
  Freebuff, OpenCode) — set as repository secrets once the repo exists;
  every provider degrades to `not_configured` without one, never a crash.
- GitHub Pages needs to be enabled once (Settings -> Pages -> Source:
  GitHub Actions) before `pages-deploy.yml`'s first run can publish
  anything.
