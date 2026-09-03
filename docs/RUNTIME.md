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
   itself again. Do not "fix" this by switching to a PAT. The push first
   does `git pull --rebase origin "$GITHUB_REF_NAME"` — rebasing onto
   *this same branch's* remote, never a hardcoded `main` — so a
   provider-selftest or keepalive commit landing in the gap between
   checkout and push doesn't fail the pulse; a genuine same-branch conflict
   aborts the rebase and skips just this pulse's push rather than risking a
   bad merge (found and fixed live while verifying this exact feature —
   see the git history if curious).

`src/pulse.js` itself never touches git — it only reads and writes files
under `state/`, which is what makes the local dry-run (`npm run pulse:dry`)
and the test suite exercise the exact same code path CI does, with the git
commit/push left to the workflow shell steps around it.

### What one pulse actually does

1. `ensureStateFiles()` — seed `state/*.json` if this is a fresh checkout.
   `primeProviderHealth()` also stamps every provider's `configured`/
   `not_configured`/`no_public_api` status in `state/providers.json` before
   anything else runs — see "Provider health, discovery, and the weekly
   self-test" below.
2. Sync GitHub issues labeled `titan-task` into the task queue
   (`src/issueSync.js`) — skips anything already tracked by issue number.
   A dashboard-filed issue carries a `<!-- titan-task-v1 -->` YAML block
   (title/description/priority/routingHint); `src/lib/taskYaml.js` parses
   *only* that block, never the surrounding prose. An issue with no such
   block (the original issue template, or anything filed directly on
   GitHub) falls back to the pre-existing whole-body-as-prompt behavior.
3. `reconcileIssueState()` — the dashboard's Cancel (closes the issue) and
   Retry (reopens it + posts a comment) act on the GitHub issue directly
   from the browser, not on `state/tasks.json` (a static export can't write
   that file itself). This step is what makes those actions actually take
   effect: a still-`pending` task whose issue is no longer open is marked
   `cancelled`; a terminal task (`complete`/`failed`/`blocked`/`cancelled`)
   whose issue is open again *and* was updated (a comment, a reopen) after
   the task's own `completedAt` is reset to `pending` for this same pulse
   (or the next one) to claim fresh.
4. If `workflow_dispatch` supplied a `task-text` input, add it as a
   one-off manual task (not tied to any issue, so nothing to comment on or
   close).
5. Revisit any task awaiting a self-improvement PR's CI result
   (`src/selfImprove.js#checkSelfImprovePrStatus`) — closes the PR and
   marks the task failed if CI concluded failure; marks it complete and
   closes the issue if the PR was merged; otherwise leaves it for the next
   pulse.
6. Claim up to `TITAN_MAX_TASKS_PER_PULSE` (default 3) pending tasks.
7. For each claimed task: run it past the Reviewer Gate, then
   decompose -> schedule -> synthesize across the three agent pools
   (`freebuff`, `opencode`, `phase2` — the last wrapping the five free-tier
   HTTP providers, each skipped by the router while unhealthy — see below).
   A task's `routingHint` (`fast`/`cheap`/`careful`/`any`, from the
   dashboard modal) is copied onto every subtask and nudges — never
   overrides — the router's model choice. A `self-improve`-typed task's
   synthesis result (the proposed files) goes to `src/selfImprove.js`
   instead of an issue comment — see "Self-improvement" below.
8. Write a scrubbed run record to `state/runs/<runId>.json` — now
   including `actionsRunUrl` (this exact Actions run, for the dashboard's
   task detail drawer) and per-attempt `tokensUsed` — comment the outcome
   on the originating issue, and close it on success.
9. Persist the capability registry (`state/agents.json`) and the provider
   health table (`state/providers.json`), prune old run records
   (`state/runs/` capped at 60 files — older ones are rolled into
   `state/digests/<date>-rollup.md` and deleted, never silently lost),
   append this pulse's outcome to `state/pulse-history.json` (capped at 60
   entries — the dashboard's pulse timeline strip), and write
   `state/heartbeat.json`.

## State — the repo IS the database

A GitHub Actions runner is a clean, stateless VM that is wiped on exit.
Nothing survives between pulses except what got committed. So:

