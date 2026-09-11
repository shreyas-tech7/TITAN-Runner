# TITAN-Runner — Improvement Plan

> **Status:** Plan only. No code, config, or workflow was changed while producing
> this document. Every item below is a proposal to review and sequence; each
> includes the files it touches, why it is safe, and how it is verified, so it
> can land incrementally without breaking the "free, zero-maintenance, public
> repo" contract this project is built on.

> **Implementation status (first pass):** the highest-severity, lowest-risk
> items from the first milestone have since been implemented — 1.1 (shared task
> prompt builder), 1.2 (deduplicated output parsers), 1.3 (deduplicated
> Retry-After parsing), 1.5 (doc sweep), 2.1 (failure isolation +
> no-cancel-on-sync-error), 2.2 (issue pagination), 2.3 (priority/retry-cap/
> TTL), and 3.1 (issue comments now scrubbed — via the existing full
> `redactString()`, since the precise/content-split variant below needs
> `src/lib/redact.js` + `src/lib/secretScrub.js`, which are denylisted).
>
> **Deferred with a reason:** 1.4 (content-vs-metadata redaction split) is
> blocked by this repo's own security architecture — `src/lib/redact.js` and
> `src/lib/secretScrub.js` are on the denylist (`src/denylist.js`), so any PR
> touching them fails CI's denylist gate by design. It needs a maintainer to
> merge it directly (or to explicitly amend the gate). 2.5 (`npm ci` in
> pages-deploy.yml) needs a push credential with `workflows` permission, which
> the branch's GitHub App token lacks.
>
> The remaining items — supply-chain pinning (3.2), broader reviewer rules
> (3.3), PAT scope hints (3.4), observability (track 4), CI lint/coverage
> gates (track 5), dashboard UX (track 6), and the rest of track 7 — are still
> open and sequenced in §5.

---

## 0. North star

Keep TITAN-Runner's core promise intact — a **free, zero-maintenance,
world-readable GitHub Actions pulse that degrades gracefully** — while making it:

1. **Harder to break silently** (resilience and observability).
2. **More correct** (consistency bugs, duplication, and stale assumptions).
3. **Safer by default** (public store, model-generated content).
4. **Easier to trust and contribute to** (tests, type/lint gates, docs).

The single most important principle for every item: **the pulse must never
fail worse than it fails today.** Any change that could make a run slower,
louder, or less deterministic than the current behavior is either gated behind
a flag, or shipped with a rollback plan.

---

## 1. What is already good (do not regress)

These are the load-bearing properties discovered in review and confirmed by the
test suite. They are non-negotiable constraints for every change below:

- **Zero-network default.** `npm test` and `npm run pulse:dry` run with no
  credentials and no network (`src/lib/net.js` throws on dry-run). 96/96 tests
  pass in ~1.4s.
- **Loop protection.** The pulse pushes with the workflow's own `GITHUB_TOKEN`
  (`titan-pulse.yml`), which does not re-trigger workflows; the same-branch
  `git pull --rebase origin "${GITHUB_REF_NAME}"` before push prevents races
  with provider-selftest/keepalive.
- **Defense in depth on secrets.** `src/lib/redact.js` (value scan + key
  blanking), `src/lib/secretScrub.js` (state-only scrub), and
  `scripts/check-secrets-in-state.mjs` (pre-commit + CI re-scan) are three
  independent layers. A single scrubbed write is not relied on.
- **Layered safety.** Reviewer Gate (deterministic Layer 1 + model Layer 2,
  fail-closed on destructive / fail-open on caution), denylist
  (`src/denylist.js`), CI denylist gate on every PR, and never-auto-merged
  self-improvement PRs.
- **Honest degradation.** Unconfigured providers report `not_configured`,
  Freebuff reports `no_public_api`, a failed provider is cooled down and
  skipped, and the dashboard is explicit about polling and staleness.

---

## 2. Current-state findings (the raw material)

Concrete issues found during review, with file references. These are the
"what's fragile" list the rest of the plan is organized around.

### A. Correctness & consistency

