# Daily assistant: progress

If a session restarts, read this file first. Resume at the first open item. Branch: `claude/daily-assistant`. State of the repo before the run: `docs/DAILY_ASSISTANT_STATE.md`.

Legend: `[x]` done and verified. `[~]` partly done. `[ ]` open. `[!]` blocked (reason in the notes).

## Phase 0: recon

- [x] P0 Read the repo, record the baseline, cut the branch, write the state doc.

## Phase 1: close the trust gaps

- [~] RT1 Secret scanning. Done: `.gitleaks.toml`, hook, Issue scan script, history scan clean, tests, docs. Waiting: `gitleaks.yml` is committed on the wf branch (push needs the `workflow` scope).
- [~] RT2 Workflow and Issue hardening. Done: owner-only intake, label and skip, Worker mirror. Waiting on the wf branch: workflow permissions, shared state group, publish script, linter rules.
- [x] RT3 Reviewer Gate coverage for every GitHub write and every VM command (runner gate, Worker gate, VM gate, static boundary test). The workflow `git push` steps move to the gate on the wf branch.
- [x] RT4 Tool argument validation (every bad field named, table tests)
- [x] RT5 Worker auth. Sessions with idle and absolute limits, login limits with backoff, sign-in log, CORS, input limits, public route limits, tests. The dashboard now signs in with a session (`lib/sessionApi.ts`), keeps no admin token, and locks with a notice when the session ends. A real-runtime test found and fixed a first-login failure on a fresh database.
- [x] RT6 VM fleet safety (bare ssh env, URL cleaning, 120 minute cap on script and Worker, claim code hidden). The vm-agent workflow secret list shrinks on the wf branch.
- [~] RT7 State hygiene. Done: strict schemas for every state file, `check-state`, monthly compressed archives (runs, tasks, event summaries, digests, reviews), daily maintenance script, publish script with retry, tests. Waiting on the wf branch: `state-maintenance.yml`, the CI step, and the shared concurrency group.

## Phase 2: shared ops services

- [x] C0 `docs/CONTRACT.md` (word for word, plus a section on the shapes and the added routes)
- [x] RO1 Usage ledger and free quota meter (`/ops/usage`, `/ops/quota`, `quotas.json`)
- [~] RO2 Nightly provider canary. Done: canary core, targets for every catalog provider, Hermes list only, CLI, mirror, Worker route, tests. Waiting on the wf branch: `ops-canary.yml`. Open: first live run.
- [~] RO3 Weekly golden task eval. Done: 15 tasks over 12 categories with deterministic checkers (reference and wrong answers tested), sandboxed code runner (tested under Node 22 and 24), budget, mirror, capability cache and router use, Worker route, tests. Waiting on the wf branch: `ops-eval.yml`. Open: first live run.
- [~] RO4 Post-mortems. Done: signature merge, template and free-model paths, redaction, gitleaks scan, `state/lessons.jsonl`, decomposer reads 5 lessons, pulse sweep, 12 tests incl. a full pulse. Waiting on the wf branch: the gitleaks install step in `titan-pulse.yml`.
- [~] RO5 Host status and alerts. Done: probe library (Space via Hub API, Render cold start = asleep, Hermes 401 = up, SSRF guard, no URL in any result), history and uptime, mirror, alert plan, CLI, quota sync, strict schemas, 25 tests incl. open and close of a host-alert Issue. Waiting on the wf branch: `ops-hosts.yml`. Open: first live run and the host-alert open and close check on GitHub.
- [~] RO6 Doorbell. Done: planner with Chicago guard (one cron of each pair rings on every day of the year, tested), ring with status code only, no body read, no redirect, egress guard, quiet skip, CLI, Worker log route, 19 tests. Waiting on the wf branch: `doorbell.yml`. Open: first live run needs `TITAN_BACKEND_URL` and `DOORBELL_TOKEN`.

## Phase 3: dashboard

- [x] RD1 Panels. Done: the Ops page (`/ops`) with provider health, quota meter, eval scores, host status with uptime bars, lessons, and the Security panel after sign-in. Phone first, four themes, demo data, 25 unit tests, 15 browser tests (axe in 4 themes at 2 sizes, sign-in and expiry against the real Worker). Open: confirm on the live Pages site after the merge.

## Phase 4: verify and ship

- [x] V1 All tests, checks, and the build pass at or above the baseline, plus new tests. Root 666 (baseline 405), worker 303 (baseline 235), dashboard 118 (baseline 93), 15 new browser tests. `check-all` passes on the full tree and on the main-line branch alone (2026-10-12).
- [x] V2 gitleaks 8.30.1 clean on the full history of every branch (1102 commits, 2026-10-12). One late finding was the fake session token of a test fixture. It has an exact value entry in the allowlist.
- [ ] V3 Each new workflow ran once with `workflow_dispatch` and the output was checked
- [ ] V4 Test host alert opened and closed an Issue
- [ ] V5 PR from `claude/daily-assistant` to `main` merged with a merge commit
- [ ] V6 After merge: Pages shows the panels, the mirror files exist, every `/ops` route returns 401 without a token
- [x] V7 README, runtime docs, ops docs, security docs, and config docs updated

## Handoff

- [ ] H1 `docs/handoff/NEXT.md` kept up to date
- [ ] H2 `docs/handoff/cowork-1.md` written and printed
- [ ] H3 Final completion report

## Baseline to beat

| Suite | Count |
|---|---|
| Root tests | 405 |
| Worker tests | 235 |
| Dashboard tests | 93 |

## Decision log

- D1 Gitleaks hits in history are fake test values. No history rewrite. No rotation needed for them.
- D2 `CLAUDE.md` forbids changes to repository settings. Settings changes go to the Cowork handoff, not to the API.
- D3 PR 22 is the owner's draft. This run does not merge it and does not edit `uses:` lines, to avoid conflicts. New workflows use the same pins as `ci.yml`.
- D4 Tests run with `--test-concurrency=2` and `NODE_OPTIONS=--max-old-space-size=3072`.
- D5 The `gh` token has no `workflow` scope. GitHub rejected a push that adds a workflow file (checked 2026-10-11). The fix needs a browser approval, so it goes to the Cowork handoff.
- D6 Two branches. `claude/daily-assistant` holds all code, tests, and docs and is pushed. `claude/daily-assistant-wf` holds only workflow file commits, stays local, and sits on top of the first branch. Workflow files live untracked in `/workspaces/TITAN-Runner/.github/workflows/` while I work. A helper copies them into the worktree `/workspaces/TITAN-Runner-wf` and commits there. After the scope fix, one push sends the wf branch.
- D7 Two pull requests. The first one carries the main-line branch, because it passes on its own. The second one carries the wf branch, after the `workflow` scope is fixed.
- D8 The dashboard e2e stack sets `TITAN_DEV_ORIGINS=1`, because the RT5 CORS lock refuses local origins by default. The deployed Worker never sets it.
