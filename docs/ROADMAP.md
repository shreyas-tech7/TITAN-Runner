# TITAN-Runner — Blueprint for Improvement (every aspect)

> A broad, creative, and intentionally *safe* plan to make TITAN-Runner better
> in every dimension. It supersedes and generalizes `docs/IMPROVEMENT_PLAN.md`
> (which tracked the first implementation pass). **This document proposes only.
> It changes nothing at runtime.** Every item names the files it would touch,
> why it is non-breaking, and how it would be verified, so it can land in small,
> reversible increments.

---

## 0. North star & non-negotiables

Make TITAN-Runner better at its actual job — *turning a one-line ask into a
working, trustworthy artifact, for free, forever, with no operator* — without
ever regressing the properties that make it what it is:

1. **Free & zero-maintenance.** No server, no bill, no babysitting. A public
   repo + GitHub Actions + free-tier providers only.
2. **Degrades gracefully.** Missing keys, dead providers, flaky networks never
   crash a pulse; they degrade to a smaller, still-useful result.
3. **Public = permanent.** Everything under `state/` and every issue comment is
   world-readable forever. Safety is a design property, not a checklist.
4. **The repo IS the database.** Nothing survives between pulses except what is
   committed. Any new capability must fit that model (or be explicitly an
   external, optional integration).
5. **Loop protection & the leash.** A `GITHUB_TOKEN` push never re-triggers the
   pulse; code changes only ever move through human-reviewed PRs; the denylist
   and Reviewer Gate are load-bearing and must not be weakened.

**Every proposal below obeys three "no-break" rules:**
- Behavior-preserving by default; any change that alters outcomes ships behind
  a flag or a fixture, never silently.
- A change that touches a **denylisted path** (`src/lib/redact.js`,
  `src/lib/secretScrub.js`, `src/reviewer/`, `src/denylist.js`,
  `.github/workflows/`, the secret-scan scripts) is marked **🚩 Guarded** — it
  needs a maintainer to merge directly or to amend the gate, because CI's
  denylist check fails such PRs by design.
