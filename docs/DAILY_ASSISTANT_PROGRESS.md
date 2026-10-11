# Daily assistant: progress

If a session restarts, read this file first. Resume at the first open item. Branch: `claude/daily-assistant`. State of the repo before the run: `docs/DAILY_ASSISTANT_STATE.md`.

Legend: `[x]` done and verified. `[~]` partly done. `[ ]` open. `[!]` blocked (reason in the notes).

## Phase 0: recon

- [x] P0 Read the repo, record the baseline, cut the branch, write the state doc.

## Phase 1: close the trust gaps

- [ ] RT1 Secret scanning (gitleaks workflow, `.gitleaks.toml`, pre-commit hook, history scan, Issue and PR scan)
- [ ] RT2 Workflow and Issue hardening
- [ ] RT3 Reviewer Gate coverage for every GitHub write and every VM command
- [ ] RT4 Tool argument validation (every bad field named, table tests)
- [ ] RT5 Worker auth: sessions, rate limits, sign-in log, CORS, input checks, public route fixes
- [ ] RT6 VM fleet safety
- [ ] RT7 State hygiene: schema check, retention, monthly archives, daily commit

## Phase 2: shared ops services

- [ ] C0 `docs/CONTRACT.md` (word for word)
- [ ] RO1 Usage ledger and free quota meter (`/ops/usage`, `/ops/quota`, `quotas.json`)
- [ ] RO2 Nightly provider canary (`/ops/health`, `state/ops/health.json`)
- [ ] RO3 Weekly golden task eval (`/ops/eval`, `state/ops/eval.json`)
- [ ] RO4 Post-mortems (`state/lessons.jsonl`)
- [ ] RO5 Host status and alerts (`/ops/hosts`, `state/ops/hosts.json`, `host-alert` Issues)
- [ ] RO6 Doorbell workflow

## Phase 3: dashboard

- [ ] RD1 Panels: provider health, quota meter, eval scores, host status, lessons, and the Security panel (behind sign-in)

## Phase 4: verify and ship

- [ ] V1 All tests, checks, and the build pass at or above the baseline, plus new tests
- [ ] V2 gitleaks clean on the full history (or every finding listed for rotation)
- [ ] V3 Each new workflow ran once with `workflow_dispatch` and the output was checked
- [ ] V4 Test host alert opened and closed an Issue
- [ ] V5 PR from `claude/daily-assistant` to `main` merged with a merge commit
- [ ] V6 After merge: Pages shows the panels, the mirror files exist, every `/ops` route returns 401 without a token
- [ ] V7 README and runtime docs updated

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
- D5 The `gh` token has no `workflow` scope. If GitHub rejects a push that edits a workflow, workflow commits stay local and the fix goes to the Cowork handoff.
