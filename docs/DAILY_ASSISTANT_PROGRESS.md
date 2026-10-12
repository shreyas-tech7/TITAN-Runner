# Daily assistant: progress

If a session restarts, read this file first. Resume at the first open item. Branch: `claude/daily-assistant`. State of the repo before the run: `docs/DAILY_ASSISTANT_STATE.md`.

Legend: `[x]` done and verified. `[~]` partly done. `[ ]` open. `[!]` blocked (reason in the notes).

## Phase 0: recon

- [x] P0 Read the repo, record the baseline, cut the branch, write the state doc.

## Phase 1: close the trust gaps

- [x] RT1 Secret scanning. `.gitleaks.toml` with exact-value fixture entries, a pre-commit hook, `scripts/scan-issues.mjs`, and `gitleaks.yml` (push, pull request, weekly). The workflow ran on GitHub on 2026-10-12: checksum verified, 1151 commits scanned, no leaks. No real key was found, so nothing to rotate.
- [x] RT2 Workflow and Issue hardening. Owner-only intake, least-privilege permissions, one shared state group, one publish script with rebase and retry, linter rules (including the YAML rule that actionlint motivated). The hardened pulse, Pages deploy, and self-test ran on GitHub and passed.
- [x] RT3 Reviewer Gate coverage for every GitHub write and every VM command (runner gate, Worker gate, VM gate, static boundary test). The workflow `git push` steps move to the gate on the wf branch.
- [x] RT4 Tool argument validation (every bad field named, table tests)
- [x] RT5 Worker auth. Sessions with idle and absolute limits, login limits with backoff, sign-in log, CORS, input limits, public route limits, tests. The dashboard now signs in with a session (`lib/sessionApi.ts`), keeps no admin token, and locks with a notice when the session ends. A real-runtime test found and fixed a first-login failure on a fresh database.
- [x] RT6 VM fleet safety (bare ssh env, URL cleaning, 120 minute cap on script and Worker, claim code hidden). The vm-agent workflow secret list shrinks on the wf branch.
- [x] RT7 State hygiene. Strict schemas for every state file (the live pulse state passes `check-state`, 69 files), monthly archives, and a daily maintenance run. `state-maintenance.yml` ran on GitHub and pushed its record.

## Phase 2: shared ops services

- [x] C0 `docs/CONTRACT.md` (word for word, plus a section on the shapes and the added routes)
- [x] RO1 Usage ledger and free quota meter (`/ops/usage`, `/ops/quota`, `quotas.json`)
- [x] RO2 Nightly provider canary. It ran four times on 2026-10-12 and found three real problems (a speech model chosen for Groq, a retired Groq default model, and a free OpenRouter model that only works in agent harnesses). All three are fixed, and the last run shows Groq, OpenRouter, and Gemini healthy. The post to the Worker waits for `OPS_TOKEN`.
- [x] RO3 Weekly golden task eval. It ran on GitHub: 37 calls, two models scored (gemini-2.5-flash 0.67 over 6 tasks, nvidia/nemotron-3.5-lightning:free 0.86 over 14 tasks), `state/ops/eval.json` and the capability cache updated. The post to the Worker waits for `OPS_TOKEN`.
- [x] RO4 Post-mortems. Signature merge, template and free-model paths, redaction, gitleaks scan, `state/lessons.jsonl`, decomposer reads 5 lessons. The pulse installs gitleaks with a checked sum (verified on GitHub).
- [x] RO5 Host status and alerts. It ran on GitHub: the pulse is current, GitHub status is up, and the God's Eye View host on Render shows `asleep`. The alert flow ran live: Issue 32 opened after 2 failed checks and closed when the host was back. Hosts with no address are skipped until Shreyas sets them.
- [x] RO6 Doorbell. All three jobs ran on GitHub and skipped quietly, because `TITAN_BACKEND_URL` and `DOORBELL_TOKEN` are not set yet. The Chicago guard is tested for every day of the year.

## Phase 3: dashboard

- [x] RD1 Panels. Done: the Ops page (`/ops`) with provider health, quota meter, eval scores, host status with uptime bars, lessons, and the Security panel after sign-in. Phone first, four themes, demo data, 25 unit tests, 15 browser tests (axe in 4 themes at 2 sizes, sign-in and expiry against the real Worker). Open: confirm on the live Pages site after the merge.

## Phase 4: verify and ship