| File / directory | What it holds |
|---|---|
| `state/tasks.json` | The queue: every task ever seen, its status, its issue link, its run id, its priority/routingHint if it carried one. |
| `state/agents.json` | The capability registry — which model is good at what, plus rolling observed success rate/latency per category. Same file `capabilityRegistry.js` always wrote to; just committed here instead of gitignored. |
| `state/providers.json` | Live provider health (`src/providers/health.js`) — status (`ok`/`not_configured`/`misconfigured`/`rate_limited`/`exhausted`/`model_invalid`/`no_public_api`/`error`/`unknown`), cooldown, rolling p50 latency/error rate, and the live-discovered model catalog per provider. Updated both by every real call during a pulse and by the weekly self-test. This is what the dashboard's provider health strip and the router's "skip an unhealthy provider" logic both read. |
| `state/heartbeat.json` | Last pulse time/status/duration, consecutive-failure count, total pulses — what the dead-man's-switch and the dashboard both read. |
| `state/pulse-history.json` | The last 60 pulses — time, duration, outcome, tasks claimed/completed/failed. Rolling telemetry for the dashboard's pulse timeline strip; no digest step for entries that age out (state/runs/ is the durable record). |
| `state/runs/<runId>.json` | One record per completed orchestration run: the task graph, per-subtask assignment/attempts (now including `tokensUsed`)/output preview, the merged file list, the markdown summary, and `actionsRunUrl` linking back to the exact Actions run. Capped at 60 files. |
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

**Design**: an "instrument panel" look — deep graphite ground
(`--bg-0: #16181c`), bone-white primary text, exactly one signal color (a
muted jade, `--signal`) reserved for live/healthy state, warm amber
(`--warning`) reserved for warnings, muted rust (`--failure`) reserved for
failure. Two type roles: JetBrains Mono (`--font-mono`, tabular numerals)
for every number/id/timing, Inter Tight (`--font-sans`) for prose and
labels. Hierarchy comes from hairline dividers and vertical rhythm, not
from putting every section in its own equal-weight rounded card — only the
pulse band is a filled block (`.pulse-band` in `app/globals.css`), because
the pulse status is meant to be the loudest thing on the page; every other
section sits flat against the page canvas. Installable as a PWA
(`public/manifest.webmanifest`, `public/sw.js`, `public/icons/`) — the
service worker deliberately never caches anything under `state/` or any
cross-origin request, since staleness protection is this dashboard's whole
point.