| # | Finding | Location |
|---|---------|----------|
| A1 | `phase2Agent.js` still ships its own local `buildTaskPrompt()` that **omits the `{"files":[…]}` JSON-envelope instruction** every other pool gets via `AgentAdapter._buildTaskPrompt`. Its header note ("no such method exists on the base class") is stale — the method exists now. Net effect: the five-provider pool (the most likely to actually run in production) is never told to emit the files envelope, so its outputs skew freeform/unparseable. | `src/agents/phase2Agent.js` |
| A2 | Two near-duplicate output parsers: `envelopeParser.js` (`parseEnvelope`, `extractFileBlocks`, `normalizePath`, its own balanced-brace + trailing-comma helpers) and `outputParser.js` (`tryStrict`/`tryLenient`/`extractLegacyFileBlocks`/`normalizePath`). `synthesizer.js` re-exports `envelopeParser` only for backward compatibility; the two copies can drift. | `src/orchestrator/envelopeParser.js`, `src/orchestrator/outputParser.js` |
| A3 | Two `Retry-After` parsers do the same job: `parseRetryAfter` in `providers/base.js` and `parseRetryAfterMs` in `lib/retry.js`. | `src/providers/base.js`, `src/lib/retry.js` |
| A4 | **Over-redaction corrupts legitimate model output.** `redactString`'s catch-all patterns (`[A-Za-z0-9+/]{32,}`, `[a-fA-F0-9]{32,}`) run through `scrubForState` on *every* string persisted to `state/` — including task `prompt`, subtask `outputPreview`, and `markdownSummary`. A 40-char git SHA, a SHA-256 digest, or a long base64 constant in generated code gets silently rewritten to `[REDACTED]`, corrupting the deliverable it is supposed to store. | `src/lib/redact.js`, `src/lib/secretScrub.js`, `src/pulse.js` |
| A5 | Stale references to the private repo's layout litter the docs: `services/base.js`, `services/registry.js`, `services/orchestrator/outputParser.js`, `utils/jsonRepair.js`, `utils/redact.js`, `db/index.js`, `store/index.js`, `.titan-store/`, `engine.js`, `__tests__/orchestrator-scheduler.test.js`, and `capabilityRegistry.js`'s claim that the cache "is gitignored" (it is committed as `state/agents.json` here). | several `src/**` headers |
| A6 | `state/tasks.json` keeps **every task ever seen forever** (no pruning of terminal tasks), and the queue is fetched whole on every dashboard poll. Grows without bound. | `src/state/io.js`, `src/issueSync.js`, `dashboard/lib/usePolledJson.ts` |

### B. Resilience

| # | Finding | Location |
|---|---------|----------|
| B1 | **A single GitHub side-effect failure aborts the whole pulse.** `commentOnIssue`/`closeIssue` run after orchestration, outside the per-task try/catch; a network throw propagates to `main()`'s outer catch → `pulseError`, remaining claimed tasks skipped, heartbeat marked `error`. `syncIssuesIntoTasks` failing likewise prevents *any* task processing. | `src/pulse.js`, `src/github.js` |
| B2 | `listOpenTaskIssues` hardcodes `per_page=50` with no pagination — **more than 50 open `titan-task` issues are silently ignored**. | `src/github.js`, `src/issueSync.js` |
| B3 | `priority` is captured (low/normal/high) but **never used** — `claim` is `pending.slice(0, maxTasksPerPulse)`. No FIFO guarantee, no starvation protection, no per-task retry cap, no task TTL. | `src/pulse.js`, `src/issueSync.js`, `src/config.js` |
| B4 | Live HTTP wire formats are only exercised "up to the request". Committed `state/providers.json` already shows a real gap: OpenRouter returned `"no message content"`. No contract test harness exists to catch this kind of drift before it ships. | `src/providers/*.js`, `state/providers.json` |
| B5 | `pages-deploy.yml` uses `npm install` while every other workflow uses `npm ci` (non-reproducible builds). | `.github/workflows/pages-deploy.yml` |

### C. Security