- A change to a **workflow file** additionally needs a credential with
  `workflows` permission (the branch's GitHub App token lacks it), also **🚩**.

---

## 1. Current architecture, in one map

```
Issue (titan-task) ──► issueSync.js ──► tasks.json ──► pulse.js
                          │                              │
   dashboard (Next static export, polls raw.githubusercontent + api.github.com)
                                                          ▼
        pulse.js: primeHealth → sync/reconcile → claim (priority/TTL)
            → Reviewer Gate → decompose → Scheduler (router+retry+deadline)
            → synthesize → writeRunRecord → comment/close → prune → heartbeat
                                                          │
        providers: groq/together/openrouter/gemini/huggingface (+opencode, freebuff=no-API)
        agents: AgentAdapter → freebuffAgent / opencodeAgent / phase2Agent
        state: tasks.json, agents.json, providers.json, heartbeat.json,
               pulse-history.json, runs/*.json, digests/*.md, reviews/*.jsonl
        workflows: titan-pulse, provider-selftest, keepalive, deadman, pages-deploy, ci
```

Known, measured baselines: **104/104 tests pass**, a dry-run pulse completes in
~3ms, CI is green, an empty live pulse was ~0.5s and a real one ~1.3s (per
`docs/RUNTIME.md`). Any proposal's "verified" claim should stay true against
these baselines.

---

## 2. Aspect A — Orchestration & reasoning quality

The pipeline today is *decompose → schedule → synthesize*, one pass, no
verification of the result. This is where the largest quality upside lives.

- **A1. Mandatory verification task (P0, S/M).** Append a synthetic "verify"
  task to every graph that receives the merged `synthesis.files` and judges
  them against the original prompt (compile-ness, completeness, contract
  conformance) before the run is marked `complete`. Cheap models can do this.
  *Files:* `src/orchestrator/decomposer.js`, `scheduler.js`, `synthesizer.js`,
  `pulse.js`. *Safe:* a new optional pass; failures degrade to "completed with
  caveats" rather than new hard failures. *Verify:* golden fixtures.
- **A2. Sandboxed execution of generated tests (P0/P1, L).** The pulse runs on a
  disposable Actions VM, which is exactly the right place to *run* the code a
  task produced: extract test files, `npm test`/`pytest`/`go test` them inside
  the run with a hard timeout and no network, and report the result. Turns
  "looks right" into "actually passes." *Safe:* ephemeral VM, network disabled,
  only the repo's own sandbox. *Verify:* dry-run fixture exercises the harness.
- **A3. Ensemble / best-of-N with confidence (P2, M).** For high-`priority`
  tasks, decompose or synthesize twice (two pools) and keep the result that the
  verifier (A1) scores higher. *Safe:* opt-in per task; doubles spend only when
  asked. *Verify:* routing-hint gating.
- **A4. Prompt registry + versioning (P1, S).** Extract every prompt
  (`decomposer.js`, `capabilityRegistry.js`, `reviewer/prompts.js`,
  `AgentAdapter#_buildTaskPrompt`) into `src/prompts/` as data with ids and
  versions, so prompts can be A/B-tested and audited without code edits.
  *Safe:* pure refactor, same strings. *Verify:* byte-identical output diffs.
- **A5. Deterministic replay (P1, S).** Record `modelId` + prompt-hash + seed
  per attempt (attempts already store `modelId`/`tokensUsed`) so a failing run
  can be replayed and diffed locally. *Files:* `src/pulse.js`,
  `state/runs/`. *Safe:* additive fields. *Verify:* replay test.
- **A6. Multi-turn refinement (P3, M).** Let a "refine" pass fix a
  just-below-threshold verify result before giving up, bounded to one extra
  round trip. *Safe:* bounded, opt-in. *Verify:* fixture with a first-pass
  near-miss.

## 3. Aspect B — Routing & provider layer

Routing today is a static seed table + a running success average
(`capabilityRegistry.js`, `router.js`). Good, but improvable.

- **B1. Online bandit routing (P1, M).** Replace the fixed `observedScore`
  weight with a UCB/Thompson-sampling score over the same per-category
  observations, so exploration of under-tried providers is automatic and
  principled. *Files:* `src/orchestrator/router.js`. *Safe:* same inputs, still
  capped by the category-match term; a flag keeps the current scoring.
  *Verify:* `test/router.test.js` + offline bandit convergence test.
- **B2. Speculative dual-execution (P2, M).** For `careful` hints, fire the
  cheapest plausible model in parallel with the preferred one and return
  whichever finishes first with a parseable envelope. *Safe:* hint-gated.
  *Verify:* mock-race test.
- **B3. Provider budget ceilings per pulse (P1, S).** Cap calls + tokens per
  provider per pulse (`TITAN_PROVIDER_MAX_CALLS`, `…_MAX_TOKENS`) so one
  runaway task can't drain a shared free quota for the week. *Files:*
  `src/providers/base.js`, `src/config.js`. *Safe:* ceilings default off.
  *Verify:* unit test on the counter.
- **B4. Streaming + early-abort (P2, M).** Stream chat responses; abort a
  provider the moment the envelope closes, and use time-to-first-token as a
  latency signal in health. *Files:* `src/providers/*.js`,
  `src/providers/health.js`. *Safe:* adapters keep a non-streaming fallback.
  *Verify:* wire-contract test with a chunked fixture.
- **B5. Semantic dedupe/cache (P2, M).** Hash `(prompt, modelId)` and reuse a
  prior identical subtask's output from `state/runs/` (committed cache), so
  re-runs and repeated subtasks are free. *Files:* `src/pulse.js`,
  `src/state/`. *Safe:* content-addressed, opt-in, never crosses tasks with
  different routing hints. *Verify:* cache-hit test.
- **B6. Provider scorecards in the dashboard (P1, S).** Rank providers by
  observed success/latency per aspect using data that already exists
  (`state/agents.json` + `state/providers.json`). *Files:* `dashboard/*`.
  *Safe:* read-only UI. *Verify:* render with fixture data.
- **B7. OpenCode & Freebuff re-confirmation (P1, S).** OpenCode's wire shape is
  still "UNVERIFIED CONTRACT"; Freebuff is intentionally `no_public_api`. Add a
  periodic doc-check note/issue so these are re-verified against current docs
  rather than going stale. *Files:* `scripts/provider-selftest.mjs`, docs.
  *Safe:* documentation + self-test output only.

## 4. Aspect C — Reliability & fault tolerance

- **C1. Idempotent side-effects / outbox (P1, M).** Comments/close are
  best-effort today; make them exactly-once-ish by recording a
  `state/outbox/*.jsonl` entry before posting and marking it done after, so a
  pulse that crashes between "computed" and "commented" never double-posts and
  never loses the comment. *Files:* `src/pulse.js`, `src/state/`.
  *Safe:* additive ledger; the comment itself is unchanged.
  *Verify:* crash-replay test.
- **C2. Dead-letter queue with alert (P1, S).** Tasks that exhaust their retry
  cap (already implemented) should open a `titan-alert`-style issue instead of
  silently sitting `failed`. *Files:* `src/pulse.js`, `scripts/*`.
  *Safe:* new optional issue. *Verify:* fixture.
- **C3. Chaos/perturbation harness (P2, M).** A test mode that injects failures
  (provider timeout, GitHub 500, malformed model output) into the dry-run
  pipeline and asserts the pulse still ends `ok`/degraded. *Files:* `test/`.
  *Safe:* test-only. *Verify:* suite of injected-fault cases.
- **C4. State integrity checksums (P2, S).** Add a `sha256` per state file and
  validate on load; a corrupt `tasks.json` should be quarantined, not silently
  treated as empty (which could cancel everything). *Files:*
  `src/state/io.js`, `src/issueSync.js`. *Safe:* fail-soft on checksum
  mismatch. *Verify:* corruption test.
- **C5. Backpressure & adaptive work (P1, S).** If `providers.json` shows all
  providers cooling down, the pulse should claim fewer (or zero) tasks and say
  so, rather than burning attempts. *Files:* `src/pulse.js`. *Safe:* only
  reduces work. *Verify:* all-providers-exhausted fixture.
- **C6. Graceful-degradation ladder (P1, S).** Today a failed decomposition
  falls back to a single-task graph. Extend the ladder to the end: if *every*
  provider is down, post a prose "could not run — here is why" comment with
  retry guidance instead of a bare failure. *Files:* `src/pulse.js`.
  *Safe:* only changes the failure message. *Verify:* no-provider fixture.

## 5. Aspect D — Security & trust

- **D1. Prompt-injection & output-content screening (P0, S).** Add a
  deterministic Layer-1 check on *incoming task text* (ignore-instructions /
  "disregard previous" / tool-abuse phrasing) and on *outgoing* file paths and
  content (already path-sanitized; add size and NUL/control-char limits). Warn
  rather than hard-block on ambiguous hits. *Files:* `src/reviewer/policy.js`
  **(🚩 guarded — `src/reviewer/` is denylisted)**, or a new non-denylisted
  module `src/lib/promptScreen.js`. *Safe:* default warn-only.
  *Verify:* table-driven tests.
- **D2. Output sandbox (with A2).** Any generated code that is *executed* must
  run network-disabled, timeout-bound, and never touch git or secrets.
  *Files:* workflow step. **🚩** (workflow). *Verify:* a malicious-fixture task
  that tries to exfiltrate is caught.
- **D3. Supply-chain hardening (P1).** Pin actions by commit SHA; add
  dependabot/renovate; run `npm audit` in CI; consider SLSA provenance for the
  dashboard artifact. **🚩** (workflows). *Verify:* green CI after pinning.
- **D4. Secret detection upgrade (P1, S).** Add entropy-based detection
  (base64/hex with high Shannon entropy) and a curated allow-list for
  known-good 40-char SHAs, so the CI secret scan catches more without the
  content-corruption problem (see IMPROVEMENT_PLAN 1.4). **🚩** (touches
  `src/lib/redact.js`/`secretScrub.js`/`scripts/check-secrets-in-state.mjs`).
  *Verify:* corpus of true/false positives.
- **D5. PAT scope check + expiry warnings (P1, S).** On token save, probe
  `GET /repos/{owner}/{repo}` and surface the granted scopes and whether Issues
  write is present. *Files:* `dashboard/lib/githubApi.ts`,
  `SettingsPanel.tsx`. *Safe:* additive UI. *Verify:* manual.
- **D6. Reviewer Gate improvements (P2).** Add: a memory/cost limit on Layer 2
  prompts (already bounded), a per-pulse verdict quota, and an escalation path
  (block-and-file-issue) for repeated near-destructive classifications.
  **🚩** (`src/reviewer/`). *Verify:* `test/reviewer-policy.test.js`.
- **D7. Governance hardening for the repo itself (P1).** Document recommended
  branch-protection rules (require CI, require PR, restrict `main`), add
  `SECURITY.md`, `CODEOWNERS`. *Files:* docs. *Safe:* documentation.
  *Verify:* n/a (settings are manual).

## 6. Aspect E — State, data & retention (repo-as-database evolution)

- **E1. Schema versioning + migrations (P1, M).** `version: 1` exists but
  nothing migrates. Add `state/schema.json` and a small migration runner so
  future field additions never require manual edits. *Files:*
  `src/state/io.js`. *Safe:* additive. *Verify:* migrate-from-v1 test.
- **E2. Bounded `tasks.json` (P1, M).** Terminal tasks currently accumulate
  forever. Archive old terminal tasks into `state/digests/` (like `runs/`
  already is) and cap the live queue file. *Files:* `src/state/prune.js`,
  `src/state/io.js`. *Safe:* keeps the last N, digests the rest (never silent
  loss). *Verify:* prune test.
- **E3. Large-output offload (P2, M).** Post full produced files as a gist or
  Actions artifact and link from the issue/run, keeping `state/runs/` to
  previews. *Files:* `src/pulse.js`, `src/github.js`. *Safe:* opt-in, falls
  back to today's inline behavior. *Verify:* dry-run no-op + manual.
- **E4. Git-history growth plan (P2, S).** State commits grow history forever.
  Document a periodic squash/archive policy (or accept it — commits are cheap)
  and keep an eye on clone size; add a `scripts/state-stats.mjs` reporting
  file counts/sizes per pulse. *Files:* docs, scripts. *Safe:* additive.
  *Verify:* report output.
- **E5. An off-switch for sensitive runs (P2, S).** A `redact:` hint in the
  task YAML that makes the pulse store nothing but a scrub summary, for tasks
  users *know* are sensitive. *Files:* `dashboard/lib/taskYaml.*`,
  `src/lib/taskYaml.js`, `src/pulse.js`. *Safe:* additive hint, default off.
  *Verify:* YAML round-trip test.

## 7. Aspect F — Observability & alerting

- **F1. Structured per-pulse log persisted to state (P1, S).**
  `state/logs/<date>.jsonl` (capped, scrubbed) so a failure is diagnosable from
  the dashboard, not just the Actions UI. *Files:* `src/lib/logger.js`,
  `src/pulse.js`, `src/state/prune.js`. *Safe:* new file, secret scan already
  walks `state/`. *Verify:* dry-run writes it clean.
- **F2. Provider SLO alerts (P1, S).** Extend `check-heartbeat.mjs` to warn when
  a *configured* provider's rolling error rate exceeds a threshold, surfacing
  "your key is probably dead" before a task fails on it. *Files:*
  `scripts/check-heartbeat.mjs`, `src/pulse.js`. *Safe:* additive warning.
  *Verify:* unit test.
- **F3. OpenTelemetry-style traces (P3, L).** Emit span events for
  decompose/schedule/synthesize and persist a flamechart-like summary in the
  run record. *Files:* `src/pulse.js`, `src/orchestrator/*`. *Safe:* additive.
  *Verify:* fixture snapshot.
- **F4. Pulse health scorecard on the dashboard (P2, S).** A single "system
  health" strip combining heartbeat freshness, provider health, and recent
  failure rate — one glance instead of four panels. *Files:* `dashboard/*`.
  *Safe:* read-only aggregation. *Verify:* fixture.

## 8. Aspect G — Testing & quality gates

- **G1. Fuzz the parsers (P0, S).** `outputParser`, `jsonRepair`, `taskYaml`,
  `envelopeParser` consume adversarial model text; fuzz them with a corpus of
  truncated/mangled JSON to prove no input can hang or crash them.
  *Files:* `test/`. *Safe:* test-only. *Verify:* fuzz loop with a timeout.
- **G2. Property-based tests for the graph validator (P1, S).** Random graphs →
  `validateTaskGraph` must always terminate and correctly classify
  cycles/dangling ids. *Files:* `test/decomposer.test.js`. *Verify:* invariants.
- **G3. Golden-run regression corpus (P1, M).** Snapshot real runs into
  `test/fixtures/runs/` and diff decomposition/routing/synthesis against them
  in CI, catching silent refactor regressions. *Files:* `test/`. *Verify:* CI.
- **G4. Coverage gate (P1, S).** `node --test --experimental-test-coverage`
  with a floor (start non-blocking, then enforce). *Files:* `package.json`,
  `ci.yml` **(🚩 workflow)**. *Verify:* CI reports.
- **G5. Lint + typecheck (P1, S).** ESLint flat config (minimal rules) for
  `src/`/`scripts/`; `tsc --noEmit` for `dashboard/`; a `check` script that runs
  all three. *Files:* root + dashboard `package.json`, `ci.yml` **(🚩)**.
  *Verify:* `npm run check` locally + CI.
- **G6. Dashboard unit tests + runtime validation (P1, M).** `vitest` for the
  pure `dashboard/lib/*` modules; hand-rolled validators for every fetched
  JSON shape, with a visible "malformed state" banner instead of a blank page.
  *Files:* `dashboard/lib/*`, `dashboard/app/page.tsx`. *Safe:* additive.
  *Verify:* fixture tests for valid + malformed payloads.

## 9. Aspect H — CI/CD, dependencies & DevX

- **H1. Reproducible installs everywhere (P1, S).** `npm ci` in the one place
  that still uses `npm install` (`pages-deploy.yml`). **🚩** (workflow; also
  blocked on `workflows` permission). *Verify:* next Pages deploy.
- **H2. Dependency & action auto-updates (P1, S).** Renovate/Dependabot config
  so pinned SHAs and lockfiles age safely. **🚩** (workflow). *Verify:* bot PR.
- **H3. Pre-commit & commit hygiene (P2, S).** `husky`/`lint-staged` or a
  plain git-hook script for lint+secret-scan on commit; conventional-commit
  checks. *Files:* root `package.json`. *Safe:* additive, local-only.
  *Verify:* local commit run.
- **H4. Release & changelog automation (P2, S).** `CHANGELOG.md` (Keep a
  Changelog) maintained per PR; optional `release-please`. *Files:* docs.
  *Safe:* process. *Verify:* n/a.
- **H5. CLI (`titan`) (P2, M).** A thin `bin/titan.mjs` that files a task,
  runs a local dry-run, and queries state — the dashboard is great, but a
  terminal UX fits the audience. *Files:* `bin/`, `package.json`.
  *Safe:* additive. *Verify:* CLI smoke test.

## 10. Aspect I — Dashboard & UX

- **I1. Deliverable download (P1, M).** "Download all files" for a run (via
  gist/artifact link from E3) inside the task detail drawer. *Files:*
  `TaskDetailDrawer.tsx`, `src/pulse.js`. *Safe:* additive. *Verify:* manual.
- **I2. File diff/syntax view (P2, M).** Show produced files with syntax
  highlighting and a unified diff against the previous run of the same task.
  *Files:* `dashboard/*`. *Safe:* additive. *Verify:* fixture.
- **I3. Accessibility pass (P1, M).** Focus traps + `aria-live` regions +
  roving tabindex + reduced-motion support across modals/palette/rows.
  *Files:* `dashboard/components/*`. *Safe:* markup/CSS only.
  *Verify:* keyboard walkthrough + `@axe` run.
- **I4. Theming & density (P2, S).** Light theme + compact density toggle
  (respecting `prefers-color-scheme`), without disturbing the current
  graphite/jade signal language. *Files:* `app/globals.css`. *Verify:* visual.
- **I5. Faceted queue (P2, M).** Filter by status/aspect/priority/provider;
  URL-sync the filters (the `?q=`/`?task=` pattern already exists).
  *Files:* `TaskQueueSection.tsx`, `page.tsx`. *Verify:* fixture.
- **I6. Push notifications (P3, M).** Web-push on task completion (PWA already
  installed-friendly); strictly opt-in. *Files:* `sw.js`, new component.
  *Safe:* additive. *Verify:* manual.
- **I7. Bundle/performance budget (P2, S).** Add a size budget and code-split
  the detail drawer/modal; the static export is small but keeping it that way
  should be enforced. *Files:* `next.config.ts`, CI **(🚩)**. *Verify:* build.

## 11. Aspect J — Cost & free-tier sustainability

The "free forever" model is the whole point; protect it.

- **J1. Quota-aware cadence & coalescing (P1, S).** When provider quotas are
  near-exhausted (`exhausted`/`rate_limited` in `providers.json`), batch and
  defer non-urgent tasks to the next pulse instead of retrying into failure.
  *Files:* `src/pulse.js`, `src/providers/health.js`. *Safe:* reduces spend.
  *Verify:* exhausted-provider fixture.
- **J2. Token/cost accounting per run (P1, S).** Sum `tokensUsed` per run into
  the run record and roll up a weekly "free-tier budget consumed" number in the
  digest. *Files:* `src/pulse.js`, `scripts/weekly-rollup.mjs`. *Safe:*
  additive. *Verify:* digest snapshot.
- **J3. Minimum-viable-model routing (P2, S).** For `cheap` hints, prefer the
  smallest model whose observed success rate clears a floor — spend the least
  quota for acceptable quality. *Files:* `src/orchestrator/router.js`.
  *Safe:* hint-gated. *Verify:* router test.
- **J4. Cold-start warmup for HF (P2, S).** The HF 503 `estimated_time` path
  exists; optionally issue a tiny keep-warm probe from the weekly self-test so
  the next pulse isn't the one paying the cold-start tax. *Files:*
  `scripts/provider-selftest.mjs`. *Safe:* self-test only. *Verify:* manual.

## 12. Aspect K — Performance

- **K1. Concurrency tuning (P1, S).** Profile the live pulse; the scheduler is
  already concurrent, but the decomposer/synthesizer/reviewer calls are serial.
  Parallelize the *independent* pre/post steps (e.g., reviewer verdicts for
  multiple tasks). *Files:* `src/pulse.js`. *Safe:* same results, faster.
  *Verify:* timing fixture.
- **K2. Lazy/partial state reads (P2, S).** The dashboard polls whole JSON
  files; add optional per-collection endpoints is impossible on a static host,
  so instead *split* large files (`tasks.json` → `tasks-index.json` + details)
  to shrink poll payloads. *Files:* `src/state/io.js`, `dashboard/*`.
  *Safe:* additive files, fallback intact. *Verify:* size test.
- **K3. Startup cost (P1, S).** `npm ci` on every pulse costs seconds; consider
  an actions cache for `node_modules` (dependency-free, so install is already
  fast — measure first). *Files:* `titan-pulse.yml` **(🚩)**. *Verify:* run
  duration.

## 13. Aspect L — Documentation, community & governance

- **L1. ARCHITECTURE.md + ADRs (P1, S).** A diagram of the pulse lifecycle and
  the state model (mermaid/ASCII), plus an `docs/adr/` for the big calls
  (public-repo-for-free, repo-as-database, two-repo split, denylist).
  *Files:* docs. *Verify:* n/a.
- **L2. CONTRIBUTING.md + SECURITY.md + CODE_OF_CONDUCT.md (P1, S).** The
  zero-network test rule, the denylist/leash, how to run the dashboard, how to
  report a security issue. *Files:* docs. *Verify:* n/a.
- **L3. Task gallery / examples (P2, S).** A curated set of example tasks and
  their outputs so new users see what "good" looks like. *Files:* docs.
  *Verify:* n/a.
- **L4. Public status/health page semantics (P2, S).** The dashboard already
  reads heartbeat; formalize the staleness banner + provider strip as the
  de-facto status page and link it from the README. *Files:* docs, dashboard.
  *Verify:* n/a.

## 14. Aspect M — New capabilities (creative bets)

These are bigger, optional, and never touch the core hot path:

- **M1. Follow-up / continuation tasks (P2, M).** A `titan-continue` label that
  seeds the next run's prompt with the previous run's output, enabling
  multi-pulse projects (build → test → refine) without a server.
- **M2. Notifications (P2, S).** Optional Slack/Discord/webhook notifier on
  completion — a separate workflow, off the critical path, disabled by default.
- **M3. Self-host config (P2, M).** `titan.config.json` for providers, denylist
  extensions, and defaults so forks customize without editing code.
- **M4. Evaluation leaderboard (P3, L).** Publish a public leaderboard of
  provider/category success rates from `state/` — the repo's own telemetry as a
  community asset (and a credibility signal).
- **M5. Agent memory (P3, L).** A committed, capped `state/memory/` of learned
  facts (model strengths, common pitfalls) fed into prompts, so the system
  improves across pulses.
- **M6. Self-healing rollback (P3, L).** When a self-improve PR that a human
  merged is later found to break CI, the dead-man switch files a revert
  proposal (never auto-merges).
- **M7. Plugin/provider framework (P3, L).** A registry-adaptor interface so
  third parties can add providers as separate modules — keeping the core
  dependency-free while the ecosystem extends it.

---

## 15. Prioritization & phased roadmap

| Phase | Focus | Items |
|-------|-------|-------|
| **P0 — Correctness & safety now** | A1, A2, D1, D2, G1, G6, E2, C4 | Verification, sandboxing, fuzzing, queue hygiene. |
| **P1 — Reliability & insight** | A4, B1, B3, C1, C2, C5, C6, E1, E3, F1, F2, G2, G3, G4, G5, H1, I1, I3, J1, J2, K1, K3, L1, L2 | Bandits, outbox, budgets, observability, gates, docs. |
| **P2 — Efficiency & polish** | A3, A5, B2, B4, B5, B7, C3, D6, E4, E5, F4, H3, H4, H5, I2, I4, I5, I7, J3, J4, K2, L3, L4, M1, M2, M3 | Ensemble, streaming, cache, UX, self-host, notifications. |
| **P3 — Bets** | A6, F3, I6, M4, M5, M6, M7 | Refinement, traces, leaderboard, memory, plugins. |

**Risk ordering for "without breaking anything":** P0 items that only *add*
verification/sandboxing and *read* state are safest. Anything marked **🚩** is
routed through a maintainer or a token with `workflows` permission, and is
explicitly excluded from the automated path.

---

## 16. Guardrails & rollback discipline

- **One idea per PR**, always green CI, always reversible. Nothing lands that
  cannot be reverted by reverting one commit.
- **Behavior changes ship behind flags/fixtures** (`TITAN_*` env, routing
  hints, or opt-in YAML fields) and default to today's behavior.
- **Denylisted paths and workflows are never touched by an automated PR.**
  Improvements to secret-handling (`redact.js`/`secretScrub.js`), the Reviewer
  Gate, the denylist, or any workflow are **maintainer-mediated** by design —
  that is a feature of the security model, not a bug to route around.
- **Every claim above is verified** against the same baselines as today:
  `npm test` (104 passing), `npm run pulse:dry` (~3ms), secret scan clean, and
  a green CI run — so any regression is immediately visible.

## 17. Suggested next step

Land the **P0 correctness/safety slice** first — A1 (verification task) + A2
(sandboxed execution) + G1 (parser fuzzing) + E2 (queue pruning) — because it
is the largest quality-per-risk win and none of it touches a denylisted path
or a workflow. Then proceed through P1 in small, individually-shippable PRs.

## 18. Implementation status

This section records what has actually landed (and what is still open) so the
plan and the code never drift. Updated each time an item ships.

**Shipped (all behaviour-preserving / additive, none denylisted):**

- **A1 — verification pass** — `src/orchestrator/verifier.js`; runs post-
  synthesis in live mode only, records `passed|failed|unavailable|skipped`,
  and *never* blocks a task (a failed verdict degrades to "complete with
  caveats", surfaced on the issue and in the run record).
- **D1 — prompt-injection & output-hygiene screening** —
  `src/lib/promptScreen.js`; warn-only, wired into `issueSync.js` (incoming)
  and `pulse.js` (outgoing content), recorded as `screeningWarnings`.
- **G1 — parser fuzzing** — `test/parser-fuzz.test.js`; deterministic,
  dependency-free corpus proving the model-output parsers terminate and stay
  well-shaped.
- **E2 — bounded task queue** — `src/state/prune.js#pruneTasks`; archives the
  oldest `complete`/`cancelled` tasks into a dated digest beyond
  `TITAN_MAX_TERMINAL_TASKS` (default 100). `failed`/`blocked` are never
  archived (their open issues need the id to avoid re-import).
- **C6 — no-provider degradation ladder** — `src/pulse.js`; with zero
  configured providers a live pulse fails tasks with setup guidance instead
  of three doomed attempts each.
- **J2 — per-run token accounting** — run records now carry `tokenUsage`.
- **A5 — deterministic replay fields** — run records now carry `promptHash`
  and `seed` (per-attempt `modelId` already existed).
- **L1/L2/H4 — docs & governance** — `docs/ARCHITECTURE.md`, `docs/adr/0001`,
  `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`.

**Still open (not yet landed):** A2 (sandboxed execution of generated tests —
needs a workflow change, **🚩**), A3–A6, B1–B7, C1–C5, D2–D7 (D2/D3/D4/D6 are
**🚩**), E1, E3–E5, F1–F4, G2–G6 (G4/G5 touch CI **🚩**), H1–H3/H5, I1–I7,
J1/J3/J4, K1–K3 (K3 **🚩**), L3/L4, and M1–M7. These proceed in small,
individually-reversible PRs per §16's guardrails.