- [x] V1 All tests, checks, and the build pass at or above the baseline, plus new tests. Root 666 (baseline 405), worker 303 (baseline 235), dashboard 118 (baseline 93), 15 new browser tests. `check-all` passes on the full tree and on the main-line branch alone (2026-10-12).
- [x] V2 gitleaks 8.30.1 found no leak in the full history of every branch (1102 commits, 2026-10-12). One late hit was the fake session token of a test. It has an exact value entry in the allowlist.
- [x] V3 Each new workflow ran once by hand on GitHub: Secret scan, State maintenance, Host status, Provider canary (4 times), Golden task eval, Doorbell (3 jobs), plus the changed Provider self-test, Weekly keep-alive, Dead-man's switch, TITAN Pulse, Deploy dashboard, and Deploy Worker. All passed. The steps that post to the Worker wait for `OPS_TOKEN`.
- [x] V4 Host alert test. Live check on 2026-10-12. Two failed probes opened Issue 32 with the label `host-alert`. The text held no URL. A third failed probe reused the Issue. A good probe closed it with a comment.
- [x] V5 Pull request 31 merged into `main` with a merge commit (e26c52f, 2026-10-12). The three checks passed first.
- [x] V6 Live checks after the merge, 2026-10-12. The Pages site serves `/ops/` with all six panels. Demo mode at 390 pixels shows no sideways scroll. The four mirror files answer 200. `GET /version` shows e26c52f and schema version 6. Every `/ops` route answers 401 without a token. A wrong token on `/auth/login` answers 401, and the page keeps no session. CORS answers the Pages origin. Another origin gets 403.
- [x] V7 README, runtime docs, ops docs, security docs, and config docs updated

## Open for the owner

- [!] S1 Shreyas sets the secrets (`OPS_TOKEN` in three places, `DOORBELL_TOKEN`, `TITAN_BACKEND_URL`, optional host addresses and Discord). Nobody else can, because the same value must be in TITAN. Then a Claude Code session follows `docs/handoff/after-secrets.md`.

## Handoff

- [x] H1 `docs/handoff/NEXT.md` kept up to date
- [x] H2 `docs/handoff/cowork-1.md` written and printed. Handoff 1 came back. One claim failed the check (the `workflow` scope is not on this Codespace). `docs/handoff/cowork-2.md` gives the exact fix.
- [x] H3 Final completion report in `docs/DAILY_ASSISTANT_REPORT.md`

## Baseline to beat

| Suite | Count |
|---|---|
| Root tests | 405 (now 673) |
| Worker tests | 235 (now 303) |
| Dashboard tests | 93 (now 118) |

## Decision log

- D1 Gitleaks hits in history are fake test values. No history rewrite. No rotation needed for them.
- D2 `CLAUDE.md` forbids changes to repository settings. Settings changes go to the Cowork handoff, not to the API.
- D3 PR 22 is the owner's draft. This run does not merge it and does not edit `uses:` lines, to avoid conflicts. New workflows use the same pins as `ci.yml`.
- D4 Tests run with `--test-concurrency=2` and `NODE_OPTIONS=--max-old-space-size=3072`.
- D5 The `gh` token has no `workflow` scope. GitHub rejected a push that adds a workflow file (checked 2026-10-11). The fix needs a browser approval, so it goes to the Cowork handoff.
- D6 Two branches. `claude/daily-assistant` holds all code, tests, and docs and is pushed. `claude/daily-assistant-wf` holds only workflow file commits, stays local, and sits on top of the first branch. Workflow files live untracked in `/workspaces/TITAN-Runner/.github/workflows/` while I work. A helper copies them into the worktree `/workspaces/TITAN-Runner-wf` and commits there. After the scope fix, one push sends the wf branch.
- D7 Two pull requests. The first one carries the main-line branch, because it passes on its own. The later one carries the wf branch, after the `workflow` scope is fixed.
- D8 The dashboard e2e stack sets `TITAN_DEV_ORIGINS=1`, because the RT5 CORS lock refuses local origins by default. The deployed Worker never sets it.
- D9 actionlint 1.7.7 (checksum checked) found a real bug in the unpushed workflows. A `run:` line held `): ` in a commit message, and YAML fails to parse that. Seven workflows were broken. The wf branch has the fix, and the workflow linter now has a rule for it with tests.
- D10 Cowork reported the `workflow` scope on 2026-10-12. Claude Code checked and found that the stored login has no such scope. A push was refused. Claude Code started its own device login and waited for an approval that did not come in time. Handoff 2 names the Codespace and the exact commands.
- D11 Dependabot pull requests 34 and 35 are identical. Claude Code tested 34 and 36 in scratch worktrees and merged none, as the handoff said.
- D12 The first live canary found a real bug that was already in production. Groq model discovery took `canopylabs/orpheus-v1-english`, a text to speech model, as the chat model. Every Groq call failed with a 400 since 2026-10-11. The filter now knows the speech model names, and a test uses the live list. The weekly self-test picks a chat model on its next run.
- D13 The Groq model list was slow when the self-test ran (503, then a timeout). Discovery could not repair the stored model. `resolveModel` now ignores a stored model that is not a chat model, so the fix does not depend on discovery.
- D14 The canary log text showed two more live problems. Groq answers 404 for the old default model `llama-3.3-70b-versatile`, so the default is now `openai/gpt-oss-20b`. OpenRouter answers 403 "only available on agentic harnesses" for a free model that discovery chose. The canary now calls a 403 that names the model `model_invalid`, not `auth`. The free model choice of OpenRouter stays open (see the completion report).