| # | Finding | Location |
|---|---------|----------|
| C1 | **Issue comments are not scrubbed.** `issueCommentFor` posts `markdownSummary` and each file's `content` (up to 3000 chars) **raw** to the public issue — the scrub guarantee currently covers `state/` and commits only. A secret-shaped string in model output reaches the world-readable issue comment untouched. | `src/pulse.js` |
| C2 | Actions are pinned by mutable major tags (`actions/checkout@v4`, etc.) rather than commit SHA; `deadman.yml` is the lone workflow using `actions/github-script` (a runtime-fetched third-party action) when the rest of the repo is deliberately dependency-free. | `.github/workflows/*.yml` |
| C3 | Reviewer Layer 1 (`policy.js`) is a fixed pattern list. It is good but narrow; new destructive shapes (e.g. `chmod -R`, `chown`, `curl | sh`, `git config --global url.insteadOf`, cloud/object-store delete verbs) would currently fall through to Layer 2 only. | `src/reviewer/policy.js` |
| C4 | The dashboard's PAT flow has no scope auto-check; a user can paste an over-scoped token and the only feedback is a generic 401/403. | `dashboard/lib/githubApi.ts`, `dashboard/components/SettingsPanel.tsx` |

### D. Observability & testing

| # | Finding | Location |
|---|---------|----------|
| D1 | No per-pulse structured log is persisted — observability is limited to `heartbeat.json` + `pulse-history.json` + run records. Debugging a failed pulse means opening the Actions UI. | `src/lib/logger.js`, `src/pulse.js` |
| D2 | The Node side has no lint/type gate (JSDoc only), no coverage gate, and no test that touches a real HTTP shape. The dashboard has no unit tests and no runtime validation of fetched JSON (raw `as T` casts). | `test/`, `dashboard/**`, `package.json` |
| D3 | `node --test`'s built-in coverage is unused; there is no regression corpus of real runs. | `package.json`, `test/` |

### E. Dashboard UX

| # | Finding | Location |
|---|---------|----------|
| E1 | A malformed/corrupt `state/*.json` (or a schema drift between pulse and dashboard) silently breaks rendering or shows nothing — no visible error state. | `dashboard/lib/usePolledJson.ts`, `dashboard/app/page.tsx` |
| E2 | No way to download a run's produced files (the original `buildZip` was dropped); files are only inlined in the issue comment, truncated at 3000 chars each. | `src/pulse.js`, `dashboard/components/TaskDetailDrawer.tsx` |
| E3 | Modals/command palette lack focus traps and full keyboard navigation; several interactive rows are `button`s with minimal ARIA. | `dashboard/components/*` |

---

## 3. The plan — seven tracks

Each item lists **Files**, **Why safe**, and **Verification**. Priority tags:
**P0** = correctness/security, land first; **P1** = resilience/quality; **P2** =
nice-to-have / feature bets. Items within a track are ordered.

---

### Track 1 — Correctness & consistency (P0)

**1.1 Unify the task prompt builder (A1).**
Delete `phase2Agent.js`'s local `buildTaskPrompt()` and call
`this._buildTaskPrompt(task, sharedContext)` so the five-provider pool receives
the identical JSON-envelope instruction as `opencode`.
- *Files:* `src/agents/phase2Agent.js`
- *Why safe:* The shared method exists and is already used by `opencodeAgent.js`;
  the local copy only differs by dropping the envelope instructions (and the
  "Shared project context" header). Behavior becomes strictly more consistent.
- *Verify:* extend `test/synthesizer.test.js`/a new `phase2` test asserting
  `_doExecute` sends the envelope instruction; full `npm test`.

**1.2 Collapse the duplicate output parsers (A2).**
Make `outputParser.js` the single implementation and turn `envelopeParser.js`
into thin re-exports (preserving the public names `parseEnvelope`,
`extractFileBlocks`, `normalizePath` that `synthesizer.js` and any test import),
or delete it after confirming no external importers.
- *Files:* `src/orchestrator/envelopeParser.js`, `src/orchestrator/outputParser.js`, `src/orchestrator/synthesizer.js`, `test/*`
- *Why safe:* Both are pure functions with existing tests; merging is a
  refactor with identical outputs. Keep the legacy `// file:` fallback intact.
- *Verify:* existing `envelope-and-output-parser.test.js` stays green; add a
  parity test asserting the two entry points return identical results across a
  corpus of messy outputs.