**Real-time is gone, replaced honestly.** The private TITAN dashboard's
live orchestrator view holds an SSE connection open against its own
backend process. There is no backend process here to hold that connection
open — a static export has no server behind it at all. `lib/usePolledJson.ts`
polls instead: first `raw.githubusercontent.com/<owner>/<repo>/main/state/*.json`
(always current, works from any origin, cache-busted with a `?t=` query
param on every request, with a 4-second timeout so a stalled connection
can't block the fallback), falling back to the same-origin copy baked into
the page at the last build (`dashboard/scripts/copy-state.mjs`,
gitignored — a build artifact, not a second copy of the source of truth).
Default poll interval: 20 seconds for the queue/heartbeat, 30 seconds for
the pulse timeline, 60 seconds for provider health. A last-fetched
indicator plus a manual refresh button (top right) make this polling
visible rather than a hidden implementation detail. Note:
`raw.githubusercontent.com`'s own CDN can hold a stale response for up to a
minute or so past a push even with cache-busting — observed directly while
verifying this build (a poll a few seconds after a real pulse's push
returned the pre-push content); this is a real characteristic of GitHub's
raw-content CDN, not a bug in the polling code, and it self-corrects on the
next poll cycle.

Shows: current pulse status, an honest next-pulse countdown (with the
caveat that GitHub cron is best-effort and can run late), a pulse timeline
strip (`state/pulse-history.json`, last 60 pulses), a staleness banner if
the newest heartbeat is over 45 minutes old, the live task queue with
per-task status and cancel/retry actions, recent run history, a provider
health strip (`state/providers.json` — replaces the old capability-table
placeholder rows, which showed nothing real), and a read-only list of open
self-improvement PRs. A task row opens a detail drawer: the full task, its
subtask decomposition, which provider/model handled each subtask, latency
and token count per attempt, the final output, and a link to the exact
Actions run. Does **not** show a "remaining Actions minutes" figure:
Actions minutes are unlimited on a public repository, so there is nothing
to budget — see "Minute budget math" below for the number that matters
instead (measured pulse duration).

Rebuild triggers: a push to `main` touching `dashboard/**`, a manual run,
and a daily safety-net rebuild (`cron: "0 6 * * *"`) in case the runtime
polling above is ever unavailable for a viewer. **Deliberately not**
triggered on every pulse's `state/` commit — that would mean a rebuild
every ~15 minutes, which the runtime polling makes unnecessary.

## Task intake

**Two ways to file a task, both landing on the same GitHub Issues queue**
(a `titan-task`-labeled issue), so nothing about how the pulse claims and
runs tasks changed — only how they get created:

1. **The dashboard's "+ New task" modal** (`components/NewTaskModal.tsx`)
   — title, description, priority (low/normal/high), and a routing hint
   (fast/cheap/careful/any). With a token set (see below), it posts
   directly to `api.github.com` and the new task appears immediately,
   marked "queued, waiting for next pulse" (a localStorage-backed
   optimistic entry, reconciled away the moment `state/tasks.json`
   confirms the same issue number — never left misrepresented as
   server-confirmed). With no token set, the modal still fully works: it
   validates the input, shows the exact issue body it would have sent, and
   offers a copy button plus a pre-filled `github.com/.../issues/new` link
   — never a silent redirect. The issue body is a short human-readable
   summary plus a hidden `<!-- titan-task-v1 -->` YAML block
   (`dashboard/lib/taskYaml.ts` / `src/lib/taskYaml.js`, kept in lockstep)
   that the pulse parses — **never** scraped prose. Add the
   `titan-self-improve` label (not offered by the modal; add it by hand on
   GitHub) to route a task to the self-improvement flow instead.
2. **The original GitHub issue template**, or filing directly on GitHub —
   still works exactly as before; an issue with no YAML block falls back
   to the whole body as the task prompt.

**The token**: a GitHub *fine-grained* personal access token, scoped to
this repository only, with **Issues: Read and write** and nothing else.
Pasted once into the dashboard's Settings panel, stored in this browser's
`localStorage` only (namespaced key, never logged, never committed, never
written into any `state/*.json`, never sent anywhere but `api.github.com`).
Shown masked with a "forget token" button that clears it immediately.
Cancel (closes the issue) and Retry (reopens it + posts a comment) on a
task row use the same token and the same never-silent-redirect rule — with
no token, the row simply prompts you to set one.

**Or fire one immediately**: Actions tab -> "TITAN Pulse" -> "Run workflow"
-> fill in "Task text". This does not wait for the cron and does not need
an issue at all (the resulting task has no `issueUrl`, so there's nothing
to comment on or close — check `state/tasks.json` or the next pulse's run
record for the result).

## Provider health, discovery, and the weekly self-test

Every provider's status, live-discovered model catalog, and rolling
latency/error rate live in `state/providers.json`
(`src/providers/health.js`). Two things write to it:

- **Every real call during a pulse.** `providers/base.js` (the five
  registry providers) and `agents/AgentAdapter.js` (OpenCode) record each
  outcome and reclassify status: `ok`, `misconfigured` (401/403 — no
  cooldown, never auto-retried, needs a human to rotate the key),
  `rate_limited`/`exhausted` (429/quota — exponential-backoff cooldown),
  `model_invalid` (404/model-not-found — the cached model id is dropped so
  the next discovery cycle picks a fresh one), or `not_configured`/
  `no_public_api`. `providers/registry.js`'s failover skips any provider
  `isHealthy()` says no to in "auto" routing mode — a dead or exhausted
  provider is never retried into a failed pulse — while an explicit
  routing hint still gets one honest attempt even mid-cooldown.
- **`.github/workflows/provider-selftest.yml`**, manual + weekly
  (`scripts/provider-selftest.mjs`): re-discovers each provider's current
  free-tier model catalog via its real `/models` endpoint
  (`providers/modelDiscovery.js`, `providers/freeFilter.js` — filters to
  what's actually free, never a hardcoded model id), then sends one tiny
  (5-token) completion to every configured provider and records the
  result. This is the only place in the repo that deliberately makes real
  network calls against real upstream APIs; it refuses to run under
  `TITAN_DRY_RUN`.

**Model resolution** (`config.js#resolveModel`): an explicit `*_MODEL` env
var (a human pinned this on purpose) wins; otherwise the model the last
self-test/live call discovered and cached in `state/providers.json`;
otherwise a hardcoded last-resort default. No model id is ever hardcoded
as the *only* option — a churned free-tier id degrades to rediscovery, not
a silent outage.

**Freebuff has no official public API.** Checked directly against current
sources for this build: "Freebuff" (freebuff.com) is a consumer
coding-agent product (CLI/desktop/web) that explicitly needs **no API key
at all** for its own use — the only things online matching an
OpenAI-compatible `/v1/chat/completions` shape for it are unofficial,
likely-ToS-violating reverse-engineering proxies of that consumer
product's session internals. This repo does not depend on those. Its live
path is disabled outright (`agents/freebuffAgent.js` throws a
`NO_PUBLIC_API` error immediately, no network call attempted) and
`state/providers.json` reports it as `no_public_api` — distinct from
"not configured" (a key wouldn't help) and from every failure status
(nothing is actually broken; there was never anything to call).

**A real bug this caught**: `agents/opencodeAgent.js`'s live path used to
send the literal string `"opencode:default"` — an internal
capability-registry placeholder id, not a real model — as the `model`
field in a live API request, which would 404 against the real OpenCode Zen
API. Fixed to resolve it from the cached/discovered model first (see
`#resolveModel()` in that file). A second, more serious bug this caught: a
provider that had a key but had never yet been checked (a fresh
`state/providers.json`, before any self-test or live call) read as
permanently unhealthy — `isHealthy()` requires `configured: true`, and
nothing set that flag until a call succeeded or failed, which nothing
would ever attempt because `isHealthy()` said no first. `pulse.js`'s
`primeProviderHealth()` now stamps `configured: true` (status `unknown`,
healthy) for every provider with a key at the start of each pulse,
specifically to prevent this deadlock. Both were caught by tests written
for this exact scenario, not by inspection — see `test/provider-health.test.js`.

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
- **A single bad task**: use the dashboard row's **Cancel** button (closes
  the issue — `reconcileIssueState()` marks it `cancelled` on the next
  pulse rather than letting it be claimed), or close its GitHub issue
  directly, or edit `state/tasks.json` to remove/mark it and push — the
  next pulse reads whatever is actually committed.
- **Revoke dashboard access without touching the repo at all**: delete the
  fine-grained PAT on GitHub (Settings -> Developer settings -> Personal
  access tokens -> Fine-grained tokens), or just click "Forget token" in
  the dashboard's own Settings panel on the browser that has it. Either
  stops the dashboard from filing/cancelling/retrying anything; it never
  affects the pulse itself, which authenticates as the workflow's own
  `GITHUB_TOKEN`, never the dashboard's PAT.
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
- **What a real pulse actually costs**: measured directly via
  `workflow_dispatch` against a live Actions run
  (`.github/workflows/titan-pulse.yml`, no provider secrets configured on
  this repo yet): an empty-queue pulse completed in **547ms**; a pulse
  that synced a new dashboard-filed issue, ran the Reviewer Gate, decomposed,
  attempted the full provider failover (every registry provider correctly
  reported `not_configured`/skipped), and wrote a run record + comment back
  to the issue completed in **1.2-1.3s**. Total job wall time (checkout +
  `npm ci` + the pulse itself + commit/push) was **13-22 seconds** end to
  end across four dispatched runs. This is still the *no-provider-keys*
  number — once real keys are configured, each subtask pays for a real
  HTTP round trip (a free-tier chat completion typically returns in
  1-5 seconds), so a graph of several subtasks across up to
  `TITAN_MAX_TASKS_PER_PULSE` (default 3) claimed tasks should still land
  well under a minute in the common case and comfortably inside the
  10-minute job timeout even in a slow one — check a real pulse's Actions
  run duration directly once secrets are added for the actual number.
- **Actions itself has per-job/per-workflow limits regardless of plan**: a
  single job is hard-killed at 6 hours (this pulse times out itself at 10
  minutes, well inside that), and the platform's own concurrent-jobs cap
  for a personal account is generous enough that a 15-minute solo cron
  never approaches it.

## Human checkpoints not resolved in this build

- **GitHub Pages is not enabled yet.** Dispatching `pages-deploy.yml` live
  (to verify the redesigned dashboard) failed at the `deploy` job with no
  step logs at all — the signature of a Pages site that has never been
  turned on for this repo. Enable it once: Settings -> Pages -> Build and
  deployment -> Source: **GitHub Actions**. After that, the next push to
  `main` touching `dashboard/**` (or a manual `workflow_dispatch`) will
  publish for real; nothing else about the workflow needs to change.
- **No provider API keys are configured as repository secrets yet** — every
  provider correctly reports `not_configured` in `state/providers.json`
  rather than crashing anything, verified live, but this also means no
  provider's live wire format has actually been exercised against a real
  upstream response in this build (only its offline fixture path, plus the
  live *code path* up to and including the request, confirmed live to
  correctly report `not_configured`/skip rather than error). Add
  `GROQ_API_KEY`/`TOGETHER_API_KEY`/`OPENROUTER_API_KEY`/`GEMINI_API_KEY`/
  `HF_API_KEY`/`OPENCODE_API_KEY` (+ `OPENCODE_BASE_URL` if not the
  default) as repository secrets, then run
  `.github/workflows/provider-selftest.yml` manually — its result in
  `state/providers.json` is the real, first measurement of which
  providers actually work.
- **`provider-selftest.yml` itself could not be dispatched in this build
  session** — GitHub does not let a brand-new workflow file be triggered
  via `workflow_dispatch` until it exists on the default branch (a
  platform limitation, not a bug in the workflow). It will be dispatchable
  immediately once this PR merges.
- The fine-grained PAT for the dashboard's task filing/cancel/retry is a
  per-browser, per-person setup step — see the numbered checklist in the
  final report for the exact scopes.