**1.3 Deduplicate `Retry-After` parsing (A3).**
Have `providers/base.js` import `parseRetryAfterMs` from `lib/retry.js` (or move
the shared helper into `lib/`), removing the private copy.
- *Files:* `src/providers/base.js`, `src/lib/retry.js`
- *Verify:* `test/median.test.js`-style unit tests for both header forms
  (delta-seconds, HTTP-date, negative clamp); `npm test`.

**1.4 Scope the catch-all redaction patterns (A4).** *(highest-priority correctness fix)*
The generic `[A-Za-z0-9+/]{32,}` / `[a-fA-F0-9]{32,}` patterns exist to catch
*unknown issuers' keys in metadata/errors* — they must not run over content
that is itself the deliverable. Proposal:
- Split `redactString` into `redactString` (precise, issuer-prefixed patterns
  only) and `redactMetadata` (precise + catch-alls).
- Use `redactMetadata` for log lines, error fields, provider notes; use the
  precise-only scan inside `scrubForState` for `prompt`, `output`, and file
  `content` values (so a git SHA/base64 constant survives, but a `ghp_…`/`sk-…`/
  `AIza…` key is still caught everywhere).
- Keep `scripts/check-secrets-in-state.mjs` on the full pattern set as the
  backstop (it can afford a few false positives in CI; state content cannot).
- *Files:* `src/lib/redact.js`, `src/lib/secretScrub.js`, `src/pulse.js`, `test/redact.test.js`, `test/state.test.js`
- *Why safe:* Issuer-prefixed patterns (the ones that actually match real
  tokens) are unchanged; only the deliberately-broad catch-alls are scoped.
- *Verify:* new tests asserting (a) `ghp_…`, `sk-…`, `AIza…`, `hf_…` are still
  redacted everywhere, and (b) a 40-hex SHA-1 and a 64-char base64 constant in
  a task's output survive `scrubForState`.

**1.5 Fix stale documentation/comments (A5).**
A doc-only sweep correcting every `services/…`, `utils/…`, `db/index.js`,
`.titan-store/`, `engine.js`, and "gitignored cache" reference to this repo's
real layout. Low risk, but do it as its own commit so it is trivially
reviewable and revertable.
- *Files:* headers across `src/**` (notably `capabilityRegistry.js`,
  `scheduler.js`, `phase2Agent.js`, `synthesizer.js`, `envelopeParser.js`,
  `outputParser.js`)
- *Verify:* grep for `services/`, `utils/`, `.titan-store`, `engine.js` returns
  only intentional historical notes.

---

### Track 2 — Resilience (P0/P1)

**2.1 Isolate failures so one bad side-effect can't sink a pulse (B1).**
Wrap each task's issue `commentOnIssue`/`closeIssue` calls in their own
try/catch (log-and-continue — the run record is already durable), and wrap
`syncIssuesIntoTasks` in its own try/catch so a transient GitHub API error
still lets manual + already-pending tasks run.
- *Files:* `src/pulse.js`, `src/github.js` (optionally make `commentOnIssue`
  never-throwing at the call site)
- *Why safe:* Comment/close are best-effort already (they no-op without a
  token); making them not-throw can only convert today's whole-pulse abort into
  a per-task skip.
- *Verify:* new `test/pulse-integration.test.js` cases injecting a throwing
  `commentOnIssue` and a throwing `listOpenTaskIssues` and asserting the pulse
  still completes remaining tasks and records the failure per task.

**2.2 Paginate issue sync (B2).**
Loop `per_page=100&page=N` until a short page, and log a warning when the open
set exceeds a threshold so "we didn't look" can't be silent.
- *Files:* `src/github.js`, `src/issueSync.js`
- *Verify:* unit test with a mocked paginated response; assert all pages are
  merged and deduplicated by issue number.

**2.3 Put the captured priority (and fairness) to use (B3).**
Claim order = priority desc, then `createdAt` asc (stable FIFO within a
priority). Add: a per-task `retryCount` cap (e.g. 3) so a permanently-failing
task stops being re-claimed; a task `ttlMs` so a task older than N hours is
marked `expired` rather than run stale. Keep defaults identical to today
(max 3 tasks/pulse, all priorities behave the same when unset).
- *Files:* `src/pulse.js`, `src/issueSync.js`, `src/config.js`, `src/lib/taskYaml.js`, `dashboard/lib/types.ts`, `dashboard/lib/statusMeta.ts`
- *Why safe:* Pure ordering + new optional fields with defaults that reproduce
  current behavior.
- *Verify:* new `test/issue-sync.test.js` / pulse tests for ordering, retry-cap,
  and TTL; `npm test`.

**2.4 HTTP contract-test harness for provider adapters (B4).**
Introduce an injectable `fetch` (dependency injection on `guardedFetch`, or a
local `node:http` mock server) and a fixture directory of recorded provider
responses (success + each error class: 401/403/429/5xx/empty-content). Assert
each adapter builds the right URL/headers/body and parses each shape — catching
the "no message content" class of bug offline.
- *Files:* `src/lib/net.js` (DI seam), `test/fixtures/providers/*.json`, new `test/provider-wire.test.js`
- *Why safe:* Adds a test seam; production behavior unchanged (default fetch).
- *Verify:* tests cover all five providers + opencode; `TITAN_DRY_RUN=1` still
  throws (existing guarantee).

**2.5 CI reproducibility (B5).**
Change `pages-deploy.yml`'s `npm install` to `npm ci`.
- *Files:* `.github/workflows/pages-deploy.yml`
- *Verify:* next Pages deploy builds clean.

---

### Track 3 — Security (P0)

**3.1 Scrub issue comments before posting (C1).**
Run `markdownSummary` and each file `content` slice through
`scrubForState`/`redactString` in `issueCommentFor` (same precise+metadata
decision as 1.4), and do the same for the self-improvement PR body preview and
`proposeSelfImprovement`'s written files *only for display*, never altering the
actual proposed file bytes.
- *Files:* `src/pulse.js`, `src/selfImprove.js`, `test/pulse-integration.test.js`
- *Why safe:* Additive redaction on a public sink; does not touch state/commit
  paths.
- *Verify:* test that a model output containing `sk-…`/`ghp_…` is masked in the
  built comment but a normal file path/body passes through.

**3.2 Pin actions by commit SHA + drop `github-script` (C2).**
Pin all `uses:` to full SHAs (with a renovate/dependabot note or a manual
bump cadence), and replace `deadman.yml`'s inline `github-script` with the same
pattern `weekly-rollup.mjs` uses (a dependency-free Node script calling
`src/github.js`).
- *Files:* `.github/workflows/*.yml`, `scripts/` (new `file-deadman-alert.mjs` or extend `check-heartbeat.mjs`)
- *Why safe:* Behavior-preserving; reduces supply-chain surface. The denylist
  already protects `.github/workflows/`, so self-improvement PRs can't touch
  these.
- *Verify:* dispatch `deadman.yml` manually with a faked stale heartbeat (or a
  dry-run flag) and confirm the alert issue still dedupes.

**3.3 Broaden Reviewer Layer 1 (C3).**
Add deterministic patterns for common destructive shapes (privilege/shell
chains, `chmod -R`/`chown -R`, `curl … | sh`, `git config --global …`, object
store bulk deletes) — **only** as additional `destructive` detections, never
changing the fail-open/fail-closed semantics.
- *Files:* `src/reviewer/policy.js`, `test/reviewer-policy.test.js`
- *Verify:* table-driven tests for each new pattern + confirm no existing
  `safe`/`caution` classification regresses.

**3.4 PAT scope hint in Settings (C4).**
After a token is saved, fire an unauthenticated-safe probe (e.g. `GET
/repos/{owner}/{repo}` with the token) and surface the `x-oauth-scopes`/HTTP
status so the user sees whether the token actually has Issues scope before they
file.
- *Files:* `dashboard/lib/githubApi.ts`, `dashboard/components/SettingsPanel.tsx`
- *Verify:* manual dashboard check with an under-scoped token shows the hint.

---

### Track 4 — Observability (P1)

**4.1 Persist a scrubbed per-pulse log (D1).**
Write a small `state/runs/<runId>.log`-style structured event list (or a
`state/logs/<date>.jsonl`, capped like `runs/`) with the same
`scrubForState`/`redactMetadata` discipline — enough to answer "what did this
pulse do and why did it fail" from the dashboard, not just the Actions UI.
- *Files:* `src/lib/logger.js` (a state sink), `src/pulse.js`, `src/state/prune.js`, `dashboard/*`
- *Why safe:* New file under `state/`; the secret-scan script already walks
  everything there.
- *Verify:* dry-run pulse writes the log; `check-secrets-in-state.mjs` stays clean.

**4.2 Richer heartbeat + provider SLO alerts (D1).**
Record per-provider success/error-rate deltas per pulse in `heartbeat.json` (or
a new `state/metrics.json`) and extend `check-heartbeat.mjs` to optionally warn
when a *configured* provider's rolling error rate crosses a threshold.
- *Files:* `src/pulse.js`, `src/state/io.js`, `scripts/check-heartbeat.mjs`
- *Verify:* unit test the threshold logic; existing deadman behavior unchanged
  when no provider is configured.

---

### Track 5 — Testing & CI quality (P1)

**5.1 Coverage gate.**
Enable `node --test --experimental-test-coverage` with a minimum (e.g. 80%
lines on `src/lib`, `src/orchestrator`, `src/providers`) as a non-blocking
first step, then blocking once green.
- *Files:* `package.json`, `.github/workflows/ci.yml`
- *Verify:* CI prints coverage; no test semantics change.

**5.2 Lint + type-check gate (D2).**
Add ESLint (flat config, minimal rules — no stylistic churn) and a
`tsc --noEmit` check for `dashboard/` as explicit CI steps (the Node side keeps
JSDoc; optionally `tsc --checkJs` on `src/**`). Add a `check` script that runs
lint + types + tests.
- *Files:* root `package.json`, `eslint.config.js`, `dashboard/tsconfig.json`, `ci.yml`
- *Why safe:* Additive gates; fix only auto-fixable findings in the first pass.
- *Verify:* `npm run check` locally and in CI.

**5.3 Dashboard runtime validation + tests (E1, D2).**
Add lightweight hand-rolled validators (or `zod`) for `heartbeat`, `tasks`,
`providers`, `pulse-history`, `run` shapes, feeding `usePolledJson`; render an
explicit "state file malformed / schema drift" banner instead of a blank panel.
Add a small `vitest`/`node:test` suite for the pure `dashboard/lib/*` modules
(`taskYaml.ts`, `time.ts`, `statusMeta.ts`, `optimisticTasks.ts`).
- *Files:* `dashboard/lib/validate.ts` (new), `dashboard/lib/usePolledJson.ts`, `dashboard/app/page.tsx`, `dashboard/package.json`
- *Verify:* fixture-driven tests for valid + malformed payloads; manual build.

---

### Track 6 — Dashboard UX (P2)

**6.1 Deliverable download (E2).**
Reintroduce a serverless "download" for a run's files: post the synthesized
files as a **gist** (or attach a zip as an Actions artifact on the run) and
link it from the issue comment + task detail drawer — no server, still free.
- *Files:* `src/pulse.js`, `src/github.js`, `dashboard/components/TaskDetailDrawer.tsx`
- *Why safe:* New optional artifact; falls back to today's inline-comment
  behavior when the API call fails or is unavailable.
- *Verify:* manual run produces a link; dry-run no-ops.

**6.2 Accessibility pass (E3).**
Focus traps + Escape handling for modals/palette, `aria-live` for status
changes, and roving tabindex on queue rows.
- *Files:* `dashboard/components/*`
- *Verify:* manual keyboard walkthrough; no visual regressions.

**6.3 Filters & export (nice-to-have).**
Status/aspect filters in the queue, and a CSV export of `tasks.json` from the
dashboard.
- *Files:* `dashboard/components/TaskQueueSection.tsx`, `dashboard/lib/*`

---

### Track 7 — Documentation & DX (P1)

**7.1 Architecture + data-flow diagram.**
Add `docs/ARCHITECTURE.md` (mermaid or ASCII) showing the pulse lifecycle, the
state-as-database model, the three agent pools, the reviewer gate, and the six
workflows' responsibilities — cross-linked from `README.md` and `RUNTIME.md`.
- *Files:* `docs/ARCHITECTURE.md`, `README.md`, `docs/RUNTIME.md`

**7.2 Contributing + local dev loop.**
A `CONTRIBUTING.md` covering the zero-network test rule, the denylist, the
reviewer gate, and how to run the dashboard locally; plus a root
`npm run dev`-style convenience that copies state and starts the dashboard.
- *Files:* `CONTRIBUTING.md`, `package.json`, `dashboard/package.json`

**7.3 CHANGELOG + release notes.**
Start a `CHANGELOG.md` (Keep a Changelog format) seeded from the existing
git history milestones; update in the PR that lands each track.

---

## 4. Feature bets (creative, explicitly optional)

These are bigger ideas that stay behind flags or separate PRs and never touch
the core pulse hot path:

1. **Evaluation corpus.** Snapshot real runs into `test/fixtures/runs/`; add a
   "golden output" CI job that diffs decomposition/routing/synthesis against
   expectations, catching silent regressions from refactors.
2. **Follow-up tasks.** A `titan-continue` label that feeds the previous run's
   output back as context, enabling multi-step work across pulses without a
   server.
3. **Notifications.** Optional Slack/Discord/webhook notification step on task
   completion (a new workflow, off the critical path, disabled by default).
4. **Provider scorecards.** A dashboard panel ranking providers by observed
   success rate/latency per aspect, driven by `state/agents.json` +
   `state/providers.json` (data already exists).
5. **Self-host configuration file.** A `titan.config.json` for
   providers/denylist/cadence defaults so forks don't edit code to customize.
6. **Dead-letter queue.** Automatically file a `titan-alert` issue for tasks
   that exhaust retries, instead of leaving them silently `failed` in state.

---

## 5. Sequencing (each milestone independently shippable)

| Milestone | Contents | Goal |
|-----------|----------|------|
| **M1 — Correctness & safety** | 1.1, 1.2, 1.3, 1.4, 3.1 | Remove the real correctness/security bugs first; purely additive or output-identical changes. |
| **M2 — Resilience** | 2.1, 2.2, 2.3, 2.5 | The pulse survives partial failures and load; ordering is fair. |
| **M3 — Test & type safety** | 2.4, 5.1, 5.2, 5.3 | Contract tests + gates make M4+ cheap to land. |
| **M4 — Observability** | 4.1, 4.2 | Failure is diagnosable without the Actions UI. |
| **M5 — Security hardening** | 3.2, 3.3, 3.4 | Supply-chain and policy hardening after the observability net exists. |
| **M6 — Docs & polish** | 1.5, 7.x, 6.x | Doc accuracy, UX, and the optional feature bets. |

Each milestone lands as its own PR against `main`; the pulse's own CI (full
test suite + secret scan + denylist gate) is the gate, and every PR is
exercisable locally with `npm run pulse:dry` and `npm test` before merge.

---

## 6. Risks & rollback

- **Over-redaction fix (1.4) is the riskiest change**: it widens what reaches
  `state/`. Mitigation: issuer-prefixed patterns stay in *both* paths, the CI
  secret scan keeps the full pattern set, and the change ships with tests
  proving real tokens still vanish everywhere. Rollback is a one-line revert.
- **Scrubbing issue comments (3.1)** could mask content users expected verbatim.
  Mitigation: only mask credential-*shaped* strings, identical to the existing
  state scrub, and document it in `RUNTIME.md`.
- **Claim-order change (2.3)** could reorder existing queues. Mitigation:
  preserve `createdAt`-asc as the tiebreaker and gate the behavior behind the
  presence of priority values (default = today's behavior).
- **Workflow edits (3.2, 2.5)** are protected by the denylist and CI; any
  workflow change is verified by dispatching it manually on a test branch
  before merging.
- Every track is compatible with the **public, zero-maintenance, free-forever**
  constraint: no new paid services, no server, no state beyond committed files.

---

## 7. Suggested first PR

**M1 only, scoped to the four correctness fixes (1.1, 1.2, 1.3, 1.4) plus the
issue-comment scrub (3.1)** — all additive or output-identical, all covered by
existing + new tests, none touching a workflow. This is the smallest change set
that removes the highest-severity findings (corrupted deliverables, the
unscrubbed public sink, the phase2 envelope gap) with near-zero regression
risk, and it proves out the test-first pattern the rest of the plan builds on.
